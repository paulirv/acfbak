import { describe, it, expect } from "vitest";
import {
  successRecord,
  failureRecord,
  buildHistoryKey,
  inMemoryHistoryStore,
  formatHistory,
  type RunRecord,
} from "../../src/history.ts";
import type { AcfbakConfig } from "../../src/config.ts";

const config: AcfbakConfig = {
  acquia: { applicationName: "my-drupal-app", environment: "prod", database: "default" },
  r2: { binding: "BACKUPS", bucket: "acfbak-backups", keyPrefix: "acquia" },
  schedule: { cron: "0 3 * * *", timezone: "UTC" },
};

const base = {
  runId: "run-1",
  trigger: "on-demand" as const,
  label: "pre-deploy v2.3",
  destinationKey: "acquia/prod/on-demand/2026-06-13T21-08-59Z/db.sql.gz",
  timestamp: "2026-06-13T21:09:00.000Z",
  durationMs: 1234,
};

describe("record builders (#13, AC-01)", () => {
  it("successRecord carries size + source backup id and the common fields", () => {
    const rec = successRecord(base, { sizeBytes: 4096, sourceBackupId: 77 });
    expect(rec).toEqual<RunRecord>({
      runId: "run-1",
      trigger: "on-demand",
      label: "pre-deploy v2.3",
      outcome: "success",
      destinationKey: base.destinationKey,
      timestamp: base.timestamp,
      durationMs: 1234,
      sizeBytes: 4096,
      sourceBackupId: 77,
    });
  });

  it("failureRecord carries stage + error", () => {
    const rec = failureRecord(base, { stage: "transfer", error: "size mismatch" });
    expect(rec).toMatchObject({ outcome: "failure", stage: "transfer", error: "size mismatch" });
    expect(rec).not.toHaveProperty("sizeBytes");
  });

  it("omits label for an unlabelled run (AC-03 distinguishes trigger regardless)", () => {
    const rec = successRecord(
      { ...base, label: undefined, trigger: "scheduled" },
      { sizeBytes: 1, sourceBackupId: 2 },
    );
    expect(rec).not.toHaveProperty("label");
    expect(rec.trigger).toBe("scheduled");
  });
});

describe("buildHistoryKey (#13)", () => {
  it("shards by month and sorts chronologically by timestamp prefix", () => {
    const rec = successRecord(base, { sizeBytes: 1, sourceBackupId: 2 });
    expect(buildHistoryKey(config, rec)).toBe(
      "acquia/_history/2026-06/2026-06-13T21-09-00.000Z-run-1.json",
    );
  });

  it("nests under the configured key prefix's _history control segment", () => {
    const rec = successRecord(base, { sizeBytes: 1, sourceBackupId: 2 });
    expect(buildHistoryKey(config, rec)).toContain("acquia/_history/");
  });
});

describe("inMemoryHistoryStore (#13, AC-02)", () => {
  it("returns recent records most-recent first, capped at limit", async () => {
    const store = inMemoryHistoryStore();
    for (let i = 0; i < 5; i++) {
      await store.append(successRecord({ ...base, runId: `run-${i}` }, { sizeBytes: i, sourceBackupId: i }));
    }
    const recent = await store.list({ limit: 3 });
    expect(recent.map((r) => r.runId)).toEqual(["run-4", "run-3", "run-2"]);
  });

  it("defaults to a limit of 20", async () => {
    const store = inMemoryHistoryStore();
    for (let i = 0; i < 25; i++) {
      await store.append(successRecord({ ...base, runId: `run-${i}` }, { sizeBytes: 0, sourceBackupId: 0 }));
    }
    expect(await store.list()).toHaveLength(20);
  });
});

describe("formatHistory (#13, AC-02)", () => {
  it("renders a placeholder when empty", () => {
    expect(formatHistory([])).toContain("no backup runs recorded");
  });

  it("renders success and failure rows distinctly", () => {
    const ok = successRecord(base, { sizeBytes: 4096, sourceBackupId: 77 });
    const bad = failureRecord({ ...base, runId: "run-2" }, { stage: "transfer", error: "mismatch" });
    const text = formatHistory([ok, bad]);
    expect(text).toContain("SUCCESS");
    expect(text).toContain("src=77");
    expect(text).toContain("FAILURE");
    expect(text).toContain("stage=transfer");
  });
});
