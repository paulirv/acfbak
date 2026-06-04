/**
 * acfbak runner — transfer process.
 *
 * Role (per docs/vision.md "Worker orchestrates, runner transfers"):
 *   - performs the heavy byte transfer that the Worker is too constrained for
 *   - pulls Acquia's most recent existing backup for the configured app/env
 *   - streams that dump into the configured R2 bucket (S3-compatible API)
 *
 * Where this runs (GitHub Actions vs. container) is an open question in the
 * vision; the runner reads everything it needs from the declarative config +
 * environment secrets, so it is host-agnostic.
 *
 * Secrets (never committed — see .env.example / README):
 *   ACQUIA_API_KEY, ACQUIA_API_SECRET        — pull the dump from Acquia Cloud
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
 *   R2_SECRET_ACCESS_KEY                      — write the dump to R2 via S3 API
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { validateConfig, type AcfbakConfig } from "../config.ts";
import { discoverLatestBackup, AcquiaError, type AcquiaCredentials } from "./acquia.ts";
import {
  requireR2Credentials,
  makeR2Client,
  s3Transport,
  buildObjectKey,
  streamBackupToR2,
} from "./r2.ts";

/** Load and validate acfbak.config.json from the repo root. */
export function loadConfig(configPath?: string): AcfbakConfig {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = configPath ?? resolve(here, "../../acfbak.config.json");
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return validateConfig(raw);
}

/**
 * Assert the Acquia credentials are present and return them as the
 * {@link AcquiaCredentials} the client expects. The Acquia pull (this step,
 * #7) needs only these; the R2 secrets are required when the dump is streamed
 * to R2 (#9). Fails loud with a clear message, never echoing the values.
 */
export function requireAcquiaCredentials(
  env: NodeJS.ProcessEnv = process.env,
): AcquiaCredentials {
  const key = env.ACQUIA_API_KEY;
  const secret = env.ACQUIA_API_SECRET;
  if (!key || !secret) {
    const missing = [!key && "ACQUIA_API_KEY", !secret && "ACQUIA_API_SECRET"].filter(Boolean);
    throw new Error(
      `Missing required Acquia secret(s): ${missing.join(", ")}. ` +
        `See .env.example and the README "Secrets" section.`,
    );
  }
  return { key, secret };
}

/**
 * Entry point. Pulls Acquia's latest existing backup for the configured
 * app/env (#7) and streams it straight into R2 under a dated key (#9):
 *   discover latest backup → open its download → pipe to R2 (multipart,
 *   never fully buffered) → verify the stored size → record key + size.
 *
 * Because the transfer is fully streaming (the source response body flows
 * directly into a multipart upload with no intermediate buffer on disk or in
 * memory), peak memory is bounded by the multipart part size regardless of
 * dump size — so a representative production database completes within the
 * runner host's resources (AC-04). The runner is a plain host process, so it
 * is not subject to the Worker's CPU/time limits.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const acquiaCreds = requireAcquiaCredentials();
  const r2Creds = requireR2Credentials();

  const latest = await discoverLatestBackup(config, acquiaCreds);
  const { metadata } = latest;

  // Record the source backup's metadata for the run.
  console.log(
    `[acfbak runner] selected Acquia backup id=${metadata.id} type=${metadata.type} ` +
      `started=${metadata.startedAt} completed=${metadata.completedAt} ` +
      `env=${metadata.environmentUuid} db=${metadata.databaseName}`,
  );

  // Open the download (AC-03 from #7) and stream it directly into R2 (AC-01).
  const download = await latest.openDownload();
  if (download.body === null) {
    throw new Error("Acquia download returned an empty body — nothing to stream to R2.");
  }

  const key = buildObjectKey(config, new Date());
  // fetch's Response.body is a web ReadableStream; Readable.fromWeb adapts it to
  // a Node stream for the AWS SDK without buffering. (Cast bridges the ambient
  // ReadableStream type to node:stream/web's.)
  const body = Readable.fromWeb(download.body as unknown as NodeWebReadableStream<Uint8Array>);

  const transport = s3Transport(makeR2Client(r2Creds));
  const result = await streamBackupToR2(
    { bucket: config.r2.bucket, key, body, sourceContentLength: download.contentLength },
    transport,
  );

  // Record the destination key and verified object size for the run (AC-05).
  console.log(
    `[acfbak runner] stored r2://${config.r2.bucket}/${result.key} (${result.size} bytes)`,
  );
}

// Run only when invoked directly (`npm run runner`), not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err: unknown) => {
    // Surface our own typed failures (auth, no-backups, not-found) as a clean,
    // actionable message; anything else prints in full for debugging (AC-04).
    if (err instanceof AcquiaError) {
      console.error(`[acfbak runner] failed: ${err.name}: ${err.message}`);
    } else {
      console.error("[acfbak runner] failed:", err);
    }
    process.exit(1);
  });
}
