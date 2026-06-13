/**
 * R2-backed backup run history store (#13) — the runner-side persistence for the
 * host-agnostic {@link HistoryStore} contract in src/history.ts.
 *
 * Runner-only (Node + AWS SDK): like src/runner/r2.ts it writes to R2 from
 * outside Cloudflare via the S3-compatible API. Records are append-only — one
 * small JSON object per run under `{keyPrefix}/_history/{YYYY-MM}/…` — so there
 * is no read-modify-write race on a shared manifest, and "recent history" is a
 * bounded prefix listing of the newest month shards.
 *
 * The S3 calls sit behind {@link HistoryTransport} so the store orchestration is
 * unit-testable with an in-memory fake — no network, no AWS mock.
 */

import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { AcfbakConfig } from "../config.ts";
import {
  buildHistoryKey,
  type HistoryStore,
  type RunRecord,
} from "../history.ts";

/** The three object-store operations the history store needs (injectable). */
export interface HistoryTransport {
  /** Write `body` (UTF-8 JSON) to `bucket/key`. */
  put(bucket: string, key: string, body: string): Promise<void>;
  /** List all object keys under `prefix` (handles pagination). */
  listKeys(bucket: string, prefix: string): Promise<string[]>;
  /** Read an object as a UTF-8 string, or null if it is missing. */
  get(bucket: string, key: string): Promise<string | null>;
}

/** Build the real S3-backed transport from an R2 client (reuses makeR2Client). */
export function s3HistoryTransport(client: S3Client): HistoryTransport {
  return {
    async put(bucket, key, body) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json" }),
      );
    },
    async listKeys(bucket, prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const obj of page.Contents ?? []) {
          if (obj.Key) keys.push(obj.Key);
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    async get(bucket, key) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!res.Body) return null;
      return res.Body.transformToString("utf-8");
    },
  };
}

/** The `_history/` prefix under which all run records live. */
function historyPrefix(config: AcfbakConfig): string {
  return `${config.r2.keyPrefix}/_history/`;
}

/** The newest `count` `YYYY-MM` month shards, newest first, ending at `now`. */
function recentMonthShards(now: Date, count: number): string[] {
  const shards: string[] = [];
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth(); // 0-based
  for (let i = 0; i < count; i++) {
    shards.push(`${year}-${String(month + 1).padStart(2, "0")}`);
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  return shards;
}

/** How many recent month shards `list` will scan before giving up looking further back. */
const MAX_MONTHS_LOOKBACK = 12;

/**
 * An R2-backed {@link HistoryStore}. `append` writes one JSON object per run;
 * `list` scans recent month shards newest-first until it has enough records (or
 * exhausts the lookback window), so a long history never forces a full-bucket
 * listing. `now` is injectable for deterministic tests.
 */
export function r2HistoryStore(
  transport: HistoryTransport,
  config: AcfbakConfig,
  now: () => Date = () => new Date(),
): HistoryStore {
  const bucket = config.r2.bucket;
  return {
    async append(record) {
      await transport.put(bucket, buildHistoryKey(config, record), JSON.stringify(record, null, 2));
    },
    async list(opts) {
      const limit = opts?.limit ?? 20;
      const prefix = historyPrefix(config);
      const shards = recentMonthShards(now(), MAX_MONTHS_LOOKBACK);

      // Gather keys from the newest shards until we have at least `limit`. Keys
      // are timestamp-prefixed, so lexicographic order is chronological.
      const keys: string[] = [];
      for (const shard of shards) {
        const shardKeys = await transport.listKeys(bucket, `${prefix}${shard}/`);
        keys.push(...shardKeys);
        if (keys.length >= limit) break;
      }

      const newest = keys.sort().reverse().slice(0, limit);
      const records = await Promise.all(newest.map((key) => transport.get(bucket, key)));
      return records
        .filter((body): body is string => body !== null)
        .map((body) => JSON.parse(body) as RunRecord);
    },
  };
}

export { S3Client };
