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
  type R2Transport,
} from "./r2.ts";
import {
  requireQueueCredentials,
  QueuePullClient,
  drainQueueOnce,
  QueueError,
} from "./queue.ts";
import type { BackupRunContext } from "../run.ts";

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
 * The core transfer: pull Acquia's latest existing backup for `config`'s
 * app/env (#7) and stream it straight into R2 at `key` (#9) — discover → open
 * download → pipe to R2 (multipart, never fully buffered) → verify size.
 *
 * Because the transfer is fully streaming (the source body flows directly into
 * a multipart upload with no intermediate buffer), peak memory is bounded by
 * the multipart part size regardless of dump size, so a representative
 * production database completes within the runner host's resources. The runner
 * is a plain host process, not subject to the Worker's CPU/time limits.
 *
 * `label` prefixes log lines (e.g. a run id) for correlation.
 */
export async function performTransfer(
  config: AcfbakConfig,
  key: string,
  acquiaCreds: AcquiaCredentials,
  transport: R2Transport,
  label: string,
): Promise<{ key: string; size: number }> {
  const latest = await discoverLatestBackup(config, acquiaCreds);
  const { metadata } = latest;
  console.log(
    `[acfbak runner] ${label} selected Acquia backup id=${metadata.id} type=${metadata.type} ` +
      `started=${metadata.startedAt} completed=${metadata.completedAt} ` +
      `env=${metadata.environmentUuid} db=${metadata.databaseName}`,
  );

  const download = await latest.openDownload();
  if (download.body === null) {
    throw new Error(`${label} Acquia download returned an empty body — nothing to stream to R2.`);
  }

  // fetch's Response.body is a web ReadableStream; Readable.fromWeb adapts it to
  // a Node stream for the AWS SDK without buffering. (Cast bridges the ambient
  // ReadableStream type to node:stream/web's.)
  const body = Readable.fromWeb(download.body as unknown as NodeWebReadableStream<Uint8Array>);

  const result = await streamBackupToR2(
    { bucket: config.r2.bucket, key, body, sourceContentLength: download.contentLength },
    transport,
  );
  console.log(
    `[acfbak runner] ${label} stored r2://${config.r2.bucket}/${result.key} (${result.size} bytes)`,
  );
  return result;
}

/**
 * One-shot transfer entry (`npm run runner`). Pulls the latest backup for the
 * configured app/env and stores it under today's dated key. Use this for a
 * standalone/manual run; the queue-driven path is {@link runConsumer}.
 *
 * This writes the canonical daily (scheduled-style) key on purpose: it's a
 * direct dev/recovery transfer to the standard slot, distinct from the
 * product's on-demand trigger (the Worker's `/trigger`, which keys runs under
 * `on-demand/` — see {@link buildObjectKey}).
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const acquiaCreds = requireAcquiaCredentials();
  const r2Creds = requireR2Credentials();
  const transport = s3Transport(makeR2Client(r2Creds));

  const key = buildObjectKey(config, new Date(), "scheduled");
  await performTransfer(config, key, acquiaCreds, transport, "manual");
}

/** Build an effective config for one run, overriding the source from its context. */
function configForRun(base: AcfbakConfig, context: BackupRunContext): AcfbakConfig {
  return {
    ...base,
    acquia: {
      applicationName: context.application,
      environment: context.environment,
      database: context.database,
    },
  };
}

/**
 * Queue-driven entry (`npm run runner -- --consume`). Drains the handoff queue
 * once: for each leased message it runs the transfer to the message's
 * destination key, then acks successes and marks failures for retry (#27).
 */
export async function runConsumer(): Promise<void> {
  const config = loadConfig();
  const acquiaCreds = requireAcquiaCredentials();
  const r2Creds = requireR2Credentials();
  const queueCreds = requireQueueCredentials();

  const client = new QueuePullClient(queueCreds, fetch);
  const transport = s3Transport(makeR2Client(r2Creds));

  const summary = await drainQueueOnce(client, async (context) => {
    await performTransfer(
      configForRun(config, context),
      context.destinationKey,
      acquiaCreds,
      transport,
      `run ${context.runId} (${context.trigger})`,
    );
  });

  console.log(
    `[acfbak runner] drain complete — pulled=${summary.pulled} ` +
      `acked=${summary.acked} retried=${summary.retried}`,
  );
}

// Run only when invoked directly (`npm run runner`), not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const entry = process.argv.includes("--consume") ? runConsumer : main;
  entry().catch((err: unknown) => {
    // Surface our own typed failures (auth, no-backups, not-found, queue) as a
    // clean, actionable message; anything else prints in full for debugging.
    if (err instanceof AcquiaError || err instanceof QueueError) {
      console.error(`[acfbak runner] failed: ${err.name}: ${err.message}`);
    } else {
      console.error("[acfbak runner] failed:", err);
    }
    process.exit(1);
  });
}
