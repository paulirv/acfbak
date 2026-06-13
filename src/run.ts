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
 * Format a Date as a UTC second-precision timestamp safe for an object-key
 * path segment: `YYYY-MM-DDTHH-MM-SSZ` (colons → dashes), e.g.
 * `2026-06-13T21-08-59Z`. On-demand keys use this rather than just the day so
 * multiple on-demand runs in the same day don't collide.
 */
function utcTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/:/g, "-") + "Z";
}

/**
 * Slugify an optional on-demand label/reason into a key-safe segment suffix:
 * lowercase, non-alphanumerics → single dashes, trimmed, capped at 40 chars.
 * Returns "" when there is nothing usable (so the key omits the suffix).
 * e.g. "pre-deploy v2.3" → "pre-deploy-v2-3".
 */
export function slugifyLabel(label: string | undefined): string {
  if (!label) return "";
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/**
 * Build the destination object key for a backup. The convention encodes the
 * trigger origin (#11) so on-demand copies are distinguishable from scheduled
 * ones in R2 — for operators browsing and for retention (#4), which can include
 * or exclude on-demand copies by globbing the `on-demand/` segment.
 *
 *   scheduled  → `{keyPrefix}/{environment}/{YYYY-MM-DD}/db.sql.gz`
 *   on-demand  → `{keyPrefix}/{environment}/on-demand/{YYYY-MM-DDTHH-MM-SSZ}[-{label}]/db.sql.gz`
 *
 * e.g. `acquia/prod/2026-06-04/db.sql.gz` (scheduled) vs.
 * `acquia/prod/on-demand/2026-06-13T21-08-59Z-pre-deploy-v2-3/db.sql.gz`.
 * Scheduled keys are unchanged (one per UTC day); on-demand keys carry a
 * full timestamp and optional label slug so repeated manual runs never collide.
 */
export function buildObjectKey(
  config: AcfbakConfig,
  date: Date,
  trigger: TriggerKind,
  label?: string,
): string {
  const base = `${config.r2.keyPrefix}/${config.acquia.environment}`;
  if (trigger === "scheduled") {
    return `${base}/${utcDay(date)}/db.sql.gz`;
  }
  const slug = slugifyLabel(label);
  const segment = slug ? `${utcTimestamp(date)}-${slug}` : utcTimestamp(date);
  return `${base}/on-demand/${segment}/db.sql.gz`;
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
  /**
   * Optional human label/reason for an on-demand run (e.g. "pre-deploy v2.3").
   * Slugified into the destination key; omitted for scheduled runs. Carried so
   * the runner and history (#13) can record the operator's intent verbatim.
   */
  label?: string;
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

/**
 * Assemble the run context the Worker enqueues for a given run id and time. An
 * optional `label` (on-demand only) is recorded on the context and folded into
 * the destination key so the artifact is self-describing.
 */
export function buildRunContext(
  config: AcfbakConfig,
  date: Date,
  runId: string,
  trigger: TriggerKind,
  label?: string,
): BackupRunContext {
  return {
    runId,
    trigger,
    // Only attach a label for on-demand runs, and only when non-empty.
    ...(trigger === "on-demand" && label ? { label } : {}),
    application: config.acquia.applicationName,
    environment: config.acquia.environment,
    database: config.acquia.database,
    destinationKey: buildObjectKey(config, date, trigger, label),
    enqueuedAt: date.toISOString(),
  };
}
