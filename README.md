# acfbak — Acquia → Cloudflare R2 backup

acfbak gives Drupal sites on **Acquia Cloud** an independent, off-platform safety net: it captures the production database on a schedule (and on demand) and stores it in a **Cloudflare R2** bucket you control. Recovery never depends on a single vendor's retention window or console.

See [`docs/vision.md`](docs/vision.md) for the full product vision.

## Architecture

> **The Worker orchestrates; the runner transfers.**

- **Worker** (`src/worker/`) — a Cloudflare Worker on a [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/). It owns the schedule, decides when a backup runs, holds the R2 binding (`env.BACKUPS`), and owns alerting. It does *not* move large dumps itself.
- **Runner** (`src/runner/`) — a host-agnostic Node process that does the heavy byte transfer: it pulls Acquia's most recent existing backup and streams it into R2. Where it runs (GitHub Actions vs. container) is an open question tracked in the vision.
- **Config** — declarative and version-controlled (see below).

## Configuration

Two declarative sources, each authoritative for its own concern:

| File | Owns | Notes |
|------|------|-------|
| [`acfbak.config.json`](acfbak.config.json) | Acquia source (`applicationName`, `environment`, `database`), R2 destination (`bucket`, `binding`, `keyPrefix`), and the `schedule` | Validated against [`acfbak.config.schema.json`](acfbak.config.schema.json) at load; misconfiguration fails loud. |
| [`wrangler.toml`](wrangler.toml) | The **Cloudflare platform** truth: the cron trigger and the `[[r2_buckets]]` binding | Authoritative for the platform. Keep its `crons` in sync with `acfbak.config.json` `schedule.cron`. |

Edit `acfbak.config.json` to point at your Acquia app/environment and your R2 bucket. The R2 `binding`/`bucket` must match the `[[r2_buckets]]` entry in `wrangler.toml`.

## Secrets

**No credentials are ever committed.** `.env` and `.dev.vars` are gitignored; only the `*.example` templates are tracked. The repo contains no secret material.

### Required secrets

| Secret | Used by | Purpose |
|--------|---------|---------|
| `ACQUIA_API_KEY` | Worker + runner | Acquia Cloud API key — locate the backup to pull. |
| `ACQUIA_API_SECRET` | Worker + runner | Acquia Cloud API secret. |
| `R2_ACCOUNT_ID` | runner | Cloudflare account ID (R2 S3-compatible endpoint). |
| `R2_ACCESS_KEY_ID` | runner | R2 API token access key (Object Read & Write). |
| `R2_SECRET_ACCESS_KEY` | runner | R2 API token secret. |

The Worker writes to R2 through its **binding** (`env.BACKUPS`), so it does not need the R2 S3 keys — those are only for the runner, which writes from outside Cloudflare.

### Setting secrets

**Worker (production)** — set as [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/), never in `wrangler.toml`:

```bash
wrangler secret put ACQUIA_API_KEY
wrangler secret put ACQUIA_API_SECRET
```

**Worker (local dev)** — copy the template and fill it in (the file is gitignored):

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars
```

**Runner** — supply as environment variables, via a local `.env` or as CI/job secrets (e.g. GitHub Actions secrets):

```bash
cp .env.example .env
# edit .env
```

If a required secret is missing, both the Worker (`requireAcquiaSecrets`) and the runner (`requireSecrets`) fail loudly rather than running half-configured.

## Development

```bash
npm install
npm run dev         # wrangler dev — local Worker + local R2 on http://localhost:8787
npm test            # vitest, run inside the Workers runtime (local R2, no account needed)
npm run typecheck   # tsc --noEmit (strict)
npm run runner      # run the transfer runner skeleton locally
```

Quick checks against a running dev server:

```bash
curl http://localhost:8787/health   # status + config summary (+ acquiaSecretsConfigured, never values)
curl http://localhost:8787/smoke    # writes & reads back a tiny object → proves the R2 binding
```

This project ships a [`dev.json`](dev.json) manifest, so `dev-up` (and warp-drive) can bring the environment up automatically — there's no database, so it only manages the Worker dev server.

## Deployment

```bash
# One-time: create the destination bucket.
wrangler r2 bucket create acfbak-backups

# Set production secrets (see above), then deploy.
wrangler deploy
```

The cron trigger in `wrangler.toml` schedules the orchestrator; the runner is deployed/scheduled on its chosen host (TBD per the vision).

## Project layout

```
acfbak.config.json          declarative config (Acquia source, R2 dest, schedule)
acfbak.config.schema.json   JSON Schema for the above
wrangler.toml               Cloudflare platform manifest (cron + R2 binding)
dev.json                    dev-environment manifest (dev-up / warp-drive)
src/config.ts               shared config types + validator (env-agnostic)
src/worker/index.ts         orchestrator Worker (scheduled + fetch handlers)
src/runner/index.ts         transfer runner skeleton
test/r2-smoke.test.ts       R2 binding smoke test + secret-hygiene test
```

## Status

Early scaffold (capability [#1](https://github.com/paulirv/acfbak/issues/1)). The Acquia-pull → R2-stream transfer is stubbed (`TODO(#1)`); the scheduling, config, secret handling, and R2 binding are wired and tested.
