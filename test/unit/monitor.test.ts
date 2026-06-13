import { describe, it, expect } from "vitest";
import { checkHeartbeat, missedRunEvent, hoursLabel } from "../../src/monitor.ts";
import { successRecord, failureRecord } from "../../src/history.ts";

const DAY = 24 * 3_600_000;
const maxAgeMs = 26 * 3_600_000; // 24h schedule + 2h grace

function success(runId: string, timestamp: string) {
  return successRecord(
    { runId, trigger: "scheduled", destinationKey: "k", timestamp, durationMs: 1000 },
    { sizeBytes: 1, sourceBackupId: 1 },
  );
}
function failure(runId: string, timestamp: string) {
  return failureRecord(
    { runId, trigger: "scheduled", destinationKey: "k", timestamp, durationMs: 1000 },
    { stage: "transfer", error: "boom" },
  );
}

const now = new Date("2026-06-13T12:00:00.000Z");

describe("checkHeartbeat (#14, AC-01)", () => {
  it("is healthy when a successful backup landed within the window", () => {
    const records = [success("r1", new Date(now.getTime() - 3 * 3_600_000).toISOString())];
    const result = checkHeartbeat(records, now, maxAgeMs);
    expect(result.healthy).toBe(true);
    expect(result.lastSuccessAt).toBe(records[0]!.timestamp);
  });

  it("is unhealthy when the most recent success is older than the window", () => {
    const records = [success("r1", new Date(now.getTime() - 2 * DAY).toISOString())];
    const result = checkHeartbeat(records, now, maxAgeMs);
    expect(result.healthy).toBe(false);
    expect(result.ageMs).toBe(2 * DAY);
  });

  it("is unhealthy when there is no success on record at all", () => {
    const result = checkHeartbeat([], now, maxAgeMs);
    expect(result).toEqual({ healthy: false, lastSuccessAt: null, ageMs: null });
  });

  it("ignores failed runs — a failure is not a successful backup", () => {
    const records = [failure("r1", new Date(now.getTime() - 1 * 3_600_000).toISOString())];
    const result = checkHeartbeat(records, now, maxAgeMs);
    expect(result.healthy).toBe(false);
    expect(result.lastSuccessAt).toBeNull();
  });

  it("selects the most recent success regardless of input order", () => {
    const old = success("old", new Date(now.getTime() - 5 * DAY).toISOString());
    const fresh = success("fresh", new Date(now.getTime() - 2 * 3_600_000).toISOString());
    const result = checkHeartbeat([fresh, old], now, maxAgeMs);
    expect(result.lastSuccessAt).toBe(fresh.timestamp);
    expect(result.healthy).toBe(true);
  });
});

describe("missedRunEvent (#14, AC-02)", () => {
  it("builds a missed alert with the window, last success, and age", () => {
    const result = checkHeartbeat(
      [success("r1", new Date(now.getTime() - 2 * DAY).toISOString())],
      now,
      maxAgeMs,
    );
    const event = missedRunEvent(result, maxAgeMs, now);
    expect(event).toEqual({
      outcome: "missed",
      expectedWithin: "26h",
      lastSuccessAt: result.lastSuccessAt,
      ageHours: 48,
      timestamp: now.toISOString(),
    });
  });

  it("reports null age when there is no success on record", () => {
    const event = missedRunEvent(checkHeartbeat([], now, maxAgeMs), maxAgeMs, now);
    expect(event.lastSuccessAt).toBeNull();
    expect(event.ageHours).toBeNull();
  });
});

describe("hoursLabel", () => {
  it("renders milliseconds as whole hours", () => {
    expect(hoursLabel(26 * 3_600_000)).toBe("26h");
  });
});
