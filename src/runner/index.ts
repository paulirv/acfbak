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
import { buildRunContext, type BackupRunContext } from "../run.ts";
import { resolveNotifier, type Notifier, type TransferStage } from "../notify.ts";
import {
  successRecord,
  failureRecord,
  type HistoryStore,
  type RunRecord,
} from "../history.ts";
import { randomUUID } from "node:crypto";

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
 * A transfer failure tagged with the pipeline stage it failed at (#12), so the
 * per-run failure notification can name where it broke. The message is the
 * underlying cause's message (never secret material); the original error is kept
 * on `cause` for full debugging.
 */
export class TransferError extends Error {
  constructor(
    readonly stage: TransferStage,
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "TransferError";
  }
}

/** What a completed transfer reports back: the stored object + its source. */
export interface TransferResult {
  /** R2 destination object key the dump was stored under. */
  key: string;
  /** Verified stored object size in bytes. */
  size: number;
  /** Acquia source backup id the dump came from (#13). */
  sourceBackupId: number;
}

/** The terminal-outcome observers a run reports to (#12 notifier, #13 history). */
export interface RunObservers {
  notifier: Notifier;
  /** Optional run-history store; when present, each run appends one record. */
  history?: HistoryStore;
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
 * `label` prefixes log lines (e.g. a run id) for correlation. Any failure is
 * rethrown as a {@link TransferError} tagged with the stage that broke, so the
 * caller's notification (#12) can report it.
 */
export async function performTransfer(
  config: AcfbakConfig,
  key: string,
  acquiaCreds: AcquiaCredentials,
  transport: R2Transport,
  label: string,
): Promise<TransferResult> {
  let stage: TransferStage = "discover";
  try {
    const latest = await discoverLatestBackup(config, acquiaCreds);
    const { metadata } = latest;
    console.log(
      `[acfbak runner] ${label} selected Acquia backup id=${metadata.id} type=${metadata.type} ` +
        `started=${metadata.startedAt} completed=${metadata.completedAt} ` +
        `env=${metadata.environmentUuid} db=${metadata.databaseName}`,
    );

    stage = "download";
    const download = await latest.openDownload();
    if (download.body === null) {
      throw new Error(`${label} Acquia download returned an empty body — nothing to stream to R2.`);
    }

    // fetch's Response.body is a web ReadableStream; Readable.fromWeb adapts it to
    // a Node stream for the AWS SDK without buffering. (Cast bridges the ambient
    // ReadableStream type to node:stream/web's.)
    const body = Readable.fromWeb(download.body as unknown as NodeWebReadableStream<Uint8Array>);

    stage = "transfer";
    const result = await streamBackupToR2(
      { bucket: config.r2.bucket, key, body, sourceContentLength: download.contentLength },
      transport,
    );
    console.log(
      `[acfbak runner] ${label} stored r2://${config.r2.bucket}/${result.key} (${result.size} bytes)`,
    );
    // Surface the Acquia source backup id alongside the upload result so the
    // run-history record (#13) can trace the artifact back to its source.
    return { ...result, sourceBackupId: metadata.id };
  } catch (err) {
    throw err instanceof TransferError ? err : new TransferError(stage, err);
  }
}

/**
 * Run one transfer and report its single terminal outcome to every observer:
 * the notifier (#12) and, when present, the history store (#13). On success it
 * emits a success notification (key + verified size + timestamp) and appends a
 * success record (also carrying duration + source backup id); on failure it
 * emits a failure notification (run id + failing stage + error + timestamp) and
 * appends a failure record, then rethrows the original error so the queue
 * consumer still marks the message for retry — observers watch the outcome, they
 * do not absorb it.
 *
 * History writes are best-effort: an append failure is logged but never flips
 * the run's real outcome (a successful backup stays successful; a failed one
 * still rethrows). `now` is injectable for deterministic tests.
 */
export async function observeRun(
  observers: RunObservers,
  context: BackupRunContext,
  perform: () => Promise<TransferResult>,
  now: () => Date = () => new Date(),
): Promise<TransferResult> {
  const startedAt = now();
  const labelPart = context.label ? { label: context.label } : {};
  try {
    const result = await perform();
    const finishedAt = now();
    await observers.notifier.notify({
      outcome: "success",
      runId: context.runId,
      trigger: context.trigger,
      ...labelPart,
      destinationKey: result.key,
      size: result.size,
      timestamp: finishedAt.toISOString(),
    });
    await appendRecord(observers.history, context.runId, () =>
      successRecord(
        {
          runId: context.runId,
          trigger: context.trigger,
          ...labelPart,
          destinationKey: result.key,
          timestamp: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
        },
        { sizeBytes: result.size, sourceBackupId: result.sourceBackupId },
      ),
    );
    return result;
  } catch (err) {
    const finishedAt = now();
    const stage = err instanceof TransferError ? err.stage : "unknown";
    const error = err instanceof Error ? err.message : String(err);
    await observers.notifier.notify({
      outcome: "failure",
      runId: context.runId,
      trigger: context.trigger,
      ...labelPart,
      stage,
      error,
      timestamp: finishedAt.toISOString(),
    });
    await appendRecord(observers.history, context.runId, () =>
      failureRecord(
        {
          runId: context.runId,
          trigger: context.trigger,
          ...labelPart,
          destinationKey: context.destinationKey,
          timestamp: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
        },
        { stage, error },
      ),
    );
    throw err;
  }
}

/** Append one history record, best-effort: a store failure is logged, not thrown. */
async function appendRecord(
  history: HistoryStore | undefined,
  runId: string,
  build: () => RunRecord,
): Promise<void> {
  if (!history) return;
  try {
    await history.append(build());
  } catch (err) {
    console.error(
      `[acfbak runner] run ${runId}: failed to append history record: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
  // Resolve the notifier up front so a webhook misconfiguration fails before the
  // transfer rather than leaving the run's outcome unreported.
  const notifier = resolveNotifier(config);

  // A standalone run still gets a run id + context so it emits the same terminal
  // signal as a queue-driven one (no silent outcomes, #12) and records history (#13).
  const context = buildRunContext(config, new Date(), randomUUID(), "scheduled");
  await observeRun({ notifier }, context, () =>
    performTransfer(config, context.destinationKey, acquiaCreds, transport, `run ${context.runId} (manual)`),
  );
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
  // Resolve once before draining so a webhook misconfiguration fails the pass up
  // front rather than per message.
  const notifier = resolveNotifier(config);

  const summary = await drainQueueOnce(client, async (context) => {
    // One terminal signal per message to all observers (#12 notify, #13 history);
    // the rethrow on failure still lets drainQueueOnce mark the message for retry.
    await observeRun({ notifier }, context, () =>
      performTransfer(
        configForRun(config, context),
        context.destinationKey,
        acquiaCreds,
        transport,
        `run ${context.runId} (${context.trigger})`,
      ),
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
    // Surface our own typed failures (auth, no-backups, not-found, queue,
    // transfer) as a clean, actionable message; anything else prints in full for
    // debugging. A TransferError also names the stage that broke.
    if (err instanceof TransferError) {
      console.error(`[acfbak runner] failed at ${err.stage}: ${err.message}`);
    } else if (err instanceof AcquiaError || err instanceof QueueError) {
      console.error(`[acfbak runner] failed: ${err.name}: ${err.message}`);
    } else {
      console.error("[acfbak runner] failed:", err);
    }
    process.exit(1);
  });
}
