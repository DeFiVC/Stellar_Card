/**
 * Webhook payload verification helper for backend SDK consumers (#717).
 *
 * Provides a single entry-point — {@link verifyWebhookSignature} — that:
 *   1. Rejects signatures that fail HMAC-SHA-256 timing-safe comparison.
 *   2. Rejects requests whose timestamp falls outside the configurable
 *      tolerance window (default: 300 s).
 *   3. Returns a fully-typed, parsed {@link OrderEvent} payload on success.
 *   4. Throws {@link WebhookVerificationError} with a `reason` discriminant on
 *      every failure path so callers can respond with appropriate HTTP codes.
 *
 * @example
 * ```typescript
 * import { verifyWebhookSignature } from 'stellar_card-sdk';
 *
 * app.post('/webhooks/stellar-card', async (req, res) => {
 *   try {
 *     const event = await verifyWebhookSignature(
 *       req.rawBody,                           // raw Buffer or string
 *       req.headers['x-stellar-card-sig'],     // e.g. "sha256=abc123"
 *       process.env.STELLAR_CARD_WEBHOOK_SECRET!,
 *       req.headers['x-stellar-card-timestamp'], // Unix seconds as string
 *     );
 *     console.log('Verified event:', event.event_type);
 *     res.sendStatus(200);
 *   } catch (err) {
 *     if (err instanceof WebhookVerificationError) {
 *       res.status(400).json({ error: err.message });
 *     } else {
 *       res.sendStatus(500);
 *     }
 *   }
 * });
 * ```
 *
 * Security notes:
 *   - Always use `rawBody` captured before JSON.parse — any whitespace
 *     normalisation will break the HMAC.
 *   - The `timestampToleranceSeconds` default (300 s) protects against replay
 *     attacks; tighten it for stricter environments.
 *   - Never compare signatures with `===` — use the timing-safe function
 *     provided here to prevent timing side-channels.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { OrderEvent } from './types';

// ─── Error type ──────────────────────────────────────────────────────────────

/** Reason discriminant exposed on {@link WebhookVerificationError}. */
export type WebhookVerificationFailureReason =
  | 'missing_signature'
  | 'missing_timestamp'
  | 'invalid_timestamp'
  | 'timestamp_too_old'
  | 'timestamp_too_new'
  | 'invalid_signature_format'
  | 'signature_mismatch'
  | 'invalid_payload';

/**
 * Thrown by {@link verifyWebhookSignature} on any verification failure.
 *
 * Inspect `.reason` for a stable, machine-readable discriminant so your
 * request handler can map each failure to the correct HTTP response.
 */
export class WebhookVerificationError extends Error {
  public readonly reason: WebhookVerificationFailureReason;

  constructor(reason: WebhookVerificationFailureReason, detail?: string) {
    const messages: Record<WebhookVerificationFailureReason, string> = {
      missing_signature: 'Missing X-Stellar-Card-Sig header',
      missing_timestamp: 'Missing X-Stellar-Card-Timestamp header',
      invalid_timestamp: 'Timestamp header is not a valid integer',
      timestamp_too_old: `Timestamp is older than the tolerance window${detail ? ': ' + detail : ''}`,
      timestamp_too_new: `Timestamp is in the future beyond tolerance${detail ? ': ' + detail : ''}`,
      invalid_signature_format: 'Signature header must be in the format "sha256=<hex>"',
      signature_mismatch: 'HMAC-SHA-256 signature verification failed',
      invalid_payload: `Webhook payload is not valid JSON${detail ? ': ' + detail : ''}`,
    };

    super(messages[reason]);
    this.name = 'WebhookVerificationError';
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface VerifyWebhookOptions {
  /**
   * Maximum age of the webhook timestamp in seconds.
   * Requests older than `now - toleranceSeconds` are rejected to prevent
   * replay attacks. Defaults to `300` (5 minutes).
   */
  timestampToleranceSeconds?: number;
}

// ─── Core verification function ───────────────────────────────────────────────

/**
 * Verify an inbound webhook from the Stellar Card API.
 *
 * @param rawBody - Raw request body as received over the wire (string or
 *   Buffer). **Must not** be parsed or whitespace-normalised before passing.
 * @param signature - Value of the `X-Stellar-Card-Sig` header, expected format
 *   `sha256=<lowercase-hex>`.
 * @param secret - The webhook secret configured in your Stellar Card dashboard.
 * @param timestamp - Value of the `X-Stellar-Card-Timestamp` header (Unix
 *   epoch seconds as a decimal string).
 * @param options - Optional tolerance configuration.
 * @returns The parsed {@link OrderEvent} payload if verification succeeds.
 * @throws {@link WebhookVerificationError} on any verification failure.
 */
export async function verifyWebhookSignature(
  rawBody: string | Buffer,
  signature: string | undefined | null,
  secret: string,
  timestamp: string | undefined | null,
  options: VerifyWebhookOptions = {},
): Promise<OrderEvent> {
  const { timestampToleranceSeconds = 300 } = options;

  // ── 1. Presence checks ─────────────────────────────────────────────────────

  if (!signature) {
    throw new WebhookVerificationError('missing_signature');
  }

  if (!timestamp) {
    throw new WebhookVerificationError('missing_timestamp');
  }

  // ── 2. Timestamp freshness ─────────────────────────────────────────────────

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) {
    throw new WebhookVerificationError('invalid_timestamp');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const delta = nowSec - ts;

  if (delta > timestampToleranceSeconds) {
    throw new WebhookVerificationError(
      'timestamp_too_old',
      `${delta}s old, tolerance ${timestampToleranceSeconds}s`,
    );
  }

  // Reject timestamps that are unreasonably far in the future (clock skew
  // guard — same tolerance window applied symmetrically).
  if (delta < -timestampToleranceSeconds) {
    throw new WebhookVerificationError(
      'timestamp_too_new',
      `${-delta}s ahead, tolerance ${timestampToleranceSeconds}s`,
    );
  }

  // ── 3. Signature format ────────────────────────────────────────────────────

  const SCHEME = 'sha256=';
  if (!signature.startsWith(SCHEME)) {
    throw new WebhookVerificationError('invalid_signature_format');
  }

  const receivedHex = signature.slice(SCHEME.length);

  // Validate that receivedHex is actually hex before allocating a Buffer —
  // an invalid hex string would throw from Buffer.from, which is not
  // timing-safe and leaks information.
  if (!/^[0-9a-f]+$/i.test(receivedHex) || receivedHex.length === 0) {
    throw new WebhookVerificationError('invalid_signature_format');
  }

  // ── 4. HMAC-SHA-256 computation ────────────────────────────────────────────

  // The signed payload is: timestamp + "." + rawBody  (same convention as
  // Stripe, Square, and other major webhook providers).
  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  const signedPayload = `${timestamp}.${bodyStr}`;

  const expectedHmac = createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest();

  // Pad to same length to satisfy timingSafeEqual's same-length requirement.
  // A length mismatch after valid-hex validation means the signature cannot
  // match, but we still do the comparison to avoid leaking length via timing.
  const receivedBuf = Buffer.from(receivedHex, 'hex');
  const expectedBuf = expectedHmac;

  // Constant-time comparison — lengths must match for timingSafeEqual.
  // If they differ we know it's wrong, but we still run a dummy comparison
  // on expectedBuf with itself to consume equivalent CPU time.
  const lengthsMatch = receivedBuf.length === expectedBuf.length;
  const signaturesMatch =
    lengthsMatch && timingSafeEqual(receivedBuf, expectedBuf);

  if (!signaturesMatch) {
    throw new WebhookVerificationError('signature_mismatch');
  }

  // ── 5. Payload parsing ─────────────────────────────────────────────────────

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyStr);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WebhookVerificationError('invalid_payload', msg);
  }

  // Return the typed event — callers may further validate fields they need.
  return parsed as OrderEvent;
}
