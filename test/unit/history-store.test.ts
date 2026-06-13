import { describe, it, expect } from "vitest";
import { r2HistoryStore, type HistoryTransport } from "../../src/runner/history-store.ts";
import { successRecord } from "../../src/history.ts";
import type { AcfbakConfig } from "../../src/config.ts";

const config: AcfbakConfig = {
  acquia: { applicationName: "my-drupal-app", environment: "prod", database: "default" },
  r2: { binding: "BACKUPS", bucket: "acfbak-backups", keyPrefix: "acquia" },
  schedule: { cron: "0 3 * * *", timezone: "UTC" },
};

/** In-memory object store standing in for R2's S3 API. */
function fakeTransport(): HistoryTransport & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async put(_bucket, key, body) {
      store.set(key, body);
    },
    async listKeys(_bucket, prefix) {
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
    async get(_bucket, key) {
      return store.get(key) ?? null;
    },
  };
}

function recordAt(runId: string, timestamp: string) {
  return successRecord(
    {
      runId,
      trigger: "scheduled",
      destinationKey: `acquia/prod/${timestamp.slice(0, 10)}/db.sql.gz`,
      timestamp,
      durationMs: 1000,
    },
    { sizeBytes: 100, sourceBackupId: 1 },
  );
}

const fixedNow = () => new Date("2026-06-13T12:00:00.000Z");

describe("r2HistoryStore.append (#13)", () => {
  it("writes one JSON object per run under the month-sharded history key", async () => {
    const transport = fakeTransport();
    const store = r2HistoryStore(transport, config, fixedNow);
    await store.append(recordAt("run-1", "2026-06-13T03:00:01.000Z"));

    const key = "acquia/_history/2026-06/2026-06-13T03-00-01.000Z-run-1.json";
    expect(transport.store.has(key)).toBe(true);
    expect(JSON.parse(transport.store.get(key)!)).toMatchObject({ runId: "run-1", outcome: "success" });
  });
});

describe("r2HistoryStore.list (#13, AC-02)", () => {
  it("returns recent records most-recent first, capped at limit", async () => {
    const transport = fakeTransport();
    const store = r2HistoryStore(transport, config, fixedNow);
    await store.append(recordAt("run-a", "2026-06-10T03:00:00.000Z"));
    await store.append(recordAt("run-b", "2026-06-11T03:00:00.000Z"));
    await store.append(recordAt("run-c", "2026-06-12T03:00:00.000Z"));

    const recent = await store.list({ limit: 2 });
    expect(recent.map((r) => r.runId)).toEqual(["run-c", "run-b"]);
  });

  it("scans across month shards to fill the requested limit", async () => {
    const transport = fakeTransport();
    const store = r2HistoryStore(transport, config, fixedNow);
    await store.append(recordAt("may", "2026-05-30T03:00:00.000Z"));
    await store.append(recordAt("jun", "2026-06-01T03:00:00.000Z"));

    const recent = await store.list({ limit: 5 });
    expect(recent.map((r) => r.runId)).toEqual(["jun", "may"]);
  });

  it("returns an empty list when there is no history", async () => {
    const store = r2HistoryStore(fakeTransport(), config, fixedNow);
    expect(await store.list()).toEqual([]);
  });
});
