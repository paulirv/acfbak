/**
 * Cloudflare Queues HTTP pull-consumer client — the runner's side of the
 * Worker→runner handoff (#27).
 *
 * The Worker enqueues a BackupRunContext onto the handoff queue; the runner is
 * an external Node process (not a Worker), so it consumes via the Queues HTTP
 * *pull* API: POST .../messages/pull to lease a batch, then POST .../messages/ack
 * to acknowledge (or retry) each message by its lease id.
 *
 * Runner-only but dependency-light: uses global `fetch` (injectable for offline
 * tests) and Node's `Buffer` for base64 decoding. No AWS/Workers imports.
 *
 * API contract (verified against developers.cloudflare.com/queues):
 *   pull: POST /accounts/{accountId}/queues/{queueId}/messages/pull
 *         body { batch_size, visibility_timeout_ms }
 *         → { result: { messages: [{ id, lease_id, attempts, body, metadata }] } }
 *         `body` is base64 for the `json`/`bytes` content types (the Worker
 *         producer sends objects → `json`), raw UTF-8 for `text`.
 *   ack:  POST /accounts/{accountId}/queues/{queueId}/messages/ack
 *         body { acks: [{ lease_id }], retries: [{ lease_id, delay_seconds? }] }
 */

import type { BackupRunContext } from "../run.ts";

/** Cloudflare REST API base. */
export const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/** A subset of the global `fetch` signature — all this module needs. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Credentials/identifiers for the Queues HTTP pull API. */
export interface QueueCredentials {
  /** Cloudflare account id (same account as R2_ACCOUNT_ID). */
  accountId: string;
  /** API token with Queues read/edit permission. */
  apiToken: string;
  /** The queue's id (UUID) — `wrangler queues list` or the dashboard. */
  queueId: string;
}

/** A message leased from the queue, with its decoded run context. */
export interface PulledMessage {
  /** Queue message id. */
  id: string;
  /** Lease id used to ack/retry this specific delivery. */
  leaseId: string;
  /** Delivery attempt count reported by the queue. */
  attempts: number;
  /** The decoded run context the Worker enqueued. */
  context: BackupRunContext;
}

/** Base error for any queue-client failure — clear, surfaced messages. */
export class QueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueError";
  }
}

/** The API token was rejected (missing/insufficient Queues permission). */
export class QueueAuthError extends QueueError {
  constructor(message: string) {
    super(message);
    this.name = "QueueAuthError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Assert the runner's queue credentials are present and return them. Fails loud
 * with a clear message, never echoing the values.
 */
export function requireQueueCredentials(env: NodeJS.ProcessEnv = process.env): QueueCredentials {
  const accountId = env.CF_ACCOUNT_ID;
  const apiToken = env.CF_API_TOKEN;
  const queueId = env.CF_QUEUE_ID;
  const missing = [
    !accountId && "CF_ACCOUNT_ID",
    !apiToken && "CF_API_TOKEN",
    !queueId && "CF_QUEUE_ID",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `Missing required queue secret(s): ${missing.join(", ")}. ` +
        `See .env.example and the README "Secrets" section.`,
    );
  }
  return {
    accountId: accountId as string,
    apiToken: apiToken as string,
    queueId: queueId as string,
  };
}

/** Decode a pulled message body into a BackupRunContext, honouring content type. */
function parseMessageContext(body: unknown, metadata: unknown): BackupRunContext {
  if (typeof body !== "string") {
    throw new QueueError("Queue message body was not a string.");
  }
  const contentType = isRecord(metadata) ? metadata["CF-Content-Type"] : undefined;
  // `json`/`bytes` are base64; `text` is raw UTF-8. Default to base64 since the
  // Worker producer sends objects (→ json).
  const text = contentType === "text" ? body : Buffer.from(body, "base64").toString("utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new QueueError("Queue message body was not valid JSON.");
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.runId !== "string" ||
    typeof parsed.destinationKey !== "string"
  ) {
    throw new QueueError("Queue message is not a BackupRunContext (missing runId/destinationKey).");
  }
  return parsed as unknown as BackupRunContext;
}

/** Lease ids to retry, with an optional redelivery delay. */
export interface QueueRetry {
  leaseId: string;
  delaySeconds?: number;
}

/** Thin client over the Queues HTTP pull/ack endpoints. */
export class QueuePullClient {
  private readonly creds: QueueCredentials;
  private readonly fetchImpl: FetchLike;
  private readonly base: string;

  constructor(creds: QueueCredentials, fetchImpl: FetchLike, base: string = CF_API_BASE) {
    this.creds = creds;
    this.fetchImpl = fetchImpl;
    this.base = base;
  }

  private endpoint(action: "pull" | "ack"): string {
    return `${this.base}/accounts/${this.creds.accountId}/queues/${this.creds.queueId}/messages/${action}`;
  }

  private async post(url: string, payload: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.creds.apiToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new QueueError(
        `Network error calling Queues API: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new QueueAuthError(
        `Queues API rejected the token (HTTP ${res.status}). ` +
          `Check CF_API_TOKEN has Queues read/edit permission.`,
      );
    }
    if (!res.ok) {
      throw new QueueError(`Queues API request failed (HTTP ${res.status}).`);
    }
    return res.json();
  }

  /** Lease a batch of messages, returning each decoded run context + lease id (AC-01). */
  async pull(opts: { batchSize?: number; visibilityTimeoutMs?: number } = {}): Promise<PulledMessage[]> {
    const json = await this.post(this.endpoint("pull"), {
      batch_size: opts.batchSize ?? 10,
      visibility_timeout_ms: opts.visibilityTimeoutMs ?? 30000,
    });
    const result = isRecord(json) ? json.result : undefined;
    const rawMessages = isRecord(result) && Array.isArray(result.messages) ? result.messages : [];

    const messages: PulledMessage[] = [];
    for (const raw of rawMessages) {
      if (!isRecord(raw)) continue;
      if (typeof raw.id !== "string" || typeof raw.lease_id !== "string") continue;
      messages.push({
        id: raw.id,
        leaseId: raw.lease_id,
        attempts: typeof raw.attempts === "number" ? raw.attempts : 0,
        context: parseMessageContext(raw.body, raw.metadata),
      });
    }
    return messages;
  }

  /** Acknowledge and/or retry messages by lease id. A no-op when both are empty. */
  async ack(ackLeaseIds: string[], retries: QueueRetry[] = []): Promise<void> {
    if (ackLeaseIds.length === 0 && retries.length === 0) return;
    await this.post(this.endpoint("ack"), {
      acks: ackLeaseIds.map((lease_id) => ({ lease_id })),
      retries: retries.map((r) =>
        r.delaySeconds != null
          ? { lease_id: r.leaseId, delay_seconds: r.delaySeconds }
          : { lease_id: r.leaseId },
      ),
    });
  }
}
