/**
 * acfbak orchestrator — Cloudflare Worker.
 *
 * Role (per docs/vision.md "Worker orchestrates, runner transfers"):
 *   - owns the schedule (Cron Trigger, see wrangler.toml [triggers])
 *   - decides when a backup should run and hands off the heavy byte transfer
 *     to the runner (the runner pulls Acquia's latest backup and streams it
 *     into R2 — see src/runner/index.ts)
 *   - owns alerting / observability for each run
 *
 * The Worker holds the R2 binding (env.BACKUPS) so it can verify the
 * destination is reachable and write small control objects (e.g. run markers,
 * smoke-test objects). Large dump transfer is the runner's job.
 */

import rawConfig from "../../acfbak.config.json";
import { validateConfig, type AcfbakConfig } from "../config";
import { buildRunContext, type BackupRunContext, type TriggerKind } from "../run";

export interface Env {
  /** Destination R2 bucket — see wrangler.toml [[r2_buckets]]. */
  BACKUPS: R2Bucket;

  /**
   * Worker→runner handoff queue — see wrangler.toml [[queues.producers]]. The
   * Worker is the producer; the runner consumes via the Queues HTTP pull API.
   */
  BACKUP_QUEUE: Queue<BackupRunContext>;

  // --- Secrets (set via `wrangler secret put`; never committed). ---
  // Wired and consumed in the runner/transfer requirements. Declared here so
  // the Worker env shape is the single typed contract for configuration.
  ACQUIA_API_KEY?: string;
  ACQUIA_API_SECRET?: string;
  /** Shared token gating the manual /trigger endpoint (set as a secret). */
  TRIGGER_TOKEN?: string;
}

/**
 * The producer half of a queue we need — just `send`. Lets tests inject a fake.
 * The return is `Promise<unknown>` so the real `Queue.send` (which resolves to a
 * QueueSendResponse) and a void-returning fake both satisfy it.
 */
export interface BackupQueueProducer {
  send(message: BackupRunContext): Promise<unknown>;
}

/** Parsed + validated declarative config, evaluated once at module load. */
const config: AcfbakConfig = validateConfig(rawConfig);

/**
 * Initiate a backup run: build the run context for `now` + `runId` (marked with
 * its `trigger` origin) and enqueue it for the runner (the Worker→runner
 * handoff). Returns the enqueued context so the caller can log/correlate it. The
 * queue is passed in (not read from a closure) so this is unit-testable with a
 * fake producer.
 */
export async function enqueueBackupRun(
  queue: BackupQueueProducer,
  now: Date,
  runId: string,
  trigger: TriggerKind,
  label?: string,
): Promise<BackupRunContext> {
  const context = buildRunContext(config, now, runId, trigger, label);
  await queue.send(context);
  return context;
}

/**
 * Assert the Acquia credentials are present on the Worker env (set via
 * `wrangler secret put`). Returns nothing useful but throws — loud failure —
 * if a secret is missing, and never logs the values.
 */
export function requireAcquiaSecrets(env: Env): void {
  const missing = (["ACQUIA_API_KEY", "ACQUIA_API_SECRET"] as const).filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required Worker secret(s): ${missing.join(", ")}. ` +
        `Set them with \`wrangler secret put <NAME>\` (see README "Secrets").`,
    );
  }
}

/**
 * Write a tiny object to R2 and read it back, proving the binding is wired and
 * the destination is reachable. Returns the object key on success; throws if
 * the round-trip fails. Used by the smoke-test endpoint and the test suite.
 */
export async function writeSmokeObject(env: Env): Promise<string> {
  const key = `${config.r2.keyPrefix}/_smoke/connectivity.txt`;
  const body = `acfbak R2 connectivity ok for ${config.r2.bucket}`;
  await env.BACKUPS.put(key, body);
  const readBack = await env.BACKUPS.get(key);
  if (readBack === null || (await readBack.text()) !== body) {
    throw new Error(`R2 smoke write failed: could not read back ${key}`);
  }
  return key;
}

/**
 * Extract an optional on-demand label/reason from a `/trigger` request (#11).
 * Accepts either a `?label=` query param or a JSON body `{ "label": "..." }`;
 * the query param wins if both are present. Parsing is best-effort — a missing
 * or malformed body is not an error (the label is optional), so this never
 * throws and a bad body simply yields no label. Returns undefined when absent.
 */
export async function readTriggerLabel(request: Request, url: URL): Promise<string | undefined> {
  const fromQuery = url.searchParams.get("label");
  if (fromQuery && fromQuery.trim()) return fromQuery.trim();

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return undefined;
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && "label" in body) {
      const label = (body as { label: unknown }).label;
      if (typeof label === "string" && label.trim()) return label.trim();
    }
  } catch {
    // Malformed JSON body — the label is optional, so ignore and proceed.
  }
  return undefined;
}

export default {
  /**
   * Scheduled handler — fired by the Cron Trigger (wrangler.toml [triggers]).
   * The Worker owns timing only: it mints a run id, enqueues the run context
   * for the runner (the handoff), and logs the run start. The runner pulls the
   * job from the queue and performs the Acquia→R2 transfer.
   */
  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const runId = crypto.randomUUID();
    const context = await enqueueBackupRun(env.BACKUP_QUEUE, new Date(), runId, "scheduled");
    console.log(
      `[acfbak] scheduled run ${runId} @ cron "${event.cron}" — enqueued handoff ` +
        `source=${context.application}/${context.environment} ` +
        `dest=r2://${config.r2.bucket}/${context.destinationKey}`,
    );
  },

  /**
   * HTTP handler — lightweight health/status endpoint and (later) the
   * on-demand backup trigger (capability #2). Never leaks secrets.
   */
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health" || url.pathname === "/") {
      return Response.json({
        service: "acfbak",
        status: "ok",
        source: {
          application: config.acquia.applicationName,
          environment: config.acquia.environment,
        },
        destination: {
          bucket: config.r2.bucket,
          keyPrefix: config.r2.keyPrefix,
        },
        schedule: config.schedule.cron,
        // Report presence/wiring without ever leaking values.
        acquiaSecretsConfigured: Boolean(env.ACQUIA_API_KEY && env.ACQUIA_API_SECRET),
        manualTriggerEnabled: Boolean(env.TRIGGER_TOKEN),
      });
    }

    // On-demand backup trigger (capability #2, #10): fire a run now without
    // waiting for cron. This is a first-class backup path, not just a test hook
    // — it is token-gated, fail-closed, and enqueues the exact same run context
    // the scheduled handler does, marked `trigger: "on-demand"` so the origin is
    // identifiable downstream (logs, R2 artifact #11, history #13).
    if (url.pathname === "/trigger") {
      if (request.method !== "POST") {
        return Response.json({ error: "method not allowed; use POST" }, { status: 405 });
      }
      if (!env.TRIGGER_TOKEN) {
        return Response.json(
          { error: "manual trigger not configured; set the TRIGGER_TOKEN secret" },
          { status: 503 },
        );
      }
      if (request.headers.get("x-acfbak-token") !== env.TRIGGER_TOKEN) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      const label = await readTriggerLabel(request, url);
      const runId = crypto.randomUUID();
      const context = await enqueueBackupRun(env.BACKUP_QUEUE, new Date(), runId, "on-demand", label);
      console.log(
        `[acfbak] on-demand run ${runId}${context.label ? ` "${context.label}"` : ""} — enqueued handoff ` +
          `source=${context.application}/${context.environment} ` +
          `dest=r2://${config.r2.bucket}/${context.destinationKey}`,
      );
      return Response.json({
        triggered: true,
        runId,
        trigger: context.trigger,
        ...(context.label ? { label: context.label } : {}),
        destinationKey: context.destinationKey,
      });
    }

    if (url.pathname === "/smoke") {
      try {
        const key = await writeSmokeObject(env);
        return Response.json({ wrote: true, key });
      } catch (err) {
        return Response.json(
          { wrote: false, error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
