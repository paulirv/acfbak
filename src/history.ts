/**
 * Backup run history (#13) — a queryable record of recent runs so operators can
 * audit backup health over time, not just see the latest notification.
 *
 * Host-agnostic by design (no node:, Workers, or AWS imports): this module owns
 * the record shape, the history-object key convention, and the `HistoryStore`
 * contract plus an in-memory implementation for tests. The R2-backed store that
 * actually persists records lives runner-side (src/runner/history-store.ts),
 * because writing to R2 from outside Cloudflare needs the S3 SDK.
 *
 * Storage model: append-only, one small JSON object per run under a history
 * prefix (see {@link buildHistoryKey}). Per-run objects avoid the read-modify-
 * write race a single shared manifest would have, and "recent history" is just a
 * prefix listing. This is the lightweight store the issue prefers — no DB.
 */

import type { AcfbakConfig } from "./config.ts";
import type { TriggerKind } from "./run.ts";
import type { TransferStage } from "./notify.ts";

/**
 * One backup run's structured history record. Success and failure share the
 * common fields; the outcome-specific ones are optional and only set for their
 * outcome (size/sourceBackupId on success, stage/error on failure).
 */
export interface RunRecord {
  /** Run id minted by the Worker — correlates Worker ↔ runner ↔ R2 ↔ notification. */
  runId: string;
  /** Scheduled cron fire vs on-demand trigger — history distinguishes the two. */
  trigger: TriggerKind;
  /** Operator label for an on-demand run, if any. */
  label?: string;
  /** Terminal outcome of the run. */
  outcome: "success" | "failure";
  /** R2 destination key the run targeted (written on success; intended on failure). */
  destinationKey: string;
  /** ISO-8601 timestamp the run reached its terminal outcome. */
  timestamp: string;
  /** Wall-clock duration of the transfer attempt, milliseconds. */
  durationMs: number;
  /** Verified stored artifact size in bytes (success only). */
  sizeBytes?: number;
  /** Acquia source backup id the dump came from (success only). */
  sourceBackupId?: number;
  /** Pipeline stage that failed (failure only). */
  stage?: TransferStage;
  /** One-line error summary, never secret material (failure only). */
  error?: string;
}

/** Inputs common to both record builders (the parts known before the outcome). */
interface RunRecordBase {
  runId: string;
  trigger: TriggerKind;
  label?: string;
  destinationKey: string;
  timestamp: string;
  durationMs: number;
}

/** Build a success record (#13, AC-01). */
export function successRecord(
  base: RunRecordBase,
  details: { sizeBytes: number; sourceBackupId: number },
): RunRecord {
  // Destructure label out so an explicit `label: undefined` never becomes an
  // own property — it is only set when there is a real label.
  const { label, ...rest } = base;
  return {
    ...rest,
    ...(label ? { label } : {}),
    outcome: "success",
    sizeBytes: details.sizeBytes,
    sourceBackupId: details.sourceBackupId,
  };
}

/** Build a failure record (#13, AC-01). */
export function failureRecord(
  base: RunRecordBase,
  details: { stage: TransferStage; error: string },
): RunRecord {
  const { label, ...rest } = base;
  return {
    ...rest,
    ...(label ? { label } : {}),
    outcome: "failure",
    stage: details.stage,
    error: details.error,
  };
}

/** Replace `:` with `-` so an ISO timestamp is safe in an object-key segment. */
function keySafeTimestamp(isoTimestamp: string): string {
  return isoTimestamp.replace(/:/g, "-");
}

/**
 * The history object key for a record:
 *   `{keyPrefix}/_history/{YYYY-MM}/{timestamp}-{runId}.json`
 * e.g. `acquia/_history/2026-06/2026-06-13T21-09-00.000Z-run-1.json`. The
 * timestamp prefix sorts lexically (so a prefix listing is chronological) and
 * the month shard keeps any single listing bounded. The `_history/` segment
 * mirrors the existing `_smoke/` control prefix and is excluded from backups.
 */
export function buildHistoryKey(config: AcfbakConfig, record: RunRecord): string {
  const month = record.timestamp.slice(0, 7); // YYYY-MM
  return `${config.r2.keyPrefix}/_history/${month}/${keySafeTimestamp(record.timestamp)}-${record.runId}.json`;
}

/** Persist and retrieve run records. Implementations should be append-only. */
export interface HistoryStore {
  /** Append one run record. */
  append(record: RunRecord): Promise<void>;
  /** Return recent records, most-recent first, capped at `limit` (default 20). */
  list(opts?: { limit?: number }): Promise<RunRecord[]>;
}

/**
 * In-memory {@link HistoryStore} — used by tests and as a safe fallback. Keeps
 * insertion order; `list` returns most-recent first.
 */
export function inMemoryHistoryStore(): HistoryStore & { records: RunRecord[] } {
  const records: RunRecord[] = [];
  return {
    records,
    async append(record) {
      records.push(record);
    },
    async list(opts) {
      const limit = opts?.limit ?? 20;
      return records.slice(-limit).reverse();
    },
  };
}

/** Render recent records as a compact operator-readable table (newest first). */
export function formatHistory(records: RunRecord[]): string {
  if (records.length === 0) return "(no backup runs recorded yet)";
  return records
    .map((r) => {
      const head = `${r.timestamp}  ${r.outcome.toUpperCase().padEnd(7)}  ${r.trigger}`;
      const detail =
        r.outcome === "success"
          ? `${r.sizeBytes ?? 0}B in ${r.durationMs}ms  src=${r.sourceBackupId ?? "?"}  ${r.destinationKey}`
          : `stage=${r.stage ?? "?"}  ${r.error ?? ""}`;
      const label = r.label ? `  "${r.label}"` : "";
      return `${head}${label}  ${r.runId}\n    ${detail}`;
    })
    .join("\n");
}
