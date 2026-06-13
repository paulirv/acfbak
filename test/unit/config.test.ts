import { describe, it, expect } from "vitest";
import { validateConfig, ConfigError } from "../../src/config.ts";

const base = {
  acquia: { applicationName: "my-drupal-app", environment: "prod" },
  r2: { binding: "BACKUPS", bucket: "acfbak-backups" },
  schedule: { cron: "0 3 * * *" },
};

describe("validateConfig — notifications (#12)", () => {
  it("omits notifications when absent (callers default to console)", () => {
    const config = validateConfig(base);
    expect(config.notifications).toBeUndefined();
  });

  it("accepts an explicit console channel", () => {
    const config = validateConfig({ ...base, notifications: { channel: "console" } });
    expect(config.notifications).toEqual({ channel: "console" });
  });

  it("accepts a webhook channel", () => {
    const config = validateConfig({ ...base, notifications: { channel: "webhook" } });
    expect(config.notifications).toEqual({ channel: "webhook" });
  });

  it("defaults the channel to console when the block is present but empty", () => {
    const config = validateConfig({ ...base, notifications: {} });
    expect(config.notifications).toEqual({ channel: "console" });
  });

  it("rejects an unknown channel", () => {
    expect(() => validateConfig({ ...base, notifications: { channel: "carrier-pigeon" } })).toThrow(
      ConfigError,
    );
  });

  it("rejects a non-object notifications block", () => {
    expect(() => validateConfig({ ...base, notifications: "webhook" })).toThrow(ConfigError);
  });
});

describe("validateConfig — monitoring (#14)", () => {
  it("omits monitoring when absent (callers default to 26h)", () => {
    expect(validateConfig(base).monitoring).toBeUndefined();
  });

  it("accepts an explicit maxAgeHours", () => {
    const config = validateConfig({ ...base, monitoring: { maxAgeHours: 49 } });
    expect(config.monitoring).toEqual({ maxAgeHours: 49 });
  });

  it("defaults maxAgeHours to 26 when the block is present but empty", () => {
    const config = validateConfig({ ...base, monitoring: {} });
    expect(config.monitoring).toEqual({ maxAgeHours: 26 });
  });

  it("rejects a non-positive maxAgeHours", () => {
    expect(() => validateConfig({ ...base, monitoring: { maxAgeHours: 0 } })).toThrow(ConfigError);
    expect(() => validateConfig({ ...base, monitoring: { maxAgeHours: -5 } })).toThrow(ConfigError);
  });

  it("rejects a non-number maxAgeHours", () => {
    expect(() => validateConfig({ ...base, monitoring: { maxAgeHours: "26" } })).toThrow(ConfigError);
  });
});
