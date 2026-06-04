/**
 * acfbak declarative configuration — shared types + runtime validation.
 *
 * This module is environment-agnostic (no node: or Workers imports) so it can
 * be used from both the Worker (which bundles acfbak.config.json at build time)
 * and the runner (which reads the file at runtime). Each caller supplies the
 * parsed JSON; validateConfig enforces the shape defined in
 * acfbak.config.schema.json.
 */

export interface AcquiaSource {
  /** Acquia Cloud application (subscription) name or UUID. */
  applicationName: string;
  /** Acquia environment to back up (e.g. prod, test, dev). */
  environment: string;
  /** Database name within the environment. Defaults to "default". */
  database: string;
}

export interface R2Destination {
  /** Worker env binding name (wrangler.toml [[r2_buckets]].binding). */
  binding: string;
  /** R2 bucket name (wrangler.toml [[r2_buckets]].bucket_name). */
  bucket: string;
  /** Object key prefix under which backups are stored. */
  keyPrefix: string;
}

export interface BackupSchedule {
  /** Cron expression for the scheduled backup (UTC). */
  cron: string;
  /** Documentation-only timezone label. */
  timezone: string;
}

export interface AcfbakConfig {
  acquia: AcquiaSource;
  r2: R2Destination;
  schedule: BackupSchedule;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`acfbak.config.json: ${message}`);
    this.name = "ConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`"${path}" is required and must be a non-empty string`);
  }
  return value;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  fallback: string,
): string {
  const value = obj[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`"${path}" must be a non-empty string when present`);
  }
  return value;
}

/**
 * Validate and normalize raw parsed config, applying schema defaults.
 * Throws ConfigError on any structural problem so misconfiguration fails loud
 * (Product Principle: "fails loudly, never silently").
 */
export function validateConfig(raw: unknown): AcfbakConfig {
  if (!isRecord(raw)) {
    throw new ConfigError("top-level value must be an object");
  }

  if (!isRecord(raw.acquia)) throw new ConfigError('"acquia" is required and must be an object');
  if (!isRecord(raw.r2)) throw new ConfigError('"r2" is required and must be an object');
  if (!isRecord(raw.schedule)) {
    throw new ConfigError('"schedule" is required and must be an object');
  }

  return {
    acquia: {
      applicationName: requireString(raw.acquia, "applicationName", "acquia.applicationName"),
      environment: requireString(raw.acquia, "environment", "acquia.environment"),
      database: optionalString(raw.acquia, "database", "acquia.database", "default"),
    },
    r2: {
      binding: requireString(raw.r2, "binding", "r2.binding"),
      bucket: requireString(raw.r2, "bucket", "r2.bucket"),
      keyPrefix: optionalString(raw.r2, "keyPrefix", "r2.keyPrefix", "acquia"),
    },
    schedule: {
      cron: requireString(raw.schedule, "cron", "schedule.cron"),
      timezone: optionalString(raw.schedule, "timezone", "schedule.timezone", "UTC"),
    },
  };
}
