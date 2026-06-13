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
| `TRIGGER_TOKEN` | Worker | Gates the manual `POST /trigger` endpoint (unset ⇒ disabled). |
| `CF_ACCOUNT_ID` | runner (`--consume`) | Cloudflare account ID (same account as `R2_ACCOUNT_ID`). |
| `CF_API_TOKEN` | runner (`--consume`) | API token with **Queues** read + edit — pull/ack handoff messages. |
| `CF_QUEUE_ID` | runner (`--consume`) | Handoff queue id (UUID) — `wrangler queues list`. |
| `NOTIFY_WEBHOOK_URL` | runner | Webhook for per-run notifications. Only needed when `notifications.channel = "webhook"`. |

The Worker writes to R2 through its **binding** (`env.BACKUPS`), so it does not need the R2 S3 keys — those are only for the runner, which writes from outside Cloudflare. The `CF_*` secrets are only needed for the queue-driven consumer (`npm run runner -- --consume`); `NOTIFY_WEBHOOK_URL` only when the webhook notification channel is selected.

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

If a required secret is missing, both the Worker (`requireAcquiaSecrets`) and the runner (`requireAcquiaCredentials` for the Acquia pull, `requireR2Credentials` for the R2 write) fail loudly rather than running half-configured.

## Development

```bash
npm install
npm run dev         # wrangler dev — local Worker + local R2 on http://localhost:8787
npm test            # vitest workspace: unit (Node) + worker (Miniflare, local R2)
npm run typecheck   # tsc --noEmit (strict)
npm run runner      # discover the latest Acquia backup and confirm the download
```

Tests are split into two vitest projects (see [`vitest.workspace.ts`](vitest.workspace.ts)): `test/unit/**` runs pure-logic tests in plain Node (the Acquia client injects `fetch`, so it needs no network or account), and `test/worker/**` runs binding-integration tests inside the Workers runtime via Miniflare.

With Acquia **and** R2 credentials configured, `npm run runner` authenticates, lists the configured environment's database backups, selects the most recent completed one, then streams that dump straight into R2 under a dated key (`{keyPrefix}/{env}/{YYYY-MM-DD}/db.sql.gz`) via a multipart upload — the bytes are never fully buffered, so multi-GB dumps stay within bounded memory. It verifies the stored object size against what was streamed (rejecting zero-byte or truncated results) and prints the destination key and size.

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

# One-time: create the handoff queue and attach an HTTP pull consumer.
wrangler queues create acfbak-backup-jobs
wrangler queues consumer http add acfbak-backup-jobs

# Set production secrets (see above), then deploy.
wrangler deploy
```

The cron trigger in `wrangler.toml` schedules the orchestrator Worker.

### Scheduling & Worker→runner handoff

The Worker owns timing only. On each scheduled run (and on an on-demand trigger)
it mints a `runId`, enqueues a **run context** (`runId`, `trigger` origin, target
environment, destination key, …) onto the `acfbak-backup-jobs` Cloudflare Queue,
and logs the run start. The runner — an external Node process, not a Worker —
consumes the queue via the Queues **HTTP pull** API, performs the Acquia→R2
transfer, and acknowledges the message. The Worker is declared as the queue
*producer* in `wrangler.toml`; the pull consumer is configured out-of-band (see
the deploy commands above).

### On-demand backups

Backups also run **on demand**, not only on the cron schedule
([#10](https://github.com/paulirv/acfbak/issues/10)). The on-demand path is the
authenticated `POST /trigger` endpoint — a first-class backup trigger, not a
divergent code path: it enqueues the **exact same** run context the scheduled
handler does (`enqueueBackupRun`), so there is a single trusted pipeline. Each
run is marked with its origin (`trigger: "scheduled"` or `"on-demand"`) so the
two are distinguishable in logs and the handoff message.

Set the `TRIGGER_TOKEN` secret (unset ⇒ the endpoint is disabled, `503`) and POST
with the matching token header. An optional **label/reason** can be attached —
via a `?label=` query param or a JSON body — and is folded into the object key:

```bash
# Bare on-demand backup:
curl -X POST https://<worker-host>/trigger -H "x-acfbak-token: $TRIGGER_TOKEN"
# → { "triggered": true, "runId": "…", "trigger": "on-demand",
#     "destinationKey": "acquia/prod/on-demand/2026-06-13T21-08-59Z/db.sql.gz" }

# Labelled (e.g. a pre-deploy snapshot):
curl -X POST "https://<worker-host>/trigger" \
  -H "x-acfbak-token: $TRIGGER_TOKEN" -H "content-type: application/json" \
  -d '{"label":"pre-deploy v2.3"}'
# → destinationKey: "acquia/prod/on-demand/2026-06-13T21-08-59Z-pre-deploy-v2-3/db.sql.gz"
```

The endpoint is access-controlled — token-gated and fail-closed (non-`POST` ⇒
`405`, missing or wrong token ⇒ `401`) — so it can't be invoked anonymously. The
minted `runId` correlates the Worker log, the runner log, and the R2 artifact.

#### Object-key convention (and retention)

The destination key encodes the run's origin so on-demand copies are
distinguishable from scheduled ones in R2 ([#11](https://github.com/paulirv/acfbak/issues/11)):

| Origin | Key | Notes |
|--------|-----|-------|
| **scheduled** | `{keyPrefix}/{env}/{YYYY-MM-DD}/db.sql.gz` | One per UTC day — the canonical daily slot. |
| **on-demand** | `{keyPrefix}/{env}/on-demand/{YYYY-MM-DDTHH-MM-SSZ}[-{label}]/db.sql.gz` | Nested under `on-demand/`; full second-precision timestamp + optional label slug, so repeated manual runs never collide. |

The `on-demand/` path segment is the **retention marker**: when retention
([#4](https://github.com/paulirv/acfbak/issues/4)) lands it can include or
exclude on-demand copies intentionally by globbing `*/on-demand/*` — e.g. expire
scheduled dailies on a rolling window while keeping (or separately pruning)
pre-deploy snapshots. A standalone `npm run runner` writes the **scheduled**
daily key on purpose (it's a direct dev/recovery transfer to the standard slot),
distinct from the product's on-demand `/trigger` path.

#### Running the consumer

The runner consumes the queue with the `CF_*` secrets above (the API token needs
the **Queues** permission, read + edit):

```bash
npm run runner -- --consume
```

This performs one **drain pass**: it pulls a batch, runs the transfer for each
message to that message's destination key, acks the successes, and marks any
failures for retry (the queue redelivers them). One-shot by design — run it on a
schedule on the runner host (e.g. a cron job / CI workflow), or wrap it in a loop
for an always-on consumer. A bare `npm run runner` instead does a single
standalone transfer under today's dated key without touching the queue, and
`npm run runner -- --history` prints recent run records (see [Run history](#run-history)).

### Per-run notifications

Every backup run emits **exactly one terminal signal** — success or failure — so
a failed backup is surfaced before the next scheduled run rather than passing
silently ([#12](https://github.com/paulirv/acfbak/issues/12)):

- **success** reports the destination key, verified artifact size, and timestamp;
- **failure** reports the run id, the failing **stage** (`discover` → `download` →
  `transfer`), an error summary, and timestamp.

The channel is declarative — set `notifications.channel` in `acfbak.config.json`:

| Channel | Behaviour | Secret |
|---------|-----------|--------|
| `console` (default) | Logs the signal to stdout (success) / stderr (failure). | — |
| `webhook` | Also POSTs a Slack-compatible `{ "text": … }` payload. | `NOTIFY_WEBHOOK_URL` |

```jsonc
// acfbak.config.json
"notifications": { "channel": "webhook" }
```

The Slack-compatible payload reaches Slack directly, or Telegram/email through a
webhook relay. Webhook delivery is **best-effort**: a delivery error is logged
but never flips a run's real outcome, and the console record is always written
too. Selecting `webhook` without `NOTIFY_WEBHOOK_URL` fails loud at startup
(before any transfer), so a misconfiguration can't cause a silent run.

### Run history

Beyond the per-run notification, every run **appends a durable record** so an
operator can audit backup health over time ([#13](https://github.com/paulirv/acfbak/issues/13)).
Each record captures the run id, trigger (`scheduled` / `on-demand`), outcome,
size, duration, Acquia source backup id, destination key, and timestamp.

The store is **append-only in R2** — one small JSON object per run, no database:

```
{keyPrefix}/_history/{YYYY-MM}/{timestamp}-{runId}.json
```

Per-run objects (rather than a single shared manifest) avoid a read-modify-write
race; the month shard + timestamp prefix keep listings bounded and chronological.
Recording is best-effort — a history-write failure is logged but never flips the
backup's real outcome.

Retrieve the most recent runs (default 20) with the runner:

```bash
npm run runner -- --history        # last 20 runs, newest first
npm run runner -- --history 50     # last 50
```

This is read-only (no transfer) and needs only the R2 credentials. `list` scans
the newest month shards until it has enough records, so a long history never
forces a full-bucket listing.

### Missed-run detection

A run that **never happened** erodes recovery confidence silently — there is no
failure to notify on. The heartbeat check catches that gap
([#14](https://github.com/paulirv/acfbak/issues/14)): it inspects the run history
and, if no *successful* backup landed within the expected window, raises an alert
through the **same** notification channel as a failed run.

```bash
npm run runner -- --check-heartbeat
```

Set the window in `acfbak.config.json` — the schedule interval plus a grace
margin:

```jsonc
// acfbak.config.json — daily backup, 2h grace (defaults to 26 if omitted)
"monitoring": { "maxAgeHours": 26 }
```

**Schedule it independently of the backup.** A dead Worker can't alert on its own
absence, so run the check on the **runner host's cron** (separate from the Worker
that runs the backup), at least once per backup cycle — then a miss surfaces
before the next scheduled run. The command exits non-zero on a miss, so a cron
mailer or uptime monitor catches it as a second, independent signal.

## Project layout

```
acfbak.config.json          declarative config (Acquia source, R2 dest, schedule)
acfbak.config.schema.json   JSON Schema for the above
wrangler.toml               Cloudflare platform manifest (cron + R2 binding + queue)
dev.json                    dev-environment manifest (dev-up / warp-drive)
vitest.workspace.ts         vitest projects: unit (Node) + worker (Miniflare)
src/config.ts               shared config types + validator (env-agnostic)
src/run.ts                  shared run-context + object-key convention (Worker ↔ runner)
src/notify.ts               per-run notification events + console/webhook channels (env-agnostic)
src/history.ts              run-history record shape + key convention + store contract (env-agnostic)
src/monitor.ts              missed-run heartbeat check over the history (env-agnostic)
src/worker/index.ts         orchestrator Worker (scheduled + fetch handlers, queue producer)
src/runner/index.ts         transfer runner entry (transfer + --consume + --history + --check-heartbeat)
src/runner/acquia.ts        Acquia Cloud API v2 client (auth, list, select, download)
src/runner/r2.ts            R2 S3-compatible streaming uploader (dated key, size check)
src/runner/queue.ts         Cloudflare Queues HTTP pull/ack client + drain loop
src/runner/history-store.ts R2-backed append-only run-history store (S3 put/list/get)
test/unit/acquia.test.ts    Acquia client unit tests (injected fetch, offline)
test/unit/r2.test.ts        R2 uploader + object-key unit tests (injected transport, offline)
test/unit/run.test.ts       run-context + Worker enqueue-handoff unit tests
test/unit/queue.test.ts     queue client + drain orchestration unit tests (offline)
test/unit/config.test.ts    config validator unit tests (notifications block)
test/unit/notify.test.ts    notification channels + resolver unit tests (offline)
test/unit/history.test.ts   run-record builders + key convention + in-memory store tests
test/unit/history-store.test.ts  R2 history store tests (in-memory transport, offline)
test/unit/monitor.test.ts   heartbeat check + missed-run event unit tests (offline)
test/unit/runner.test.ts    observeRun (notify + history) + transfer-stage tests (mocked Acquia)
test/worker/worker.test.ts  Worker integration tests (R2 binding, scheduled handoff, /trigger)
```

## Status

The scheduled daily backup ([#1](https://github.com/paulirv/acfbak/issues/1)) is wired end to end: the Worker fires on cron, mints a run id, and hands off to the runner via a Cloudflare Queue, with a token-gated manual `/trigger` path ([#8](https://github.com/paulirv/acfbak/issues/8)). The runner consumes the queue ([#27](https://github.com/paulirv/acfbak/issues/27)), pulls the latest existing Acquia backup ([#7](https://github.com/paulirv/acfbak/issues/7)), and streams it into R2 under a dated key with size verification ([#9](https://github.com/paulirv/acfbak/issues/9)). On-demand backups ([#2](https://github.com/paulirv/acfbak/issues/2)) run through the same pipeline via the first-class `/trigger` path ([#10](https://github.com/paulirv/acfbak/issues/10)), keyed distinctly under `on-demand/` ([#11](https://github.com/paulirv/acfbak/issues/11)). Observability ([#3](https://github.com/paulirv/acfbak/issues/3)) is complete: each run emits exactly one success/failure notification ([#12](https://github.com/paulirv/acfbak/issues/12)) over a configurable console/webhook channel, appends a durable run-history record in R2 retrievable via `npm run runner -- --history` ([#13](https://github.com/paulirv/acfbak/issues/13)), and a heartbeat check (`npm run runner -- --check-heartbeat`) alerts on a missed run through the same channel ([#14](https://github.com/paulirv/acfbak/issues/14)). All component paths are unit/integration tested; a live end-to-end run awaits provisioned Acquia + Cloudflare credentials.
