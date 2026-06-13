import { describe, it, expect, vi } from "vitest";
import {
  formatNotification,
  consoleNotifier,
  webhookNotifier,
  teeNotifier,
  resolveNotifier,
  type RunNotification,
  type RunSuccessEvent,
  type RunFailureEvent,
  type FetchLike,
} from "../../src/notify.ts";
import type { AcfbakConfig } from "../../src/config.ts";

const baseConfig: AcfbakConfig = {
  acquia: { applicationName: "my-drupal-app", environment: "prod", database: "default" },
  r2: { binding: "BACKUPS", bucket: "acfbak-backups", keyPrefix: "acquia" },
  schedule: { cron: "0 3 * * *", timezone: "UTC" },
};

const success: RunSuccessEvent = {
  outcome: "success",
  runId: "run-1",
  trigger: "scheduled",
  destinationKey: "acquia/prod/2026-06-13/db.sql.gz",
  size: 1234,
  timestamp: "2026-06-13T03:00:01.000Z",
};

const failure: RunFailureEvent = {
  outcome: "failure",
  runId: "run-2",
  trigger: "on-demand",
  label: "pre-deploy v2.3",
  stage: "transfer",
  error: "size mismatch: streamed 10 stored 5",
  timestamp: "2026-06-13T21:09:00.000Z",
};

describe("formatNotification (#12)", () => {
  it("success summary includes destination key, size, and timestamp (AC-03)", () => {
    const { subject, text } = formatNotification(success);
    expect(subject).toContain("OK");
    expect(text).toContain("acquia/prod/2026-06-13/db.sql.gz");
    expect(text).toContain("1234 bytes");
    expect(text).toContain("2026-06-13T03:00:01.000Z");
  });

  it("failure summary includes run id, stage, error, and timestamp (AC-02)", () => {
    const { subject, text } = formatNotification(failure);
    expect(subject).toContain("FAILED");
    expect(text).toContain("run-2");
    expect(text).toContain("stage: transfer");
    expect(text).toContain("size mismatch");
    expect(text).toContain("2026-06-13T21:09:00.000Z");
  });

  it("surfaces an on-demand label in the origin", () => {
    expect(formatNotification(failure).text).toContain('on-demand "pre-deploy v2.3"');
  });

  it("renders a missed-run alert with the window and last success (#14)", () => {
    const { subject, text } = formatNotification({
      outcome: "missed",
      expectedWithin: "26h",
      lastSuccessAt: "2026-06-11T03:00:00.000Z",
      ageHours: 48,
      timestamp: "2026-06-13T12:00:00.000Z",
    });
    expect(subject).toContain("MISSED");
    expect(text).toContain("within 26h");
    expect(text).toContain("2026-06-11T03:00:00.000Z");
    expect(text).toContain("48h ago");
  });

  it("renders a missed-run alert when there is no success on record (#14)", () => {
    const { text } = formatNotification({
      outcome: "missed",
      expectedWithin: "26h",
      lastSuccessAt: null,
      ageHours: null,
      timestamp: "2026-06-13T12:00:00.000Z",
    });
    expect(text).toContain("none on record");
  });
});

describe("consoleNotifier (#12)", () => {
  it("logs success to stdout and failure to stderr", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const notifier = consoleNotifier();

    await notifier.notify(success);
    await notifier.notify(failure);

    expect(out).toHaveBeenCalledOnce();
    expect(err).toHaveBeenCalledOnce();
    expect(out.mock.calls[0]![0]).toContain("acquia/prod/2026-06-13/db.sql.gz");
    expect(err.mock.calls[0]![0]).toContain("stage: transfer");
    out.mockRestore();
    err.mockRestore();
  });
});

describe("webhookNotifier (#12)", () => {
  it("POSTs a Slack-compatible { text } payload", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response("ok", { status: 200 });
    };
    await webhookNotifier("https://hooks.example/abc", fetchImpl).notify(success);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hooks.example/abc");
    const body = JSON.parse(String(calls[0]!.init!.body)) as { text: string };
    expect(body.text).toContain("acfbak backup succeeded");
  });

  it("swallows a non-2xx response so a delivery failure never fails the run", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl: FetchLike = async () => new Response("nope", { status: 500 });
    await expect(
      webhookNotifier("https://hooks.example/abc", fetchImpl).notify(success),
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("swallows a network error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(
      webhookNotifier("https://hooks.example/abc", fetchImpl).notify(failure),
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("teeNotifier (#12)", () => {
  it("fans the event out to every channel", async () => {
    const seen: RunNotification[] = [];
    const a = { notify: async (e: RunNotification) => void seen.push(e) };
    const b = { notify: async (e: RunNotification) => void seen.push(e) };
    await teeNotifier(a, b).notify(success);
    expect(seen).toHaveLength(2);
  });
});

describe("resolveNotifier (#12, AC-04)", () => {
  it("defaults to the console channel when notifications are unconfigured", () => {
    const notifier = resolveNotifier(baseConfig, {});
    expect(notifier).toBeDefined();
  });

  it("builds a webhook (tee) channel when configured with a URL secret", async () => {
    const config: AcfbakConfig = { ...baseConfig, notifications: { channel: "webhook" } };
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return new Response("ok", { status: 200 });
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const notifier = resolveNotifier(config, { NOTIFY_WEBHOOK_URL: "https://hooks.example/x" }, fetchImpl);
    await notifier.notify(success);
    expect(calls).toEqual(["https://hooks.example/x"]); // webhook fired
    expect(log).toHaveBeenCalled(); // console tee fired too
    log.mockRestore();
  });

  it("fails loud when the webhook channel is selected without a URL secret", () => {
    const config: AcfbakConfig = { ...baseConfig, notifications: { channel: "webhook" } };
    expect(() => resolveNotifier(config, {})).toThrow(/NOTIFY_WEBHOOK_URL/);
  });
});
