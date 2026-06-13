/**
 * Backup run — the shared contract for a single backup run, used by BOTH the
 * Worker (which orchestrates and enqueues the run) and the runner (which pulls
 * the run and performs the transfer).
 *
 * Host-agnostic by design: no node:, Workers, or AWS imports, so it can be
 * bundled into the Worker and imported by the Node runner alike. It owns the
 * dated object-key convention and the run-context message shape that crosses
 * the Worker→runner handoff queue.
 */

import type { AcfbakConfig } from "./config.ts";

/**
 * What initiated a backup run. Both kinds flow through the exact same
 * orchestration + transfer code (the "single trusted backup path"); the marker
 * only records the origin so an on-demand run is identifiable in logs, the
 * handoff message, and — later — the stored artifact (#11) and history (#13).
 */
export type TriggerKind = "scheduled" | "on-demand";

/** Format a Date as a UTC `YYYY-MM-DD` calendar day. */
function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Build the dated object key for a backup. Documented convention:
 *   `{keyPrefix}/{environment}/{YYYY-MM-DD}/db.sql.gz`
 * e.g. `acquia/prod/2026-06-04/db.sql.gz`. The day is the UTC calendar day of
 * `date`. Feeds retention (#4) and verification (#5).
 */
export function buildObjectKey(config: AcfbakConfig, date: Date): string {
  return `${config.r2.keyPrefix}/${config.acquia.environment}/${utcDay(date)}/db.sql.gz`;
}

/**
 * The context handed from the Worker to the runner for one backup run. This is
 * the message body the Worker enqueues and the runner consumes — it carries
 * everything the runner needs to perform the transfer without re-deriving it:
 * which source to pull and the exact destination key to write.
 */
export interface BackupRunContext {
  /** Unique id for this run, for correlating Worker logs ↔ runner logs ↔ R2. */
  runId: string;
  /** What initiated this run — a scheduled cron fire or an on-demand trigger. */
  trigger: TriggerKind;
  /** Acquia application (subscription) name or UUID to pull from. */
  application: string;
  /** Acquia environment to back up (e.g. prod). */
  environment: string;
  /** Database name within the environment. */
  database: string;
  /** R2 destination object key for the dump (dated convention). */
  destinationKey: string;
  /** ISO-8601 timestamp the run was enqueued by the Worker. */
  enqueuedAt: string;
}

/** Assemble the run context the Worker enqueues for a given run id and time. */
export function buildRunContext(
  config: AcfbakConfig,
  date: Date,
  runId: string,
  trigger: TriggerKind,
): BackupRunContext {
  return {
    runId,
    trigger,
    application: config.acquia.applicationName,
    environment: config.acquia.environment,
    database: config.acquia.database,
    destinationKey: buildObjectKey(config, date),
    enqueuedAt: date.toISOString(),
  };
}
