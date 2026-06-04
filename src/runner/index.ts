/**
 * acfbak runner — transfer worker (skeleton).
 *
 * Role (per docs/vision.md "Worker orchestrates, runner transfers"):
 *   - performs the heavy byte transfer that the Worker is too constrained for
 *   - pulls Acquia's most recent existing backup for the configured app/env
 *   - streams that dump into the configured R2 bucket (S3-compatible API)
 *
 * Where this runs (GitHub Actions vs. container) is an open question in the
 * vision; this skeleton is host-agnostic and reads everything it needs from
 * the declarative config + environment secrets.
 *
 * Secrets (never committed — see .env.example / README):
 *   ACQUIA_API_KEY, ACQUIA_API_SECRET        — pull the dump from Acquia Cloud
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
 *   R2_SECRET_ACCESS_KEY                      — write the dump to R2 via S3 API
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { validateConfig, type AcfbakConfig } from "../config.ts";
import { discoverLatestBackup, AcquiaError, type AcquiaCredentials } from "./acquia.ts";

const REQUIRED_SECRETS = [
  "ACQUIA_API_KEY",
  "ACQUIA_API_SECRET",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
] as const;

/** Load and validate acfbak.config.json from the repo root. */
export function loadConfig(configPath?: string): AcfbakConfig {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = configPath ?? resolve(here, "../../acfbak.config.json");
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return validateConfig(raw);
}

/** Assert all required runner secrets are present; fail loud if not. */
export function requireSecrets(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const missing = REQUIRED_SECRETS.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required runner secret(s): ${missing.join(", ")}. ` +
        `See .env.example and the README "Secrets" section.`,
    );
  }
  return Object.fromEntries(REQUIRED_SECRETS.map((name) => [name, env[name] as string]));
}

/**
 * Assert the Acquia credentials are present and return them as the
 * {@link AcquiaCredentials} the client expects. The Acquia pull (this step,
 * #7) needs only these; the R2 secrets are required when the dump is streamed
 * to R2 (#9). Fails loud with a clear message, never echoing the values.
 */
export function requireAcquiaCredentials(
  env: NodeJS.ProcessEnv = process.env,
): AcquiaCredentials {
  const key = env.ACQUIA_API_KEY;
  const secret = env.ACQUIA_API_SECRET;
  if (!key || !secret) {
    const missing = [!key && "ACQUIA_API_KEY", !secret && "ACQUIA_API_SECRET"].filter(Boolean);
    throw new Error(
      `Missing required Acquia secret(s): ${missing.join(", ")}. ` +
        `See .env.example and the README "Secrets" section.`,
    );
  }
  return { key, secret };
}

/**
 * Entry point (#7). Discovers the latest existing Acquia backup for the
 * configured app/env, records its source metadata for the run, and confirms a
 * working download stream can be obtained. Streaming that download into R2 is
 * the next step (#9): here we open the download to prove it works, then release
 * the stream without consuming the (potentially multi-GB) body.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const creds = requireAcquiaCredentials();

  const latest = await discoverLatestBackup(config, creds);
  const { metadata } = latest;

  // Record the source backup's metadata for the run (AC-05).
  console.log(
    `[acfbak runner] selected Acquia backup id=${metadata.id} type=${metadata.type} ` +
      `started=${metadata.startedAt} completed=${metadata.completedAt} ` +
      `env=${metadata.environmentUuid} db=${metadata.databaseName}`,
  );

  // Obtain a working download stream/URL for that artifact (AC-03).
  const download = await latest.openDownload();
  const size = download.contentLength !== null ? `${download.contentLength} bytes` : "unknown size";
  console.log(`[acfbak runner] download ready (${size}) — dest r2://${config.r2.bucket}/${config.r2.keyPrefix}`);

  // #9 streams `download.body` to R2. For #7 we only confirm obtainability, so
  // release the stream to avoid pulling the full dump.
  await download.body?.cancel();
}

// Run only when invoked directly (`npm run runner`), not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err: unknown) => {
    // Surface our own typed failures (auth, no-backups, not-found) as a clean,
    // actionable message; anything else prints in full for debugging (AC-04).
    if (err instanceof AcquiaError) {
      console.error(`[acfbak runner] failed: ${err.name}: ${err.message}`);
    } else {
      console.error("[acfbak runner] failed:", err);
    }
    process.exit(1);
  });
}
