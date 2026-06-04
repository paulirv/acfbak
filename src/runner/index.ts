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
 * Entry point. For the scaffold this validates config + secrets and reports
 * what it *would* transfer; the Acquia-pull → R2-stream implementation lands
 * in the scheduled-backup requirements.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  requireSecrets();

  console.log(
    `[acfbak runner] ready — would pull latest backup for ` +
      `${config.acquia.applicationName}/${config.acquia.environment} ` +
      `and stream to r2://${config.r2.bucket}/${config.r2.keyPrefix}`,
  );
  // TODO(#1): pull Acquia's latest backup and stream it into R2.
}

// Run only when invoked directly (`npm run runner`), not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error("[acfbak runner] failed:", err);
    process.exit(1);
  });
}
