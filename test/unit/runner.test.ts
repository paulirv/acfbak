import { describe, it, expect, vi } from "vitest";

// Stub the Acquia client so performTransfer's discover/download stages can be
// driven without a network or credentials. selectLatestBackup etc. stay real.
const { discoverMock } = vi.hoisted(() => ({ discoverMock: vi.fn() }));
vi.mock("../../src/runner/acquia.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/runner/acquia.ts")>();
  return { ...actual, discoverLatestBackup: discoverMock };
});

const { observeRun, performTransfer, TransferError } = await import("../../src/runner/index.ts");
import type { R2Transport } from "../../src/runner/r2.ts";
import type { Notifier, RunNotification } from "../../src/notify.ts";
import type { AcfbakConfig } from "../../src/config.ts";
import type { BackupRunContext } from "../../src/run.ts";
import { inMemoryHistoryStore } from "../../src/history.ts";

const config: AcfbakConfig = {
  acquia: { applicationName: "my-drupal-app", environment: "prod", database: "default" },
  r2: { binding: "BACKUPS", bucket: "acfbak-backups", keyPrefix: "acquia" },
  schedule: { cron: "0 3 * * *", timezone: "UTC" },
};

const context: BackupRunContext = {
  runId: "run-1",
  trigger: "on-demand",
  label: "pre-deploy v2.3",
  application: "my-drupal-app",
  environment: "prod",
  database: "default",
  destinationKey: "acquia/prod/on-demand/2026-06-13T21-08-59Z/db.sql.gz",
  enqueuedAt: "2026-06-13T21:08:59.000Z",
};

/** A notifier that records every event it receives. */
function recordingNotifier(): { notifier: Notifier; events: RunNotification[] } {
  const events: RunNotification[] = [];
  return { notifier: { notify: async (e) => void events.push(e) }, events };
}

const fixedNow = () => new Date("2026-06-13T21:09:00.000Z");
const okResult = { key: context.destinationKey, size: 4096, sourceBackupId: 77 };

describe("observeRun — exactly one terminal signal (#12, AC-01)", () => {
  it("emits a single success event carrying key, size, and timestamp (AC-03)", async () => {
    const { notifier, events } = recordingNotifier();
    const result = await observeRun({ notifier }, context, async () => okResult, fixedNow);

    expect(result).toEqual(okResult);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "success",
      runId: "run-1",
      trigger: "on-demand",
      label: "pre-deploy v2.3",
      destinationKey: context.destinationKey,
      size: 4096,
      timestamp: "2026-06-13T21:09:00.000Z",
    });
  });

  it("emits a single failure event with stage + error and rethrows (AC-02)", async () => {
    const { notifier, events } = recordingNotifier();
    const boom = new TransferError("transfer", new Error("size mismatch"));

    await expect(
      observeRun({ notifier }, context, async () => {
        throw boom;
      }, fixedNow),
    ).rejects.toBe(boom);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "failure",
      runId: "run-1",
      stage: "transfer",
      error: "size mismatch",
      timestamp: "2026-06-13T21:09:00.000Z",
    });
  });

  it("tags a non-TransferError failure as stage 'unknown'", async () => {
    const { notifier, events } = recordingNotifier();
    await expect(
      observeRun({ notifier }, context, async () => {
        throw new Error("kaboom");
      }, fixedNow),
    ).rejects.toThrow("kaboom");
    expect(events[0]).toMatchObject({ outcome: "failure", stage: "unknown", error: "kaboom" });
  });

  it("omits the label for an unlabelled (scheduled) run", async () => {
    const { notifier, events } = recordingNotifier();
    const scheduled: BackupRunContext = { ...context, trigger: "scheduled", label: undefined };
    await observeRun({ notifier }, scheduled, async () => okResult, fixedNow);
    expect(events[0]).not.toHaveProperty("label");
  });
});

describe("observeRun — history recording (#13)", () => {
  it("appends one success record with duration, size, and source backup id", async () => {
    const { notifier } = recordingNotifier();
    const history = inMemoryHistoryStore();
    // First now() = start, second = finish → 1000ms duration.
    let calls = 0;
    const clock = () =>
      new Date(calls++ === 0 ? "2026-06-13T21:09:00.000Z" : "2026-06-13T21:09:01.000Z");

    await observeRun({ notifier, history }, context, async () => okResult, clock);

    expect(history.records).toHaveLength(1);
    expect(history.records[0]).toMatchObject({
      runId: "run-1",
      trigger: "on-demand",
      label: "pre-deploy v2.3",
      outcome: "success",
      sizeBytes: 4096,
      sourceBackupId: 77,
      durationMs: 1000,
      destinationKey: context.destinationKey,
      timestamp: "2026-06-13T21:09:01.000Z",
    });
  });

  it("appends one failure record with the failing stage", async () => {
    const { notifier } = recordingNotifier();
    const history = inMemoryHistoryStore();
    await expect(
      observeRun({ notifier, history }, context, async () => {
        throw new TransferError("download", new Error("403"));
      }, fixedNow),
    ).rejects.toThrow("403");

    expect(history.records).toHaveLength(1);
    expect(history.records[0]).toMatchObject({
      outcome: "failure",
      stage: "download",
      error: "403",
      destinationKey: context.destinationKey,
    });
  });

  it("a history append failure never flips a successful run", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { notifier } = recordingNotifier();
    const flaky = {
      async append() {
        throw new Error("r2 down");
      },
      async list() {
        return [];
      },
    };
    const result = await observeRun({ notifier, history: flaky }, context, async () => okResult, fixedNow);
    expect(result).toEqual(okResult); // success preserved
    expect(err).toHaveBeenCalled(); // append failure logged
    err.mockRestore();
  });
});

/** Build a web ReadableStream emitting `bytes` worth of data then closing. */
function webStreamOf(bytes: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

/** A transport whose upload drains the piped stream; headSize is configurable. */
function fakeTransport(storedSize: number, onUpload?: () => void): R2Transport {
  return {
    async upload(_bucket, _key, body) {
      onUpload?.();
      // Drain so the CountingTransform tallies bytes and the pipeline completes.
      for await (const _chunk of body) void _chunk;
    },
    async headSize() {
      return storedSize;
    },
  };
}

describe("performTransfer — stage-tagged failures (#12, AC-02)", () => {
  const creds = { key: "k", secret: "s" };

  it("tags a discover failure with stage 'discover'", async () => {
    discoverMock.mockRejectedValueOnce(new Error("acquia 500"));
    const err = await performTransfer(config, "k", creds, fakeTransport(0), "t").catch((e) => e);
    expect(err).toBeInstanceOf(TransferError);
    expect((err as InstanceType<typeof TransferError>).stage).toBe("discover");
  });

  it("tags a download failure with stage 'download'", async () => {
    discoverMock.mockResolvedValueOnce({
      metadata: { id: 1, type: "daily", startedAt: "", completedAt: "", environmentUuid: "e", databaseName: "d" },
      openDownload: async () => {
        throw new Error("download 403");
      },
    });
    const err = await performTransfer(config, "k", creds, fakeTransport(0), "t").catch((e) => e);
    expect((err as InstanceType<typeof TransferError>).stage).toBe("download");
  });

  it("tags an upload/verify failure with stage 'transfer'", async () => {
    discoverMock.mockResolvedValueOnce({
      metadata: { id: 1, type: "daily", startedAt: "", completedAt: "", environmentUuid: "e", databaseName: "d" },
      openDownload: async () => ({ url: "u", contentLength: 10, body: webStreamOf(10), response: new Response() }),
    });
    // Stored size (5) ≠ streamed (10) → integrity check throws inside transfer.
    const err = await performTransfer(config, "k", creds, fakeTransport(5), "t").catch((e) => e);
    expect((err as InstanceType<typeof TransferError>).stage).toBe("transfer");
  });

  it("returns key + verified size on success (no error)", async () => {
    discoverMock.mockResolvedValueOnce({
      metadata: { id: 1, type: "daily", startedAt: "", completedAt: "", environmentUuid: "e", databaseName: "d" },
      openDownload: async () => ({ url: "u", contentLength: 10, body: webStreamOf(10), response: new Response() }),
    });
    const result = await performTransfer(config, "dest-key", creds, fakeTransport(10), "t");
    expect(result).toEqual({ key: "dest-key", size: 10, sourceBackupId: 1 });
  });
});
