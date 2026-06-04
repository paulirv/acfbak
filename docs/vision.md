# acfbak — Acquia → Cloudflare R2 Backup — Product Vision & Strategy

> Last updated: 2026-06-03

## Vision

acfbak gives Drupal sites hosted on Acquia Cloud an **independent, off-platform safety net**: it automatically captures the production database every day — and on demand — and stores it in a Cloudflare R2 bucket the site owner fully controls. It exists so that recovery never depends on a single vendor's retention window, console, or availability. If Acquia is unreachable, mispriced, or a backup has aged out, your data is still sitting in storage you own.

## Problem Statement

Acquia Cloud takes its own database backups, but they live **inside Acquia**, with retention tied to your plan and a console you must log into to retrieve them. That creates three real costs:

- **Retention gaps** — older backups age out automatically; the snapshot you need for a slow-to-discover data corruption may already be gone.
- **Vendor concentration** — if your only copies are on the platform, a billing lapse, account issue, or platform incident can put your recovery point out of reach exactly when you need it.
- **Friction to get data out** — pulling a dump off Acquia for local restore, audits, or migration is a manual, click-heavy chore that nobody does on a schedule.

The cost of not solving it is asymmetric: backups are cheap and boring right up until the one day they're the only thing standing between you and an unrecoverable site.

## Target Users

| Persona | Description | Primary Need |
|---------|-------------|--------------|
| Drupal site operator / agency lead | Runs one or more client Drupal sites on Acquia Cloud | Trustworthy off-platform backups that just happen, with proof they ran |
| DevOps / platform engineer | Owns hosting, DR, and compliance for the estate | Automated, observable, restorable backups in storage they control |
| Site owner / stakeholder | Pays for the site, accountable for the data | Confidence the business can recover from data loss without vendor lock-in |

## Product Principles

Ordered by priority — when principles conflict, higher wins.

1. **Recoverability over everything** — a backup that can't be restored is worthless. Every feature is judged by whether it makes a real restore faster and more certain.
2. **Own your copy** — data lands in storage the customer controls (their R2 bucket), in an open, restorable format. No proprietary lock-in on the backup itself.
3. **Boringly reliable** — runs unattended, fails loudly, never silently. Predictability beats cleverness.
4. **Observable by default** — every run reports success or failure; a missed backup is a visible event, not a silent gap.
5. **Least privilege & secret hygiene** — credentials for Acquia and R2 are scoped, stored as secrets, never logged or committed.
6. **Cheap to run** — leans on R2's zero-egress economics and lightweight scheduled execution so cost never becomes a reason to skip backups.

## What We Won't Do (Non-Goals)

- **Not a full Acquia replacement** — we back up the database, not the entire platform; file/asset and code backup are out of scope for now (revisit later).
- **Not a restore-automation product (yet)** — v1 guarantees a clean, restorable artifact in R2; one-click restore back into Acquia is a future consideration, not a launch promise.
- **Not a general multi-host backup tool** — scope is Acquia Cloud as the source. We will not chase every hosting provider.
- **Not a backup UI/dashboard product** — observability is via logs/notifications and the R2 bucket itself, not a bespoke web console.
- **Not a long-term archival/compliance vault** — we provide retention controls, but legal-hold/WORM compliance certification is out of scope.

---

## Strategy

### Competitive Landscape

| Alternative | Strengths | Weaknesses | Our Differentiator |
|-------------|-----------|------------|-------------------|
| Acquia native backups | Built-in, no setup, integrated restore | On-platform only, plan-bound retention, vendor concentration | Off-platform copy in storage the customer owns |
| Manual `drush sql-dump` / scripts | Full control, free | Manual, error-prone, no schedule, no offsite target, dies with the engineer who wrote it | Automated, scheduled, observable, declarative |
| Generic backup SaaS (e.g. SimpleBackups, BackupSheep) | Polished UI, multi-source | Recurring cost, another vendor to trust, not Acquia-native | Purpose-built for the Acquia→R2 path; you own the infra |
| Cloud provider snapshots (RDS-style) | Automatic, durable | Not applicable to Acquia-managed DBs; provider lock-in | Works with Acquia's managed Drupal DB specifically |

### Key Differentiators

1. **Off-platform by design** — the whole point is that your recovery copy does not live inside Acquia. Independence is the product.
2. **R2 economics** — zero egress fees mean restores and audits don't punish you for actually using your backups.
3. **Acquia-native source path** — uses Acquia's own backup/dump mechanism as the source of truth, so the artifact is a known-good Drupal DB dump, not a lossy approximation.
4. **Declarative & reproducible** — schedule, retention, and targets are defined in config, version-controlled, and idempotent — not a fragile cron line on someone's laptop.
5. **Loud failure** — a backup that didn't run is surfaced immediately, closing the "silent gap" failure mode that kills most homegrown backup schemes.

### Phased Roadmap

| Phase | Focus | Success Signal |
|-------|-------|----------------|
| Now | Daily scheduled + on-demand DB backup from one Acquia environment to one R2 bucket; success/failure notification; basic retention | A real production DB lands in R2 every day, unattended, with a verifiable artifact |
| Next | Multi-environment / multi-site config, retention policies (daily/weekly/monthly tiers), restore-verification check, richer alerting | An agency backs up several sites from one config with confidence each artifact restores |
| Later | Assisted restore back into Acquia, file/asset backup, integrity/encryption-at-rest options, optional dashboard | A site owner recovers from data loss end-to-end without manual dump wrangling |

### Success Metrics

| Metric | Current | Target | Timeframe |
|--------|---------|--------|-----------|
| Daily backup success rate | N/A | ≥ 99% of scheduled runs land a valid artifact | Within 1 month of first prod use |
| Time-to-restore (manual, from R2) | N/A | < 30 min from "I need it" to DB imported | By end of Next phase |
| Mean detection time for a failed/missed backup | N/A | < 1 run cycle (failure surfaced before the next scheduled run) | At launch |
| Restorability verification | N/A | 100% of artifacts pass an automated "is this a valid dump" check | By end of Next phase |
| Cost per site per month | N/A | Dominated by R2 storage only; effectively pennies at typical DB sizes | At launch |

### Architecture Decisions (resolved)

- **Execution split: Worker orchestrates, runner transfers.** A Cloudflare Worker (Cron Trigger) owns scheduling, orchestration, and alerting; a separate runner performs the heavy byte transfer of the dump into R2. This sidesteps Worker CPU/time/memory limits on large dumps while keeping a single, observable control point. _Open sub-question: what hosts the runner (GitHub Actions vs. container) and how the Worker hands off to it._
- **Acquia source: pull the latest existing backup.** acfbak downloads the most recent backup Acquia already produced rather than triggering a fresh one via the Cloud API — lighter on API rate limits and simpler auth. _Trade-off accepted: artifact freshness is bounded by Acquia's own backup cadence; revisit if a fresher RPO is required._

### Risks & Open Questions

- **Runner host & handoff** — Worker → runner handoff mechanism (queue, webhook, dispatch) and where the runner lives (GitHub Actions / container) is the main remaining design question.
- **Large database sizes** — multi-GB dumps must stream into R2 within the runner's limits; the transfer path must stream, not buffer.
- **Backup freshness** — since we pull Acquia's latest existing backup, our effective RPO depends on Acquia's backup schedule; confirm that cadence is acceptable per site.
- **Restore fidelity** — a dump that exists isn't proof it restores; we need a verification step to avoid false confidence.
- **Secret management** — Acquia and R2 credentials must be scoped and stored securely; rotation strategy is open.
- **Retention vs. cost vs. compliance** — how many daily/weekly/monthly copies to keep by default, and who owns lifecycle expiry (our logic vs. R2 lifecycle rules).
- **Single-environment assumption** — early scope targets production; confirm whether dev/stage backups are needed at launch.

---

## Capabilities

Link to GitHub Issues labeled `cap`:

- [ ] [#1](https://github.com/paulirv/acfbak/issues/1) Scheduled daily backup _(p1-critical)_ — Acquia DB → R2 on a cron schedule, unattended.
- [ ] [#2](https://github.com/paulirv/acfbak/issues/2) On-demand backup _(p2-high)_ — trigger a backup manually outside the schedule.
- [ ] [#3](https://github.com/paulirv/acfbak/issues/3) Backup observability & alerting _(p2-high)_ — success/failure notification and run history.
- [ ] [#4](https://github.com/paulirv/acfbak/issues/4) Retention & lifecycle _(p3-medium)_ — keep N daily/weekly/monthly copies; expire the rest.
- [ ] [#5](https://github.com/paulirv/acfbak/issues/5) Restore verification _(p3-medium)_ — confirm each artifact is a valid, restorable Drupal dump.

---

*This document is the anchor for all product decisions. Capabilities and requirements should trace back to this vision. If something doesn't connect here, question whether it belongs.*
