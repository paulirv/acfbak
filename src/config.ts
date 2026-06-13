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

/** Where per-run success/failure notifications are sent (#12). */
export type NotificationChannel = "console" | "webhook";

export interface NotificationSettings {
  /**
   * Notification channel. "console" (default) logs the terminal signal to
   * stdout/stderr; "webhook" additionally POSTs a `{ text }` payload to the
   * `NOTIFY_WEBHOOK_URL` secret (Slack-compatible; relays cover Telegram/email).
   */
  channel: NotificationChannel;
}

export interface AcfbakConfig {
  acquia: AcquiaSource;
  r2: R2Destination;
  schedule: BackupSchedule;
  /** Per-run notifications. Optional; defaults to the console channel. */
  notifications?: NotificationSettings;
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
    ...validateNotifications(raw.notifications),
  };
}

/**
 * Validate the optional `notifications` block (#12). Absent ⇒ omitted from the
 * config (callers default to the console channel). Present ⇒ `channel` must be
 * one of the known values. Returns a partial so the field is only set when
 * configured, keeping the default implicit.
 */
function validateNotifications(raw: unknown): Pick<AcfbakConfig, "notifications"> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new ConfigError('"notifications" must be an object when present');

  const channel = optionalString(raw, "channel", "notifications.channel", "console");
  if (channel !== "console" && channel !== "webhook") {
    throw new ConfigError(
      `"notifications.channel" must be "console" or "webhook" (got "${channel}")`,
    );
  }
  return { notifications: { channel } };
}
