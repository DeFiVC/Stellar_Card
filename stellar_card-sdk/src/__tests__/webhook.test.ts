/**
 * Tests for verifyWebhookSignature (#717).
 *
 * Covers all acceptance criteria:
 *   ✓ Valid signature + fresh timestamp → returns typed OrderEvent payload
 *   ✓ Missing signature header          → throws WebhookVerificationError (missing_signature)
 *   ✓ Missing timestamp header          → throws WebhookVerificationError (missing_timestamp)
 *   ✓ Non-integer timestamp             → throws WebhookVerificationError (invalid_timestamp)
 *   ✓ Timestamp too old                 → throws WebhookVerificationError (timestamp_too_old)
 *   ✓ Timestamp too far in the future   → throws WebhookVerificationError (timestamp_too_new)
 *   ✓ Wrong signature scheme            → throws WebhookVerificationError (invalid_signature_format)
 *   ✓ Invalid hex in signature          → throws WebhookVerificationError (invalid_signature_format)
 *   ✓ Correct format but wrong value    → throws WebhookVerificationError (signature_mismatch)
 *   ✓ Tampered body                     → throws WebhookVerificationError (signature_mismatch)
 *   ✓ Wrong secret                      → throws WebhookVerificationError (signature_mismatch)
 *   ✓ Invalid JSON body                 → throws WebhookVerificationError (invalid_payload)
 *   ✓ Configurable tolerance            → customised via options.timestampToleranceSeconds
 *   ✓ Buffer rawBody accepted           → same result as string rawBody
 *   ✓ WebhookVerificationError is correctly named/instanceOf
 *   ✓ Imports are re-exported from src/index.ts
 */

import { createHmac } from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  verifyWebhookSignature,
  WebhookVerificationError,
  type WebhookVerificationFailureReason,
} from '../webhook';

// ── Test fixtures ────────────────────────────────────────────────────────────

const SECRET = 'test-webhook-secret-abc123';

const SAMPLE_EVENT = {
  event_id: 'evt_1',
  order_id: 'ord_abc',
  event_type: 'order_created',
  timestamp: '2024-01-15T10:00:00Z',
  source: 'api' as const,
  message: 'Order created successfully',
};

/**
 * Build a valid signed webhook request.
 * Returns { body, signature, timestamp } ready to pass to verifyWebhookSignature.
 */
function buildValidRequest(opts: {
  body?: object | string;
  secret?: string;
  nowSec?: number;
  offsetSeconds?: number;
}) {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const ts = String(nowSec + (opts.offsetSeconds ?? 0));
  const bodyStr =
    typeof opts.body === 'string'
      ? opts.body
      : JSON.stringify(opts.body ?? SAMPLE_EVENT);
  const signedPayload = `${ts}.${bodyStr}`;
  const sig =
    'sha256=' +
    createHmac('sha256', opts.secret ?? SECRET)
      .update(signedPayload, 'utf8')
      .digest('hex');
  return { body: bodyStr, signature: sig, timestamp: ts };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function expectError(
  promise: Promise<unknown>,
  reason: WebhookVerificationFailureReason,
) {
  await expect(promise).rejects.toThrow(WebhookVerificationError);
  await expect(promise).rejects.toMatchObject({ reason });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('verifyWebhookSignature (#717)', () => {
  // ── Happy path ──────────────────────────────────────────────────────────────

  describe('valid request', () => {
    it('returns parsed OrderEvent on success (string body)', async () => {
      const { body, signature, timestamp } = buildValidRequest({});
      const result = await verifyWebhookSignature(body, signature, SECRET, timestamp);
      expect(result).toMatchObject({ event_id: 'evt_1', order_id: 'ord_abc' });
    });

    it('returns parsed OrderEvent on success (Buffer body)', async () => {
      const { body, signature, timestamp } = buildValidRequest({});
      const bufBody = Buffer.from(body, 'utf8');
      const result = await verifyWebhookSignature(bufBody, signature, SECRET, timestamp);
      expect(result).toMatchObject({ event_id: 'evt_1' });
    });

    it('accepts timestamp at the exact tolerance boundary', async () => {
      const tol = 300;
      const { body, signature, timestamp } = buildValidRequest({
        offsetSeconds: -tol, // exactly at boundary
      });
      const result = await verifyWebhookSignature(body, signature, SECRET, timestamp, {
        timestampToleranceSeconds: tol,
      });
      expect(result).toBeDefined();
    });

    it('works with a custom timestampToleranceSeconds of 60s', async () => {
      const { body, signature, timestamp } = buildValidRequest({
        offsetSeconds: -59,
      });
      const result = await verifyWebhookSignature(body, signature, SECRET, timestamp, {
        timestampToleranceSeconds: 60,
      });
      expect(result).toBeDefined();
    });
  });

  // ── Missing inputs ───────────────────────────────────────────────────────────

  describe('missing inputs', () => {
    it('throws missing_signature when signature is undefined', async () => {
      const { body, timestamp } = buildValidRequest({});
      await expectError(
        verifyWebhookSignature(body, undefined, SECRET, timestamp),
        'missing_signature',
      );
    });

    it('throws missing_signature when signature is null', async () => {
      const { body, timestamp } = buildValidRequest({});
      await expectError(
        verifyWebhookSignature(body, null, SECRET, timestamp),
        'missing_signature',
      );
    });

    it('throws missing_signature when signature is empty string', async () => {
      const { body, timestamp } = buildValidRequest({});
      await expectError(
        verifyWebhookSignature(body, '', SECRET, timestamp),
        'missing_signature',
      );
    });

    it('throws missing_timestamp when timestamp is undefined', async () => {
      const { body, signature } = buildValidRequest({});
      await expectError(
        verifyWebhookSignature(body, signature, SECRET, undefined),
        'missing_timestamp',
      );
    });

    it('throws missing_timestamp when timestamp is null', async () => {
      const { body, signature } = buildValidRequest({});
      await expectError(
        verifyWebhookSignature(body, signature, SECRET, null),
        'missing_timestamp',
      );
    });

    it('throws missing_timestamp when timestamp is empty string', async () => {
      const { body, signature } = buildValidRequest({});
      await expectError(
        verifyWebhookSignature(body, signature, SECRET, ''),
        'missing_timestamp',
      );
    });
  });

  // ── Timestamp validation ─────────────────────────────────────────────────────

  describe('timestamp validation', () => {
    it('throws invalid_timestamp for non-numeric string', async () => {
      const { body, signature } = buildValidRequest({});
      await expectError(
        verifyWebhookSignature(body, signature, SECRET, 'not-a-number'),
        'invalid_timestamp',
      );
    });

    it('throws invalid_timestamp for float string', async () => {
      const { body, signature } = buildValidRequest({});
      await expectError(
        verifyWebhookSignature(body, signature, SECRET, '1700000000.5'),
        'invalid_timestamp',
      );
    });

    it('throws timestamp_too_old when timestamp is beyond tolerance', async () => {
      const { body, signature, timestamp } = buildValidRequest({
        offsetSeconds: -400, // 400s ago, default tolerance 300s
      });
      await expectError(
        verifyWebhookSignature(body, signature, SECRET, timestamp),
        'timestamp_too_old',
      );
    });

    it('throws timestamp_too_old with custom tolerance (strict)', async () => {
      const { body, signature, timestamp } = buildValidRequest({
        offsetSeconds: -61,
      });
      await expectError(
        verifyWebhookSignature(body, signature, SECRET, timestamp, {
          timestampToleranceSeconds: 60,
        }),
        'timestamp_too_old',
      );
    });

    it('throws timestamp_too_new for timestamp far in the future', async () => {
      const { body, signature, timestamp } = buildValidRequest({
        offsetSeconds: 400, // 400s in the future, default tolerance 300s
      });
      await expectError(
        verifyWebhookSignature(body, signature, SECRET, timestamp),
        'timestamp_too_new',
      );
    });
  });

  // ── Signature format ─────────────────────────────────────────────────────────

  describe('signature format', () => {
    it('throws invalid_signature_format when scheme is missing', async () => {
      const { body, timestamp } = buildValidRequest({});
      await expectError(
        verifyWebhookSignature(body, 'abc123', SECRET, timestamp),
        'invalid_signature_format',
      );
    });

    it('throws invalid_signature_format when scheme is wrong (md5=)', async () => {
      const { body, timestamp } = buildValidRequest({});
      await expectError(
        verifyWebhookSignature(body, 'md5=abc123', SECRET, timestamp),
        'invalid_signature_format',
      );
    });

    it('throws invalid_signature_format when hex part contains non-hex chars', async () => {
      const { body, timestamp } = buildValidRequest({});
      await expectError(
        verifyWebhookSignature(body, 'sha256=xyz!@#', SECRET, timestamp),
        'invalid_signature_format',
      );
    });

    it('throws invalid_signature_format when hex part is empty', async () => {
      const { body, timestamp } = buildValidRequest({});
      await expectError(
        verifyWebhookSignature(body, 'sha256=', SECRET, timestamp),
        'invalid_signature_format',
      );
    });
  });

  // ── Signature mismatch ───────────────────────────────────────────────────────

  describe('signature mismatch', () => {
    it('throws signature_mismatch for wrong secret', async () => {
      const { body, signature, timestamp } = buildValidRequest({ secret: 'wrong-secret' });
      await expectError(
        verifyWebhookSignature(body, signature, SECRET, timestamp),
        'signature_mismatch',
      );
    });

    it('throws signature_mismatch when body has been tampered', async () => {
      const { signature, timestamp } = buildValidRequest({});
      const tamperedBody = JSON.stringify({ ...SAMPLE_EVENT, order_id: 'TAMPERED' });
      await expectError(
        verifyWebhookSignature(tamperedBody, signature, SECRET, timestamp),
        'signature_mismatch',
      );
    });

    it('throws signature_mismatch for truncated signature', async () => {
      const { body, signature, timestamp } = buildValidRequest({});
      const truncated = signature.slice(0, -4);
      await expectError(
        verifyWebhookSignature(body, truncated, SECRET, timestamp),
        'signature_mismatch',
      );
    });

    it('throws signature_mismatch when timestamp in signed payload differs from header', async () => {
      // Build with one timestamp, but send a different timestamp header
      const nowSec = Math.floor(Date.now() / 1000);
      const { body, signature } = buildValidRequest({ nowSec });
      const differentTimestamp = String(nowSec - 1); // off by 1
      await expectError(
        verifyWebhookSignature(body, signature, SECRET, differentTimestamp),
        'signature_mismatch',
      );
    });
  });

  // ── Invalid payload ───────────────────────────────────────────────────────────

  describe('invalid payload', () => {
    it('throws invalid_payload for malformed JSON body', async () => {
      const body = 'not-valid-json-{{{';
      const nowSec = Math.floor(Date.now() / 1000);
      const ts = String(nowSec);
      const signedPayload = `${ts}.${body}`;
      const sig =
        'sha256=' +
        createHmac('sha256', SECRET).update(signedPayload, 'utf8').digest('hex');

      await expectError(
        verifyWebhookSignature(body, sig, SECRET, ts),
        'invalid_payload',
      );
    });

    it('throws invalid_payload for empty body', async () => {
      const body = '';
      const nowSec = Math.floor(Date.now() / 1000);
      const ts = String(nowSec);
      const signedPayload = `${ts}.${body}`;
      const sig =
        'sha256=' +
        createHmac('sha256', SECRET).update(signedPayload, 'utf8').digest('hex');

      await expectError(
        verifyWebhookSignature(body, sig, SECRET, ts),
        'invalid_payload',
      );
    });
  });

  // ── Error class properties ────────────────────────────────────────────────────

  describe('WebhookVerificationError class', () => {
    it('has the correct name', async () => {
      const err = new WebhookVerificationError('missing_signature');
      expect(err.name).toBe('WebhookVerificationError');
    });

    it('is an instance of Error', () => {
      expect(new WebhookVerificationError('missing_signature')).toBeInstanceOf(Error);
    });

    it('exposes the reason discriminant', () => {
      const reasons: WebhookVerificationFailureReason[] = [
        'missing_signature',
        'missing_timestamp',
        'invalid_timestamp',
        'timestamp_too_old',
        'timestamp_too_new',
        'invalid_signature_format',
        'signature_mismatch',
        'invalid_payload',
      ];
      for (const reason of reasons) {
        const err = new WebhookVerificationError(reason);
        expect(err.reason).toBe(reason);
      }
    });

    it('includes detail in the message when provided', () => {
      const err = new WebhookVerificationError('timestamp_too_old', '350s old');
      expect(err.message).toContain('350s old');
    });

    it('thrown errors are instanceof WebhookVerificationError', async () => {
      const { body, timestamp } = buildValidRequest({});
      try {
        await verifyWebhookSignature(body, undefined, SECRET, timestamp);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(WebhookVerificationError);
      }
    });
  });

  // ── Re-export from index ─────────────────────────────────────────────────────

  describe('index.ts re-exports', () => {
    it('verifyWebhookSignature is exported from the SDK barrel', async () => {
      const barrel = await import('../index');
      expect(typeof barrel.verifyWebhookSignature).toBe('function');
    });

    it('WebhookVerificationError is exported from the SDK barrel', async () => {
      const barrel = await import('../index');
      expect(barrel.WebhookVerificationError).toBeDefined();
      expect(new barrel.WebhookVerificationError('missing_signature')).toBeInstanceOf(Error);
    });
  });
});
