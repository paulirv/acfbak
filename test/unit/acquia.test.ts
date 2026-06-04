import { describe, it, expect } from "vitest";
import {
  getAccessToken,
  selectLatestBackup,
  AcquiaClient,
  AcquiaAuthError,
  AcquiaNoBackupsError,
  AcquiaNotFoundError,
  ACQUIA_TOKEN_URL,
  type FetchLike,
} from "../../src/runner/acquia.ts";

// A tiny fetch double: route by URL substring to a canned JSON response (or a
// status-only response). Keeps tests offline and deterministic — the Acquia
// client only depends on the injected fetch.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function routerFetch(routes: Array<{ match: string; respond: () => Response }>): FetchLike {
  return async (input: string) => {
    const route = routes.find((r) => input.includes(r.match));
    if (!route) throw new Error(`unexpected fetch: ${input}`);
    return route.respond();
  };
}

describe("getAccessToken (AC-01)", () => {
  it("returns the access_token on success", async () => {
    const fetchImpl = routerFetch([
      { match: ACQUIA_TOKEN_URL, respond: () => jsonResponse({ access_token: "tok-123" }) },
    ]);
    const token = await getAccessToken({ key: "k", secret: "s" }, fetchImpl);
    expect(token).toBe("tok-123");
  });

  it("throws AcquiaAuthError on a 401 from the token endpoint", async () => {
    const fetchImpl = routerFetch([
      { match: ACQUIA_TOKEN_URL, respond: () => jsonResponse({ error: "invalid_client" }, 401) },
    ]);
    await expect(getAccessToken({ key: "k", secret: "bad" }, fetchImpl)).rejects.toBeInstanceOf(
      AcquiaAuthError,
    );
  });

  it("throws AcquiaAuthError when credentials are missing", async () => {
    const never: FetchLike = async () => {
      throw new Error("should not be called");
    };
    await expect(getAccessToken({ key: "", secret: "" }, never)).rejects.toBeInstanceOf(
      AcquiaAuthError,
    );
  });

  it("never leaks the secret in the auth error message", async () => {
    const fetchImpl = routerFetch([
      { match: ACQUIA_TOKEN_URL, respond: () => jsonResponse({}, 403) },
    ]);
    await expect(
      getAccessToken({ key: "k", secret: "super-secret-value" }, fetchImpl),
    ).rejects.toSatisfy((e: unknown) => e instanceof Error && !e.message.includes("super-secret-value"));
  });
});

describe("AcquiaClient resolution (AC-02 setup)", () => {
  const fetchImpl = routerFetch([
    {
      match: "/applications/app-uuid/environments",
      respond: () =>
        jsonResponse({
          _embedded: {
            items: [
              { uuid: "env-dev", name: "dev" },
              { uuid: "env-prod", name: "prod" },
            ],
          },
        }),
    },
    {
      match: "/applications",
      respond: () =>
        jsonResponse({
          _embedded: {
            items: [
              { uuid: "app-uuid", name: "my-drupal-app" },
              { uuid: "other-uuid", name: "other-app" },
            ],
          },
        }),
    },
  ]);
  const client = new AcquiaClient("tok", fetchImpl);

  it("resolves an application uuid from its name", async () => {
    expect(await client.findApplicationUuid("my-drupal-app")).toBe("app-uuid");
  });

  it("accepts a uuid passed directly as the application identifier", async () => {
    expect(await client.findApplicationUuid("other-uuid")).toBe("other-uuid");
  });

  it("throws AcquiaNotFoundError for an unknown application", async () => {
    await expect(client.findApplicationUuid("nope")).rejects.toBeInstanceOf(AcquiaNotFoundError);
  });

  it("resolves an environment uuid by name", async () => {
    expect(await client.findEnvironmentUuid("app-uuid", "prod")).toBe("env-prod");
  });

  it("throws AcquiaNotFoundError for an unknown environment", async () => {
    await expect(client.findEnvironmentUuid("app-uuid", "staging")).rejects.toBeInstanceOf(
      AcquiaNotFoundError,
    );
  });
});

describe("AcquiaClient.listBackups + auth handling", () => {
  it("parses backup items out of the _embedded envelope", async () => {
    const fetchImpl = routerFetch([
      {
        match: "/backups",
        respond: () =>
          jsonResponse({
            _embedded: {
              items: [
                { id: 1, type: "daily", started_at: "2026-06-01T03:00:00Z", completed_at: "2026-06-01T03:05:00Z" },
                { id: 2, type: "ondemand", started_at: "2026-06-02T10:00:00Z", completed_at: "2026-06-02T10:04:00Z" },
              ],
            },
          }),
      },
    ]);
    const client = new AcquiaClient("tok", fetchImpl);
    const backups = await client.listBackups("env-prod", "default");
    expect(backups).toHaveLength(2);
    expect(backups[0]?.id).toBe(1);
    expect(backups[1]?.type).toBe("ondemand");
  });

  it("surfaces a rejected token as AcquiaAuthError", async () => {
    const fetchImpl = routerFetch([{ match: "/backups", respond: () => jsonResponse({}, 401) }]);
    const client = new AcquiaClient("expired", fetchImpl);
    await expect(client.listBackups("env-prod", "default")).rejects.toBeInstanceOf(AcquiaAuthError);
  });
});

describe("selectLatestBackup (AC-02 / AC-04 / AC-05)", () => {
  const env = "env-prod";
  const db = "default";

  it("picks the backup with the most recent completed_at, ignoring API order", () => {
    const meta = selectLatestBackup(
      [
        { id: 1, type: "daily", started_at: "2026-06-01T03:00:00Z", completed_at: "2026-06-01T03:05:00Z" },
        { id: 3, type: "daily", started_at: "2026-06-03T03:00:00Z", completed_at: "2026-06-03T03:05:00Z" },
        { id: 2, type: "daily", started_at: "2026-06-02T03:00:00Z", completed_at: "2026-06-02T03:05:00Z" },
      ],
      env,
      db,
    );
    expect(meta.id).toBe(3);
    expect(meta.completedAt).toBe("2026-06-03T03:05:00Z");
    expect(meta.environmentUuid).toBe(env);
    expect(meta.databaseName).toBe(db);
  });

  it("ignores incomplete (no completed_at) and deleted backups", () => {
    const meta = selectLatestBackup(
      [
        { id: 10, type: "daily", started_at: "2026-06-05T03:00:00Z", completed_at: null },
        { id: 11, type: "daily", started_at: "2026-06-04T03:00:00Z", completed_at: "2026-06-04T03:05:00Z", flags: { deleted: true } },
        { id: 12, type: "daily", started_at: "2026-06-01T03:00:00Z", completed_at: "2026-06-01T03:05:00Z" },
      ],
      env,
      db,
    );
    expect(meta.id).toBe(12);
  });

  it("throws AcquiaNoBackupsError when no usable backup exists (AC-04)", () => {
    expect(() =>
      selectLatestBackup(
        [{ id: 1, type: "daily", started_at: "2026-06-01T03:00:00Z", completed_at: null }],
        env,
        db,
      ),
    ).toThrow(AcquiaNoBackupsError);
  });

  it("throws AcquiaNoBackupsError on an empty list", () => {
    expect(() => selectLatestBackup([], env, db)).toThrow(AcquiaNoBackupsError);
  });
});
