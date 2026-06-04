import { describe, it, expect } from "vitest";
import {
  QueuePullClient,
  requireQueueCredentials,
  drainQueueOnce,
  QueueError,
  QueueAuthError,
  CF_API_BASE,
  type FetchLike,
  type QueueCredentials,
  type QueueConsumer,
  type PulledMessage,
  type QueueRetry,
} from "../../src/runner/queue.ts";
import type { BackupRunContext } from "../../src/run.ts";
import { buildRunContext } from "../../src/run.ts";
import type { AcfbakConfig } from "../../src/config.ts";

const config: AcfbakConfig = {
  acquia: { applicationName: "my-drupal-app", environment: "prod", database: "default" },
  r2: { binding: "BACKUPS", bucket: "acfbak-backups", keyPrefix: "acquia" },
  schedule: { cron: "0 3 * * *", timezone: "UTC" },
};

const creds: QueueCredentials = { accountId: "acct", apiToken: "tok", queueId: "q-123" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch double that records calls and returns canned responses by action. */
function recordingFetch(responder: (url: string, init?: RequestInit) => Response): {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

/** Encode a run context the way the Worker producer (json content type) does. */
function encodedMessage(runId: string, leaseId: string) {
  const ctx = buildRunContext(config, new Date("2026-06-04T03:00:00Z"), runId);
  return {
    id: `msg-${runId}`,
    lease_id: leaseId,
    attempts: 1,
    metadata: { "CF-Content-Type": "json" },
    body: Buffer.from(JSON.stringify(ctx), "utf8").toString("base64"),
  };
}

describe("requireQueueCredentials", () => {
  it("returns all three when present", () => {
    expect(
      requireQueueCredentials({
        CF_ACCOUNT_ID: "a",
        CF_API_TOKEN: "t",
        CF_QUEUE_ID: "q",
      } as NodeJS.ProcessEnv),
    ).toEqual({ accountId: "a", apiToken: "t", queueId: "q" });
  });

  it("throws listing the missing ones", () => {
    expect(() => requireQueueCredentials({ CF_ACCOUNT_ID: "a" } as NodeJS.ProcessEnv)).toThrow(
      /CF_API_TOKEN, CF_QUEUE_ID/,
    );
  });
});

describe("QueuePullClient.pull (AC-01)", () => {
  it("decodes base64 JSON message bodies into run contexts", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({
        success: true,
        result: {
          message_backlog_count: 1,
          messages: [encodedMessage("run-1", "lease-1")],
        },
      }),
    );
    const client = new QueuePullClient(creds, fetchImpl);
    const messages = await client.pull({ batchSize: 5 });

    expect(calls[0]?.url).toBe(`${CF_API_BASE}/accounts/acct/queues/q-123/messages/pull`);
    expect(calls[0]?.body).toEqual({ batch_size: 5, visibility_timeout_ms: 30000 });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.leaseId).toBe("lease-1");
    expect(messages[0]?.context.runId).toBe("run-1");
    expect(messages[0]?.context.destinationKey).toBe("acquia/prod/2026-06-04/db.sql.gz");
  });

  it("returns an empty array when the queue is empty", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ result: { messages: [] } }));
    const client = new QueuePullClient(creds, fetchImpl);
    expect(await client.pull()).toEqual([]);
  });

  it("maps a 403 to QueueAuthError", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ success: false }, 403));
    const client = new QueuePullClient(creds, fetchImpl);
    await expect(client.pull()).rejects.toBeInstanceOf(QueueAuthError);
  });

  it("rejects a body that is not a valid run context", async () => {
    const bad = {
      id: "m1",
      lease_id: "l1",
      attempts: 1,
      metadata: { "CF-Content-Type": "json" },
      body: Buffer.from(JSON.stringify({ not: "a context" }), "utf8").toString("base64"),
    };
    const { fetchImpl } = recordingFetch(() => jsonResponse({ result: { messages: [bad] } }));
    const client = new QueuePullClient(creds, fetchImpl);
    await expect(client.pull()).rejects.toBeInstanceOf(QueueError);
  });
});

describe("QueuePullClient.ack (AC-03 support)", () => {
  it("posts acks and retries in the documented shape", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ success: true }));
    const client = new QueuePullClient(creds, fetchImpl);
    await client.ack(["lease-a", "lease-b"], [{ leaseId: "lease-c", delaySeconds: 600 }]);

    expect(calls[0]?.url).toBe(`${CF_API_BASE}/accounts/acct/queues/q-123/messages/ack`);
    expect(calls[0]?.body).toEqual({
      acks: [{ lease_id: "lease-a" }, { lease_id: "lease-b" }],
      retries: [{ lease_id: "lease-c", delay_seconds: 600 }],
    });
  });

  it("is a no-op (no HTTP call) when there is nothing to ack or retry", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ success: true }));
    const client = new QueuePullClient(creds, fetchImpl);
    await client.ack([], []);
    expect(calls).toHaveLength(0);
  });
});

// A fake consumer that returns a fixed batch and records what gets acked/retried.
function fakeConsumer(messages: PulledMessage[]): {
  consumer: QueueConsumer;
  acked: () => string[];
  retried: () => QueueRetry[];
} {
  let ackedIds: string[] = [];
  let retriedItems: QueueRetry[] = [];
  const consumer: QueueConsumer = {
    async pull() {
      return messages;
    },
    async ack(ackLeaseIds, retries = []) {
      ackedIds = ackLeaseIds;
      retriedItems = retries;
    },
  };
  return { consumer, acked: () => ackedIds, retried: () => retriedItems };
}

function message(runId: string, leaseId: string): PulledMessage {
  const context: BackupRunContext = {
    runId,
    application: "my-drupal-app",
    environment: "prod",
    database: "default",
    destinationKey: `acquia/prod/2026-06-04/db.sql.gz`,
    enqueuedAt: "2026-06-04T03:00:00.000Z",
  };
  return { id: `msg-${runId}`, leaseId, attempts: 1, context };
}

describe("drainQueueOnce (AC-02 / AC-03)", () => {
  it("runs the handler per message and acks the successes", async () => {
    const { consumer, acked, retried } = fakeConsumer([
      message("r1", "lease-1"),
      message("r2", "lease-2"),
    ]);
    const handled: string[] = [];

    const summary = await drainQueueOnce(consumer, async (ctx) => {
      handled.push(ctx.runId);
    });

    expect(handled).toEqual(["r1", "r2"]);
    expect(summary).toEqual({ pulled: 2, acked: 2, retried: 0 });
    expect(acked()).toEqual(["lease-1", "lease-2"]);
    expect(retried()).toEqual([]);
  });

  it("retries the message whose handler throws, acks the rest", async () => {
    const { consumer, acked, retried } = fakeConsumer([
      message("ok", "lease-ok"),
      message("boom", "lease-boom"),
    ]);

    const summary = await drainQueueOnce(consumer, async (ctx) => {
      if (ctx.runId === "boom") throw new Error("transfer failed");
    });

    expect(summary).toEqual({ pulled: 2, acked: 1, retried: 1 });
    expect(acked()).toEqual(["lease-ok"]);
    expect(retried()).toEqual([{ leaseId: "lease-boom" }]);
  });

  it("reports zeros for an empty queue", async () => {
    const { consumer } = fakeConsumer([]);
    const summary = await drainQueueOnce(consumer, async () => {});
    expect(summary).toEqual({ pulled: 0, acked: 0, retried: 0 });
  });
});
