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

export interface Env {
  /** Destination R2 bucket — see wrangler.toml [[r2_buckets]]. */
  BACKUPS: R2Bucket;

  // --- Secrets (set via `wrangler secret put`; never committed). ---
  // Wired and consumed in the runner/transfer requirements. Declared here so
  // the Worker env shape is the single typed contract for configuration.
  ACQUIA_API_KEY?: string;
  ACQUIA_API_SECRET?: string;
}

/** Parsed + validated declarative config, evaluated once at module load. */
const config: AcfbakConfig = validateConfig(rawConfig);

export default {
  /**
   * Scheduled handler — fired by the Cron Trigger. For the scaffold this
   * records the run intent; the Acquia→R2 transfer is wired in later
   * requirements (the runner does the heavy lifting).
   */
  async scheduled(event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log(
      `[acfbak] scheduled run @ cron "${event.cron}" — ` +
        `source=${config.acquia.applicationName}/${config.acquia.environment} ` +
        `dest=r2://${config.r2.bucket}/${config.r2.keyPrefix}`,
    );
    // TODO(#1): hand off to runner to pull Acquia's latest backup and stream to R2.
  },

  /**
   * HTTP handler — lightweight health/status endpoint and (later) the
   * on-demand backup trigger (capability #2). Never leaks secrets.
   */
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
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
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
