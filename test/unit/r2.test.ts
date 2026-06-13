import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import {
  r2Endpoint,
  requireR2Credentials,
  buildObjectKey,
  assertUploadIntegrity,
  streamBackupToR2,
  R2UploadError,
  type R2Transport,
} from "../../src/runner/r2.ts";
import { slugifyLabel } from "../../src/run.ts";
import type { AcfbakConfig } from "../../src/config.ts";

const config: AcfbakConfig = {
  acquia: { applicationName: "my-drupal-app", environment: "prod", database: "default" },
  r2: { binding: "BACKUPS", bucket: "acfbak-backups", keyPrefix: "acquia" },
  schedule: { cron: "0 3 * * *", timezone: "UTC" },
};

describe("r2Endpoint", () => {
  it("builds the account's R2 S3 endpoint", () => {
    expect(r2Endpoint("abc123")).toBe("https://abc123.r2.cloudflarestorage.com");
  });
});

describe("requireR2Credentials", () => {
  it("returns the three credentials when present", () => {
    const creds = requireR2Credentials({
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "akid",
      R2_SECRET_ACCESS_KEY: "secret",
    } as NodeJS.ProcessEnv);
    expect(creds).toEqual({ accountId: "acct", accessKeyId: "akid", secretAccessKey: "secret" });
  });

  it("throws listing the missing ones", () => {
    expect(() => requireR2Credentials({ R2_ACCOUNT_ID: "acct" } as NodeJS.ProcessEnv)).toThrow(
      /R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY/,
    );
  });

  it("does not leak secret values in the error", () => {
    expect(() =>
      requireR2Credentials({ R2_SECRET_ACCESS_KEY: "should-not-appear" } as NodeJS.ProcessEnv),
    ).toThrow(/^(?!.*should-not-appear).*$/);
  });
});

describe("buildObjectKey (AC-02)", () => {
  it("uses the documented {keyPrefix}/{env}/{YYYY-MM-DD}/db.sql.gz convention (UTC)", () => {
    const key = buildObjectKey(config, new Date("2026-06-04T03:05:00Z"), "scheduled");
    expect(key).toBe("acquia/prod/2026-06-04/db.sql.gz");
  });

  it("uses the UTC calendar day, not local time", () => {
    // 2026-06-04T23:30:00-05:00 is 2026-06-05T04:30Z → UTC day is the 5th.
    const key = buildObjectKey(config, new Date("2026-06-04T23:30:00-05:00"), "scheduled");
    expect(key).toBe("acquia/prod/2026-06-05/db.sql.gz");
  });
});

// #11: on-demand artifacts are distinguishable from scheduled ones by key.
describe("buildObjectKey — on-demand distinction (#11)", () => {
  it("nests on-demand runs under an on-demand/ segment with a full UTC timestamp", () => {
    const key = buildObjectKey(config, new Date("2026-06-13T21:08:59Z"), "on-demand");
    expect(key).toBe("acquia/prod/on-demand/2026-06-13T21-08-59Z/db.sql.gz");
  });

  it("appends a slugified label when one is given", () => {
    const key = buildObjectKey(config, new Date("2026-06-13T21:08:59Z"), "on-demand", "pre-deploy v2.3");
    expect(key).toBe("acquia/prod/on-demand/2026-06-13T21-08-59Z-pre-deploy-v2-3/db.sql.gz");
  });

  it("does not collide for two on-demand runs in the same UTC day", () => {
    const a = buildObjectKey(config, new Date("2026-06-13T09:00:00Z"), "on-demand");
    const b = buildObjectKey(config, new Date("2026-06-13T17:30:00Z"), "on-demand");
    expect(a).not.toBe(b);
  });

  it("keeps the on-demand/ marker so retention (#4) can glob include/exclude", () => {
    const scheduled = buildObjectKey(config, new Date("2026-06-13T03:00:00Z"), "scheduled");
    const onDemand = buildObjectKey(config, new Date("2026-06-13T21:08:59Z"), "on-demand");
    expect(scheduled).not.toContain("/on-demand/");
    expect(onDemand).toContain("/on-demand/");
  });
});

describe("slugifyLabel (#11)", () => {
  it("lowercases, collapses non-alphanumerics to dashes, and trims", () => {
    expect(slugifyLabel("Pre-Deploy v2.3!")).toBe("pre-deploy-v2-3");
  });

  it("returns empty for undefined or unusable input", () => {
    expect(slugifyLabel(undefined)).toBe("");
    expect(slugifyLabel("   ")).toBe("");
    expect(slugifyLabel("---")).toBe("");
  });

  it("caps the slug length", () => {
    expect(slugifyLabel("a".repeat(100)).length).toBeLessThanOrEqual(40);
  });
});

describe("assertUploadIntegrity (AC-03)", () => {
  it("passes when streamed, stored, and source sizes all agree", () => {
    expect(() => assertUploadIntegrity(1024, 1024, 1024)).not.toThrow();
  });

  it("passes when source length is unknown but streamed == stored", () => {
    expect(() => assertUploadIntegrity(2048, 2048, null)).not.toThrow();
  });

  it("rejects a zero-byte stored object", () => {
    expect(() => assertUploadIntegrity(0, 0, null)).toThrow(R2UploadError);
  });

  it("rejects a streamed/stored mismatch (truncation)", () => {
    expect(() => assertUploadIntegrity(1024, 512, null)).toThrow(/truncation/);
  });

  it("rejects when the source advertised a different length", () => {
    expect(() => assertUploadIntegrity(1024, 1024, 2048)).toThrow(/truncation/);
  });
});

// A fake transport that actually drains the piped stream (so the internal
// counter tallies real bytes), records how many it saw, and reports a stored
// size we control — letting us exercise the happy path and truncation without
// touching S3.
function fakeTransport(storedOverride?: (streamed: number) => number): {
  transport: R2Transport;
  streamed: () => number;
} {
  let streamed = 0;
  const transport: R2Transport = {
    async upload(_bucket, _key, body) {
      for await (const chunk of body) {
        streamed += (chunk as Buffer).length;
      }
    },
    async headSize() {
      return storedOverride ? storedOverride(streamed) : streamed;
    },
  };
  return { transport, streamed: () => streamed };
}

describe("streamBackupToR2 (AC-01 / AC-03 / AC-05)", () => {
  it("streams the body, verifies size, and returns key + stored size", async () => {
    const { transport } = fakeTransport();
    const body = Readable.from([Buffer.from("hello"), Buffer.from("world")]); // 10 bytes
    const result = await streamBackupToR2(
      { bucket: "acfbak-backups", key: "acquia/prod/2026-06-04/db.sql.gz", body, sourceContentLength: 10 },
      transport,
    );
    expect(result).toEqual({ key: "acquia/prod/2026-06-04/db.sql.gz", size: 10 });
  });

  it("throws R2UploadError when the stored size is short (truncation)", async () => {
    const { transport } = fakeTransport((streamed) => streamed - 1);
    const body = Readable.from([Buffer.from("0123456789")]);
    await expect(
      streamBackupToR2(
        { bucket: "b", key: "k", body, sourceContentLength: null },
        transport,
      ),
    ).rejects.toBeInstanceOf(R2UploadError);
  });

  it("throws R2UploadError on a zero-byte body", async () => {
    const { transport } = fakeTransport();
    const body = Readable.from([]);
    await expect(
      streamBackupToR2({ bucket: "b", key: "k", body, sourceContentLength: null }, transport),
    ).rejects.toBeInstanceOf(R2UploadError);
  });
});
