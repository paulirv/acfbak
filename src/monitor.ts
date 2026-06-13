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

/** Outcome of an expected-run check. */
export interface HeartbeatResult {
  /** True when a successful backup landed within the expected window. */
  healthy: boolean;
  /** ISO timestamp of the most recent successful backup, or null if none on record. */
  lastSuccessAt: string | null;
  /** Age of the most recent success in milliseconds, or null if none on record. */
  ageMs: number | null;
}

/** Render a millisecond duration as whole hours for human messages, e.g. "26h". */
export function hoursLabel(ms: number): string {
  return `${Math.round(ms / 3_600_000)}h`;
}

/**
 * Decide whether a successful backup landed within `maxAgeMs` of `now` (#14,
 * AC-01). Considers only **successful** runs — a failed run is not a backup, and
 * it already alerted through its own failure notification (#12). With no success
 * on record at all, the result is unhealthy (lastSuccessAt/ageMs null).
 *
 * `records` need not be sorted; the most recent success is selected by timestamp.
 */
export function checkHeartbeat(
  records: RunRecord[],
  now: Date,
  maxAgeMs: number,
): HeartbeatResult {
  const successes = records.filter((r) => r.outcome === "success");
  if (successes.length === 0) {
    return { healthy: false, lastSuccessAt: null, ageMs: null };
  }
  const latest = successes.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b));
  const ageMs = now.getTime() - new Date(latest.timestamp).getTime();
  return { healthy: ageMs <= maxAgeMs, lastSuccessAt: latest.timestamp, ageMs };
}

/**
 * Build the alert for a missed run, to be sent through the same notifier as a
 * failed run (#14, AC-02). Call only when {@link checkHeartbeat} reports
 * unhealthy.
 */
export function missedRunEvent(result: HeartbeatResult, maxAgeMs: number, now: Date): MissedRunEvent {
  return {
    outcome: "missed",
    expectedWithin: hoursLabel(maxAgeMs),
    lastSuccessAt: result.lastSuccessAt,
    ageHours: result.ageMs === null ? null : Math.round(result.ageMs / 3_600_000),
    timestamp: now.toISOString(),
  };
}
