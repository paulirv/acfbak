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
    const ctx = buildRunContext(config, new Date("2026-06-04T03:00:00Z"), "run-123", "scheduled");
    expect(ctx).toEqual<BackupRunContext>({
      runId: "run-123",
      trigger: "scheduled",
      application: "my-drupal-app",
      environment: "prod",
      database: "default",
      destinationKey: "acquia/prod/2026-06-04/db.sql.gz",
      enqueuedAt: "2026-06-04T03:00:00.000Z",
    });
  });

  it("records the trigger origin so on-demand runs are identifiable (#10)", () => {
    const scheduled = buildRunContext(config, new Date("2026-06-04T03:00:00Z"), "r1", "scheduled");
    const onDemand = buildRunContext(config, new Date("2026-06-04T09:00:00Z"), "r2", "on-demand");
    expect(scheduled.trigger).toBe("scheduled");
    expect(onDemand.trigger).toBe("on-demand");
  });

  it("folds an on-demand label into both the context and the key (#11)", () => {
    const ctx = buildRunContext(config, new Date("2026-06-13T21:08:59Z"), "r3", "on-demand", "pre-deploy v2.3");
    expect(ctx.label).toBe("pre-deploy v2.3");
    expect(ctx.destinationKey).toBe("acquia/prod/on-demand/2026-06-13T21-08-59Z-pre-deploy-v2-3/db.sql.gz");
  });

  it("does not attach a label to scheduled runs even if one is passed (#11)", () => {
    const ctx = buildRunContext(config, new Date("2026-06-13T03:00:00Z"), "r4", "scheduled", "ignored");
    expect(ctx.label).toBeUndefined();
    expect(ctx.destinationKey).toBe("acquia/prod/2026-06-13/db.sql.gz");
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

    const ctx = await enqueueBackupRun(queue, new Date("2026-06-04T03:00:00Z"), "run-abc", "scheduled");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(ctx);
    expect(ctx.runId).toBe("run-abc");
    expect(ctx.trigger).toBe("scheduled");
    expect(ctx.destinationKey).toBe("acquia/prod/2026-06-04/db.sql.gz");
  });

  it("marks an on-demand run on the enqueued context (#10)", async () => {
    const sent: BackupRunContext[] = [];
    const queue: BackupQueueProducer = {
      async send(message) {
        sent.push(message);
      },
    };

    const ctx = await enqueueBackupRun(queue, new Date("2026-06-04T09:00:00Z"), "run-od", "on-demand");

    expect(ctx.trigger).toBe("on-demand");
    expect(sent[0]!.trigger).toBe("on-demand");
  });

  it("propagates a queue send failure", async () => {
    const queue: BackupQueueProducer = {
      async send() {
        throw new Error("queue unavailable");
      },
    };
    await expect(enqueueBackupRun(queue, new Date(), "run-x", "scheduled")).rejects.toThrow(
      "queue unavailable",
    );
  });
});
