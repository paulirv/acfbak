/**
 * Per-run notifications (#12) — every backup run emits exactly one terminal
 * signal, success or failure, so a failed backup is surfaced loudly before the
 * next scheduled run rather than failing silently.
 *
 * Host-agnostic by design (no node:, Workers, or AWS imports): the event shapes
 * and the channel implementations depend only on an injectable `fetch`, so this
 * module can be emitted from the Node runner today and the Worker later. The
 * runner wires it in around the transfer (see src/runner/index.ts); the channel
 * is chosen declaratively (config) with the destination supplied as a secret.
 */

import type { AcfbakConfig } from "./config.ts";
import type { TriggerKind } from "./run.ts";

/** A subset of the global `fetch` — all the webhook channel needs (injectable). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The transfer stage a run reached when it failed (AC: failure notifications
 * name the failing stage). Mirrors the runner's transfer pipeline:
 *   discover  — selecting the latest Acquia backup
 *   download  — opening the Acquia download stream
 *   transfer  — streaming into R2 and verifying the stored size
 */
export type TransferStage = "discover" | "download" | "transfer" | "unknown";

/** Fields common to both terminal outcomes. */
interface RunEventBase {
  /** Run id minted by the Worker — correlates Worker log ↔ runner log ↔ R2. */
  runId: string;
  /** What initiated the run (scheduled cron vs on-demand trigger). */
  trigger: TriggerKind;
  /** Optional operator label for an on-demand run (e.g. "pre-deploy v2.3"). */
  label?: string;
  /** ISO-8601 timestamp the terminal outcome was recorded. */
  timestamp: string;
}

/** A backup run that completed and produced a verified artifact. */
export interface RunSuccessEvent extends RunEventBase {
  outcome: "success";
  /** R2 object key the dump was stored under. */
  destinationKey: string;
  /** Verified stored object size in bytes. */
  size: number;
}

/** A backup run that failed at some stage — surfaced for diagnosis. */
export interface RunFailureEvent extends RunEventBase {
  outcome: "failure";
  /** The pipeline stage that failed. */
  stage: TransferStage;
  /** One-line error summary (never includes secret material). */
  error: string;
}

/** The single terminal signal a run emits. */
export type RunNotification = RunSuccessEvent | RunFailureEvent;

/** A notification sink. Implementations MUST NOT throw — a channel failure must
 * never turn a successful backup into a failure (or vice versa); they log their
 * own delivery problems instead. */
export interface Notifier {
  notify(event: RunNotification): Promise<void>;
}

/** Render a notification as a `{ subject, text }` human summary (channel-agnostic). */
export function formatNotification(event: RunNotification): { subject: string; text: string } {
  const origin = event.label ? `${event.trigger} "${event.label}"` : event.trigger;
  if (event.outcome === "success") {
    return {
      subject: `acfbak backup OK — ${origin} (${event.runId})`,
      text:
        `✅ acfbak backup succeeded\n` +
        `run: ${event.runId} (${origin})\n` +
        `artifact: ${event.destinationKey}\n` +
        `size: ${event.size} bytes\n` +
        `at: ${event.timestamp}`,
    };
  }
  return {
    subject: `acfbak backup FAILED — ${origin} (${event.runId})`,
    text:
      `❌ acfbak backup FAILED\n` +
      `run: ${event.runId} (${origin})\n` +
      `stage: ${event.stage}\n` +
      `error: ${event.error}\n` +
      `at: ${event.timestamp}`,
  };
}

/**
 * Console channel — always available, zero config. Success goes to stdout,
 * failure to stderr (so CI/log scrapers and exit-tooling can split them). This
 * is the default sink and is always teed under the webhook channel too, so a
 * record of every terminal outcome exists even if a remote delivery fails.
 */
export function consoleNotifier(): Notifier {
  return {
    async notify(event) {
      const { text } = formatNotification(event);
      if (event.outcome === "success") {
        console.log(`[acfbak notify] ${text.replace(/\n/g, " | ")}`);
      } else {
        console.error(`[acfbak notify] ${text.replace(/\n/g, " | ")}`);
      }
    },
  };
}

/**
 * Webhook channel — POSTs a Slack-compatible `{ text }` JSON payload to
 * `url`. This single shape fans out to Slack (incoming webhook), Telegram (via
 * a thin relay), or email (via any webhook→email bridge), keeping acfbak free of
 * per-vendor SDKs. Best-effort: a non-2xx response or network error is logged
 * to stderr and swallowed — the backup's real outcome is never overwritten by a
 * delivery problem (the console tee still has the record).
 */
export function webhookNotifier(url: string, fetchImpl: FetchLike): Notifier {
  return {
    async notify(event) {
      const { text } = formatNotification(event);
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) {
          console.error(
            `[acfbak notify] webhook delivery failed (HTTP ${res.status}) for run ${event.runId}`,
          );
        }
      } catch (err) {
        console.error(
          `[acfbak notify] webhook delivery error for run ${event.runId}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

/** Fan a notification out to several channels; one failing channel never blocks
 * the others (and channels don't throw anyway). */
export function teeNotifier(...notifiers: Notifier[]): Notifier {
  return {
    async notify(event) {
      await Promise.all(notifiers.map((n) => n.notify(event)));
    },
  };
}

/**
 * Resolve the configured notifier from declarative config + secrets (AC: the
 * channel is configurable). `config.notifications.channel` selects the channel
 * ("console" default, or "webhook"); the webhook destination is the
 * `NOTIFY_WEBHOOK_URL` secret. A "webhook" channel with no URL secret is a
 * misconfiguration and fails loud HERE (at startup, before any transfer) rather
 * than risking a silent run. The webhook channel always tees to the console so
 * a local record exists regardless of remote delivery.
 */
export function resolveNotifier(
  config: AcfbakConfig,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Notifier {
  const channel = config.notifications?.channel ?? "console";
  if (channel === "console") {
    return consoleNotifier();
  }
  // channel === "webhook"
  const url = env.NOTIFY_WEBHOOK_URL;
  if (!url) {
    throw new Error(
      `notifications.channel is "webhook" but NOTIFY_WEBHOOK_URL is not set. ` +
        `Set it as a secret (see .env.example) or use the "console" channel.`,
    );
  }
  return teeNotifier(consoleNotifier(), webhookNotifier(url, fetchImpl));
}
