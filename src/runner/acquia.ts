/**
 * Acquia Cloud API v2 client — discover and retrieve the *latest existing*
 * database backup for a configured application + environment.
 *
 * Per docs/vision.md and #7: we do NOT trigger a fresh backup. We authenticate,
 * list the existing backups for the target DB, pick the most recent completed
 * one, and obtain a working download stream for it. The actual streaming into
 * R2 is the runner's job (#9); this module records the source metadata and
 * hands back a lazy `download()` so callers control when bytes start flowing.
 *
 * Host-agnostic by design: it depends only on the global `fetch`/`URL`/`Headers`
 * web APIs (available in Node 22+ and the Workers runtime), and `fetch` is
 * injectable so it can be unit-tested without network access. No node: imports.
 *
 * API contract (verified against the Cloud Platform API v2 / acquia-php-sdk-v2):
 *   token:    POST https://accounts.acquia.com/api/auth/oauth/token
 *   base:     https://cloud.acquia.com/api
 *   apps:     GET  /applications
 *   envs:     GET  /applications/{appUuid}/environments
 *   backups:  GET  /environments/{envUuid}/databases/{db}/backups
 *   download: GET  /environments/{envUuid}/databases/{db}/backups/{id}/actions/download
 */

/** Endpoint that exchanges an API key/secret for an OAuth 2.0 bearer token. */
export const ACQUIA_TOKEN_URL = "https://accounts.acquia.com/api/auth/oauth/token";
/** Base URI for all Cloud Platform API v2 resource calls. */
export const ACQUIA_API_BASE = "https://cloud.acquia.com/api";

/** A subset of the global `fetch` signature — all this module needs. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Acquia Cloud API token credentials (the "key"/"secret" pair from the UI). */
export interface AcquiaCredentials {
  key: string;
  secret: string;
}

/**
 * Metadata recorded for the source backup we selected (AC-05). This is the
 * durable record of *which* Acquia artifact a run pulled — enough to trace a
 * stored object back to its origin and to feed run history (#13).
 */
export interface BackupMetadata {
  /** Acquia backup id (numeric, unique within the environment+database). */
  id: number;
  /** Backup type as reported by Acquia (e.g. "daily", "ondemand"). */
  type: string;
  /** ISO-8601 timestamp the backup started, as reported by Acquia. */
  startedAt: string;
  /** ISO-8601 timestamp the backup completed (empty if not yet completed). */
  completedAt: string;
  /** Resolved environment UUID the backup belongs to. */
  environmentUuid: string;
  /** Database name the backup is for. */
  databaseName: string;
}

/** Base error for any Acquia client failure — clear, surfaced messages. */
export class AcquiaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcquiaError";
  }
}

/** Authentication failed (bad credentials, token endpoint rejected us). */
export class AcquiaAuthError extends AcquiaError {
  constructor(message: string) {
    super(message);
    this.name = "AcquiaAuthError";
  }
}

/** No backups exist for the requested environment + database (AC-04). */
export class AcquiaNoBackupsError extends AcquiaError {
  constructor(message: string) {
    super(message);
    this.name = "AcquiaNoBackupsError";
  }
}

/** A requested application or environment could not be resolved by name. */
export class AcquiaNotFoundError extends AcquiaError {
  constructor(message: string) {
    super(message);
    this.name = "AcquiaNotFoundError";
  }
}

/** Shape of the OAuth token response we rely on. */
interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/** A backup item as returned in `_embedded.items[]` by the backups list. */
interface RawBackup {
  id: number;
  type: string;
  started_at: string;
  completed_at: string | null;
  flags?: { deleted?: boolean };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pull `_embedded.items` out of a v2 collection response, defensively. */
function embeddedItems(payload: unknown): unknown[] {
  if (isRecord(payload) && isRecord(payload._embedded)) {
    const items = payload._embedded.items;
    if (Array.isArray(items)) return items;
  }
  return [];
}

/**
 * Exchange API key/secret for a short-lived bearer token (AC-01).
 * Throws {@link AcquiaAuthError} with a clear message on any non-200 response,
 * never echoing the secret.
 */
export async function getAccessToken(
  creds: AcquiaCredentials,
  fetchImpl: FetchLike,
): Promise<string> {
  if (!creds.key || !creds.secret) {
    throw new AcquiaAuthError("Acquia API key and secret are required to authenticate.");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.key,
    client_secret: creds.secret,
  });

  let res: Response;
  try {
    res = await fetchImpl(ACQUIA_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });
  } catch (err) {
    throw new AcquiaAuthError(
      `Network error contacting Acquia token endpoint: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    throw new AcquiaAuthError(
      `Acquia authentication failed (HTTP ${res.status}). ` +
        `Check ACQUIA_API_KEY / ACQUIA_API_SECRET.`,
    );
  }

  const json: unknown = await res.json();
  if (!isRecord(json) || typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new AcquiaAuthError("Acquia token endpoint returned no access_token.");
  }
  return (json as unknown as TokenResponse).access_token;
}

/**
 * Thin authenticated client over the Cloud Platform API v2. Construct via
 * {@link AcquiaClient.authenticate} (which fetches a token) or directly with an
 * existing bearer token.
 */
export class AcquiaClient {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly base: string;

  constructor(token: string, fetchImpl: FetchLike, base: string = ACQUIA_API_BASE) {
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.base = base;
  }

  /** Authenticate with key/secret and return a ready-to-use client. */
  static async authenticate(
    creds: AcquiaCredentials,
    fetchImpl: FetchLike,
    base: string = ACQUIA_API_BASE,
  ): Promise<AcquiaClient> {
    const token = await getAccessToken(creds, fetchImpl);
    return new AcquiaClient(token, fetchImpl, base);
  }

  /** Authenticated GET returning parsed JSON; surfaces HTTP errors clearly. */
  private async getJson(path: string): Promise<unknown> {
    const res = await this.request(path, { accept: "application/json" });
    if (res.status === 401 || res.status === 403) {
      throw new AcquiaAuthError(
        `Acquia API rejected the access token (HTTP ${res.status}) for ${path}.`,
      );
    }
    if (!res.ok) {
      throw new AcquiaError(`Acquia API request failed (HTTP ${res.status}) for ${path}.`);
    }
    return res.json();
  }

  /** Low-level authenticated request; callers decide how to read the body. */
  async request(path: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      ...extraHeaders,
    };
    return this.fetchImpl(`${this.base}${path}`, { method: "GET", headers });
  }

  /**
   * Resolve an application UUID from its name (or accept a UUID as-is).
   * Throws {@link AcquiaNotFoundError} when no application matches.
   */
  async findApplicationUuid(applicationName: string): Promise<string> {
    const payload = await this.getJson("/applications");
    const items = embeddedItems(payload);
    for (const item of items) {
      if (!isRecord(item)) continue;
      if (item.uuid === applicationName || item.name === applicationName) {
        if (typeof item.uuid === "string") return item.uuid;
      }
    }
    throw new AcquiaNotFoundError(
      `No Acquia application matching "${applicationName}" (checked name and uuid).`,
    );
  }

  /**
   * Resolve an environment UUID within an application from its name
   * (e.g. "prod"). Throws {@link AcquiaNotFoundError} when none matches.
   */
  async findEnvironmentUuid(applicationUuid: string, environmentName: string): Promise<string> {
    const payload = await this.getJson(`/applications/${applicationUuid}/environments`);
    const items = embeddedItems(payload);
    for (const item of items) {
      if (!isRecord(item)) continue;
      if (item.uuid === environmentName || item.name === environmentName) {
        if (typeof item.uuid === "string") return item.uuid;
      }
    }
    throw new AcquiaNotFoundError(
      `No environment named "${environmentName}" in application ${applicationUuid}.`,
    );
  }

  /**
   * List all database backups for an environment + database (AC-02 input).
   * Returns the raw items in API order; selection is a separate, testable step.
   */
  async listBackups(environmentUuid: string, databaseName: string): Promise<RawBackup[]> {
    const payload = await this.getJson(
      `/environments/${environmentUuid}/databases/${databaseName}/backups`,
    );
    const items = embeddedItems(payload);
    const backups: RawBackup[] = [];
    for (const item of items) {
      if (!isRecord(item)) continue;
      if (typeof item.id !== "number") continue;
      backups.push({
        id: item.id,
        type: typeof item.type === "string" ? item.type : "unknown",
        started_at: typeof item.started_at === "string" ? item.started_at : "",
        completed_at: typeof item.completed_at === "string" ? item.completed_at : null,
        flags: isRecord(item.flags) ? { deleted: item.flags.deleted === true } : undefined,
      });
    }
    return backups;
  }
}

/**
 * Select the most recent *completed* backup from a list (AC-02). Deleted
 * backups and those without a completion time are ignored — a backup that has
 * not finished is not a restorable artifact. Throws {@link AcquiaNoBackupsError}
 * when nothing usable remains (AC-04).
 */
export function selectLatestBackup(
  backups: RawBackup[],
  environmentUuid: string,
  databaseName: string,
): BackupMetadata {
  const usable = backups.filter((b) => !b.flags?.deleted && b.completed_at);
  if (usable.length === 0) {
    throw new AcquiaNoBackupsError(
      `No completed Acquia backups found for ${databaseName} in environment ${environmentUuid}.`,
    );
  }

  // Most recent by completion time; Date.parse on ISO-8601 is stable here and
  // avoids depending on API ordering.
  let latest = usable[0] as RawBackup;
  let latestMs = Date.parse(latest.completed_at as string);
  for (const b of usable) {
    const ms = Date.parse(b.completed_at as string);
    if (Number.isFinite(ms) && ms > latestMs) {
      latest = b;
      latestMs = ms;
    }
  }

  return {
    id: latest.id,
    type: latest.type,
    startedAt: latest.started_at,
    completedAt: latest.completed_at as string,
    environmentUuid,
    databaseName,
  };
}
