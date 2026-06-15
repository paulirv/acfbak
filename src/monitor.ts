/**
 * Missed-run / heartbeat detection (#14) — catch the failure mode where a backup
 * never ran at all (a silent gap), not just one that ran and failed.
 *
 * Host-agnostic by design (no node:, Workers, or AWS imports): a pure check over
 * the run history (#13) plus the {@link MissedRunEvent} builder. The thing that
 * makes this trustworthy is *where* it runs — the runner schedules it out of
 * band from the backup itself (a dead Worker can't alert on its own absence), so
 * the check only needs the recorded history, which this module consumes.
 */

import type { RunRecord } from "./history.ts";
import type { MissedRunEvent } from "./notify.ts";

const MS_PER_HOUR = 3_600_000;

/** The most recent successful backup on record and its age at check time. */
export interface LastSuccess {
  /** ISO timestamp of the most recent successful backup. */
  at: string;
  /** Age of that success in milliseconds at check time. */
  ageMs: number;
}

/**
 * Outcome of an expected-run check. A discriminated union so the "both or
 * neither" invariant is enforced by the type, not by convention: a healthy
 * result always carries a {@link LastSuccess}; an unhealthy one carries the
 * stale success if there is one, or `null` when none is on record.
 */
export type HeartbeatResult =
  | { healthy: true; lastSuccess: LastSuccess }
  | { healthy: false; lastSuccess: LastSuccess | null };

/** Whole hours from a millisecond duration — the single ms→hours conversion. */
export function hours(ms: number): number {
  return Math.round(ms / MS_PER_HOUR);
}

/** Render a millisecond duration as whole hours for human messages, e.g. "26h". */
export function hoursLabel(ms: number): string {
  return `${hours(ms)}h`;
}

/**
 * Decide whether a successful backup landed within `maxAgeMs` of `now` (#14,
 * AC-01). Considers only **successful** runs — a failed run is not a backup, and
 * it already alerted through its own failure notification (#12). With no success
 * on record at all, the result is unhealthy with `lastSuccess: null`.
 *
 * `records` need not be sorted; the most recent success is selected by parsed
 * timestamp (chronological, not lexical — so non-canonical-but-valid ISO inputs
 * still order correctly).
 */
export function checkHeartbeat(
  records: RunRecord[],
  now: Date,
  maxAgeMs: number,
): HeartbeatResult {
  const successes = records.filter((r) => r.outcome === "success");
  if (successes.length === 0) {
    return { healthy: false, lastSuccess: null };
  }
  const latest = successes.reduce((a, b) =>
    Date.parse(a.timestamp) >= Date.parse(b.timestamp) ? a : b,
  );
  const ageMs = now.getTime() - Date.parse(latest.timestamp);
  const lastSuccess: LastSuccess = { at: latest.timestamp, ageMs };
  return ageMs <= maxAgeMs ? { healthy: true, lastSuccess } : { healthy: false, lastSuccess };
}

/**
 * Build the alert for a missed run, to be sent through the same notifier as a
 * failed run (#14, AC-02). Call only when {@link checkHeartbeat} reports
 * unhealthy. `lastSuccessAt`/`ageHours` are derived from the single
 * {@link LastSuccess}, so they never diverge.
 */
export function missedRunEvent(result: HeartbeatResult, maxAgeMs: number, now: Date): MissedRunEvent {
  return {
    outcome: "missed",
    expectedWithin: hoursLabel(maxAgeMs),
    lastSuccessAt: result.lastSuccess?.at ?? null,
    ageHours: result.lastSuccess ? hours(result.lastSuccess.ageMs) : null,
    timestamp: now.toISOString(),
  };
}
