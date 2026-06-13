import {
  env,
  SELF,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker, { writeSmokeObject } from "../../src/worker/index.ts";

// NOTE: All Worker binding-integration tests live in THIS single file on
// purpose. The installed @cloudflare/vitest-pool-workers version cannot host
// more than one binding-backed test file: with isolatedStorage:false a second
// file collides on runtime assembly ("inserted row already exists"), and with
// isolatedStorage:true the R2 store trips a SQLite WAL (-shm) assertion. One
// file sidesteps both. Pure-logic tests belong in test/unit/** instead.

// AC-04 (#6): the R2 bucket binding is wired and a trivial write succeeds.
describe("R2 binding (AC-04)", () => {
  it("round-trips an object through env.BACKUPS", async () => {
    const key = "smoke/test-object.txt";
    const payload = "acfbak smoke ok";

    await env.BACKUPS.put(key, payload);
    const obj = await env.BACKUPS.get(key);

    expect(obj).not.toBeNull();
    expect(await obj!.text()).toBe(payload);
  });

  it("writeSmokeObject() writes and reads back a connectivity object", async () => {
    const key = await writeSmokeObject(env);
    const obj = await env.BACKUPS.get(key);

    expect(key).toContain("_smoke/connectivity.txt");
    expect(obj).not.toBeNull();
  });

  it("the worker /smoke endpoint reports a successful write", async () => {
    const res = await SELF.fetch("https://acfbak.test/smoke");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { wrote: boolean; key?: string };
    expect(body.wrote).toBe(true);
    expect(body.key).toBeTruthy();
  });
});

// AC-03 (#6): the health endpoint reports secret presence without leaking values.
describe("secret hygiene (AC-03)", () => {
  it("does not expose secret values via /health", async () => {
    const res = await SELF.fetch("https://acfbak.test/health");
    const text = await res.text();

    expect(text).not.toContain("ACQUIA_API_KEY");
    expect(text).not.toContain("ACQUIA_API_SECRET");
    expect(text).toContain("acquiaSecretsConfigured");
  });
});

// AC-01 / AC-02 (#8): the scheduled (Cron Trigger) handler runs and hands off
// without error, enqueueing onto the local queue binding provided by Miniflare.
describe("scheduled handoff (AC-01 / AC-02)", () => {
  it("the scheduled handler enqueues a run and resolves", async () => {
    const ctx = createExecutionContext();
    const controller = { cron: "0 3 * * *", scheduledTime: 0, noRetry() {} } as ScheduledController;
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);
    // Reaching here means env.BACKUP_QUEUE.send() succeeded against the local
    // queue — the cron-fire → enqueue handoff path is wired end to end.
  });
});

// AC-04 (#8): a manual invoke path exists, gated by the TRIGGER_TOKEN secret
// (injected for tests via the workspace miniflare bindings).
describe("manual /trigger (AC-04)", () => {
  it("rejects non-POST with 405", async () => {
    const res = await SELF.fetch("https://acfbak.test/trigger");
    expect(res.status).toBe(405);
  });

  it("rejects a missing token with 401", async () => {
    const res = await SELF.fetch("https://acfbak.test/trigger", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong token with 401", async () => {
    const res = await SELF.fetch("https://acfbak.test/trigger", {
      method: "POST",
      headers: { "x-acfbak-token": "nope" },
    });
    expect(res.status).toBe(401);
  });

  it("enqueues a run and returns a run id with the correct token", async () => {
    const res = await SELF.fetch("https://acfbak.test/trigger", {
      method: "POST",
      headers: { "x-acfbak-token": "test-trigger-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      triggered: boolean;
      runId: string;
      trigger: string;
      destinationKey: string;
    };
    expect(body.triggered).toBe(true);
    expect(body.runId).toBeTruthy();
    // The on-demand origin is reported on the response and carried into the
    // handoff context (#10) so it is identifiable downstream.
    expect(body.trigger).toBe("on-demand");
    // On-demand artifacts land under an on-demand/ segment with a timestamp (#11)
    // so they don't collide with — and are distinguishable from — scheduled ones.
    expect(body.destinationKey).toMatch(
      /^acquia\/prod\/on-demand\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\/db\.sql\.gz$/,
    );
  });

  it("folds an on-demand label (JSON body) into the key and response (#11)", async () => {
    const res = await SELF.fetch("https://acfbak.test/trigger", {
      method: "POST",
      headers: { "x-acfbak-token": "test-trigger-token", "content-type": "application/json" },
      body: JSON.stringify({ label: "pre-deploy v2.3" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { label?: string; destinationKey: string };
    expect(body.label).toBe("pre-deploy v2.3");
    expect(body.destinationKey).toMatch(
      /^acquia\/prod\/on-demand\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-pre-deploy-v2-3\/db\.sql\.gz$/,
    );
  });

  it("accepts an on-demand label via the ?label= query param (#11)", async () => {
    const res = await SELF.fetch("https://acfbak.test/trigger?label=hotfix%20A", {
      method: "POST",
      headers: { "x-acfbak-token": "test-trigger-token" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { label?: string; destinationKey: string };
    expect(body.label).toBe("hotfix A");
    expect(body.destinationKey).toContain("/on-demand/");
    expect(body.destinationKey).toContain("-hotfix-a/");
  });

  it("reports manualTriggerEnabled on /health without leaking the token", async () => {
    const res = await SELF.fetch("https://acfbak.test/health");
    const text = await res.text();
    expect(text).not.toContain("test-trigger-token");
    expect(JSON.parse(text).manualTriggerEnabled).toBe(true);
  });
});
