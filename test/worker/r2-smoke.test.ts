import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { writeSmokeObject } from "../../src/worker/index.ts";

// AC-04: the R2 bucket binding is wired and a trivial write succeeds.
// These run against the Miniflare-backed local R2 provided by the workers
// test pool — proving the binding contract without a live Cloudflare account.
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

// AC-03: the health endpoint reports secret presence without leaking values.
describe("secret hygiene (AC-03)", () => {
  it("does not expose secret values via /health", async () => {
    const res = await SELF.fetch("https://acfbak.test/health");
    const text = await res.text();

    // Whatever the configured state, raw secret material must never appear.
    expect(text).not.toContain("ACQUIA_API_KEY");
    expect(text).not.toContain("ACQUIA_API_SECRET");
    expect(text).toContain("acquiaSecretsConfigured");
  });
});
