/**
 * R2 upload — stream the Acquia dump into the destination bucket via R2's
 * S3-compatible API (#9).
 *
 * Runner-only (Node): unlike src/runner/acquia.ts, this module is allowed to
 * depend on node: streams and the AWS SDK, because the byte transfer always
 * runs in the Node runner, never in the Worker (the Worker writes to R2 through
 * its binding; the runner writes from outside Cloudflare with S3 keys).
 *
 * Streaming is load-bearing: multi-GB dumps must never be fully buffered in
 * memory or on disk, so we pipe the source stream straight into a multipart
 * upload (@aws-sdk/lib-storage Upload), counting bytes as they pass and
 * verifying the stored object size afterwards to catch truncation.
 */

import { Transform, type Readable } from "node:stream";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { AcfbakConfig } from "../config.ts";

/** Cloudflare R2 S3-compatible credentials (set as runner env secrets). */
export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Result of a successful backup upload — recorded for the run (AC-05). */
export interface R2UploadResult {
  /** Destination object key the dump was stored under. */
  key: string;
  /** Stored object size in bytes (verified against the streamed byte count). */
  size: number;
}

/** A failed or untrustworthy upload (zero-byte, truncated, size mismatch). */
export class R2UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "R2UploadError";
  }
}

/**
 * Indirection over the two S3 operations we need, so the orchestration in
 * {@link streamBackupToR2} can be unit-tested with in-memory fakes — no network
 * and no AWS SDK mock dependency.
 */
export interface R2Transport {
  /** Stream `body` to `bucket/key`, resolving once the upload is complete. */
  upload(bucket: string, key: string, body: Readable): Promise<void>;
  /** Return the stored object's size in bytes (HeadObject ContentLength). */
  headSize(bucket: string, key: string): Promise<number>;
}

/** R2's S3 API endpoint for an account. */
export function r2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

/**
 * Assert the runner's R2 credentials are present and return them. Fails loud
 * with a clear message, never echoing the values.
 */
export function requireR2Credentials(env: NodeJS.ProcessEnv = process.env): R2Credentials {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const missing = [
    !accountId && "R2_ACCOUNT_ID",
    !accessKeyId && "R2_ACCESS_KEY_ID",
    !secretAccessKey && "R2_SECRET_ACCESS_KEY",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `Missing required R2 secret(s): ${missing.join(", ")}. ` +
        `See .env.example and the README "Secrets" section.`,
    );
  }
  return {
    accountId: accountId as string,
    accessKeyId: accessKeyId as string,
    secretAccessKey: secretAccessKey as string,
  };
}

/** Build an S3 client pointed at R2 (region "auto", account endpoint). */
export function makeR2Client(creds: R2Credentials): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: r2Endpoint(creds.accountId),
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
  });
}

/** Format a Date as a UTC `YYYY-MM-DD` calendar day. */
function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Build the dated object key for a backup (AC-02). Documented convention:
 *   `{keyPrefix}/{environment}/{YYYY-MM-DD}/db.sql.gz`
 * e.g. `acquia/prod/2026-06-04/db.sql.gz`. The day is the UTC calendar day of
 * `date`. Feeds retention (#4) and verification (#5).
 */
export function buildObjectKey(config: AcfbakConfig, date: Date): string {
  return `${config.r2.keyPrefix}/${config.acquia.environment}/${utcDay(date)}/db.sql.gz`;
}

/** A pass-through stream that tallies the bytes flowing through it. */
class CountingTransform extends Transform {
  bytes = 0;
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.bytes += chunk.length;
    callback(null, chunk);
  }
}

/**
 * Verify a completed upload is trustworthy (AC-03): a zero-byte result is a
 * failure, the stored size must equal what we streamed, and — when the source
 * advertised a length — that must match too. Any discrepancy means truncation.
 */
export function assertUploadIntegrity(
  streamedBytes: number,
  storedBytes: number,
  sourceContentLength: number | null,
): void {
  if (storedBytes === 0 || streamedBytes === 0) {
    throw new R2UploadError(
      `Backup upload produced a zero-byte object (streamed ${streamedBytes}, stored ${storedBytes}).`,
    );
  }
  if (streamedBytes !== storedBytes) {
    throw new R2UploadError(
      `Backup size mismatch: streamed ${streamedBytes} bytes but stored object is ${storedBytes} — possible truncation.`,
    );
  }
  if (sourceContentLength !== null && sourceContentLength !== streamedBytes) {
    throw new R2UploadError(
      `Backup size mismatch: source advertised ${sourceContentLength} bytes but ${streamedBytes} were streamed — possible truncation.`,
    );
  }
}

/** Build the real S3-backed transport from an R2 client. */
export function s3Transport(client: S3Client): R2Transport {
  return {
    async upload(bucket, key, body) {
      const upload = new Upload({
        client,
        params: { Bucket: bucket, Key: key, Body: body, ContentType: "application/gzip" },
      });
      await upload.done();
    },
    async headSize(bucket, key) {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return head.ContentLength ?? 0;
    },
  };
}

export interface StreamBackupParams {
  bucket: string;
  key: string;
  /** The source byte stream (the runner converts the web stream to a Readable). */
  body: Readable;
  /** Expected size from the source, if it advertised one; else null. */
  sourceContentLength: number | null;
}

/**
 * Stream a backup to R2 and verify it landed intact, returning the destination
 * key and verified object size (AC-05). The source bytes are piped straight
 * into the upload — never buffered in full (AC-01) — while being counted, then
 * the stored size is fetched and checked (AC-03).
 *
 * `transport` is injectable for testing; production passes {@link s3Transport}.
 */
export async function streamBackupToR2(
  params: StreamBackupParams,
  transport: R2Transport,
): Promise<R2UploadResult> {
  const counter = new CountingTransform();
  // pipe() does not forward source errors, so bridge them explicitly: a failed
  // download must abort the upload rather than silently complete short.
  params.body.on("error", (err) => counter.destroy(err));
  params.body.pipe(counter);

  await transport.upload(params.bucket, params.key, counter);
  const storedBytes = await transport.headSize(params.bucket, params.key);
  assertUploadIntegrity(counter.bytes, storedBytes, params.sourceContentLength);

  return { key: params.key, size: storedBytes };
}
