import { describe, it, expect } from "vitest";
import { buildRunContext, type BackupRunContext } from "../../src/run.ts";
import { enqueueBackupRun, type BackupQueueProducer } from "../../src/worker/index.ts";
import type { AcfbakConfig } from "../../src/config.ts";

const config: AcfbakConfig = {
  acquia: { applicationName: "my-drupal-app", environment: "prod", database: "default" },
  r2: { binding: "BACKUPS", bucket: "acfbak-backups", keyPrefix: "acquia" },
  schedule: { cron: "0 3 * * *", timezone: "UTC" },
};

describe("buildRunContext (AC-03)", () => {
  it("carries the full run context the runner needs", () => {
    const ctx = buildRunContext(config, new Date("2026-06-04T03:00:00Z"), "run-123");
    expect(ctx).toEqual<BackupRunContext>({
      runId: "run-123",
      application: "my-drupal-app",
      environment: "prod",
      database: "default",
      destinationKey: "acquia/prod/2026-06-04/db.sql.gz",
      enqueuedAt: "2026-06-04T03:00:00.000Z",
    });
  });
});

describe("enqueueBackupRun (AC-02 / AC-03)", () => {
  it("sends the run context to the queue and returns it", async () => {
    const sent: BackupRunContext[] = [];
    const queue: BackupQueueProducer = {
      async send(message) {
        sent.push(message);
      },
    };

    const ctx = await enqueueBackupRun(queue, new Date("2026-06-04T03:00:00Z"), "run-abc");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(ctx);
    expect(ctx.runId).toBe("run-abc");
    expect(ctx.destinationKey).toBe("acquia/prod/2026-06-04/db.sql.gz");
  });

  it("propagates a queue send failure", async () => {
    const queue: BackupQueueProducer = {
      async send() {
        throw new Error("queue unavailable");
      },
    };
    await expect(enqueueBackupRun(queue, new Date(), "run-x")).rejects.toThrow("queue unavailable");
  });
});
