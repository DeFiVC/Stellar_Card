/**
 * Tests for idempotency key generation and header injection in the
 * Stellar_CardClient SDK.
 *
 * Covers:
 *  - Auto-generation of a UUID v4 idempotency key when none is provided
 *  - Forwarding of a caller-supplied idempotency key
 *  - Idempotency-Key header is injected into outgoing HTTP requests
 *  - Each call without an explicit key receives a unique key
 *  - Key format conforms to UUID v4 pattern
 *  - idempotencyKey is stripped from the request body (not leaked to API)
 *
 * Closes #697
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Allow http:// base URLs in tests
process.env.CARDS402_ALLOW_INSECURE_BASE_URL = '1';

import { Stellar_CardClient } from '../client';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** UUID v4 regex pattern */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function client() {
  return new Stellar_CardClient({
    baseUrl: 'http://localhost:3000/v1',
    apiKey: 'stellar_card_test_key',
    retry: { attempts: 0 }, // disable retries for deterministic tests
  });
}

const ORDER_RESPONSE = {
  order_id: 'ord_idem_test',
  status: 'pending_payment',
  payment: {
    type: 'soroban_contract' as const,
    contract_id: 'CARDS402CONTRACTIDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    order_id: 'ord_idem_test',
    usdc: {
      amount: '10.00',
      asset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    },
  },
  poll_url: '/v1/orders/ord_idem_test',
  budget: { spent_usdc: '0.00', limit_usdc: null, remaining_usdc: null },
};

function mockOk(body: unknown = ORDER_RESPONSE) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    headers: { get: () => null },
    json: async () => body,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Idempotency-Key header injection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Auto-generation ────────────────────────────────────────────────────────

  describe('auto-generation', () => {
    it('injects an Idempotency-Key header when none is provided', async () => {
      const fetchMock = mockOk();
      global.fetch = fetchMock;

      await client().createOrder({ amount_usdc: '10.00' });

      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBeDefined();
      expect(headers['Idempotency-Key']).not.toBe('');
    });

    it('auto-generated key conforms to UUID v4 format', async () => {
      const fetchMock = mockOk();
      global.fetch = fetchMock;

      await client().createOrder({ amount_usdc: '10.00' });

      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toMatch(UUID_V4_RE);
    });

    it('generates a unique key on every call without an explicit key', async () => {
      const fetchMock = mockOk();
      global.fetch = fetchMock;

      const c = client();
      await c.createOrder({ amount_usdc: '10.00' });
      await c.createOrder({ amount_usdc: '20.00' });

      const keys = fetchMock.mock.calls.map(
        ([, opts]) => (opts as RequestInit & { headers: Record<string, string> }).headers['Idempotency-Key'],
      );
      expect(keys[0]).toMatch(UUID_V4_RE);
      expect(keys[1]).toMatch(UUID_V4_RE);
      expect(keys[0]).not.toBe(keys[1]);
    });
  });

  // ── Caller-supplied key ────────────────────────────────────────────────────

  describe('caller-supplied key', () => {
    it('forwards a caller-supplied idempotencyKey verbatim in the header', async () => {
      const fetchMock = mockOk();
      global.fetch = fetchMock;

      const callerKey = 'my-custom-idempotency-key-abc123';
      await client().createOrder({ amount_usdc: '10.00', idempotencyKey: callerKey });

      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBe(callerKey);
    });

    it('uses the same caller key on retry (safe deduplication)', async () => {
      // Simulate a single 503 then a 201 to trigger one retry
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          headers: { get: () => null },
          json: async () => ({ error: 'service_temporarily_unavailable' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          headers: { get: () => null },
          json: async () => ORDER_RESPONSE,
        });
      global.fetch = fetchMock;

      const c = new Stellar_CardClient({
        baseUrl: 'http://localhost:3000/v1',
        apiKey: 'stellar_card_test_key',
        retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      });

      const callerKey = 'stable-idempotency-key';
      await c.createOrder({ amount_usdc: '10.00', idempotencyKey: callerKey });

      // Both the initial attempt and the retry must carry the same key
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const call of fetchMock.mock.calls) {
        const [, opts] = call as [string, RequestInit];
        const headers = opts.headers as Record<string, string>;
        expect(headers['Idempotency-Key']).toBe(callerKey);
      }
    });

    it('uses a consistent auto-generated key across retries', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          headers: { get: () => null },
          json: async () => ({ error: 'service_temporarily_unavailable' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          headers: { get: () => null },
          json: async () => ORDER_RESPONSE,
        });
      global.fetch = fetchMock;

      const c = new Stellar_CardClient({
        baseUrl: 'http://localhost:3000/v1',
        apiKey: 'stellar_card_test_key',
        retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      });

      await c.createOrder({ amount_usdc: '10.00' }); // no explicit key

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const keys = fetchMock.mock.calls.map(
        ([, opts]) => (opts as RequestInit & { headers: Record<string, string> }).headers['Idempotency-Key'],
      );
      // Both attempts must carry identical key so retries are safe
      expect(keys[0]).toBe(keys[1]);
      expect(keys[0]).toMatch(UUID_V4_RE);
    });
  });

  // ── Request body integrity ─────────────────────────────────────────────────

  describe('request body integrity', () => {
    it('does not include idempotencyKey in the request body', async () => {
      const fetchMock = mockOk();
      global.fetch = fetchMock;

      const callerKey = 'must-not-appear-in-body';
      await client().createOrder({ amount_usdc: '10.00', idempotencyKey: callerKey });

      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body).not.toHaveProperty('idempotencyKey');
    });

    it('does not include timeout or signal in the request body', async () => {
      const fetchMock = mockOk();
      global.fetch = fetchMock;

      const ctrl = new AbortController();
      await client().createOrder({ amount_usdc: '10.00', signal: ctrl.signal, timeout: 15000 });

      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body).not.toHaveProperty('signal');
      expect(body).not.toHaveProperty('timeout');
    });

    it('preserves amount_usdc and optional fields in body', async () => {
      const fetchMock = mockOk();
      global.fetch = fetchMock;

      await client().createOrder({
        amount_usdc: '25.00',
        webhook_url: 'https://example.com/hook',
        metadata: { ref: 'txn_001' },
      });

      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string);
      expect(body.amount_usdc).toBe('25.00');
      expect(body.webhook_url).toBe('https://example.com/hook');
      expect(body.metadata).toEqual({ ref: 'txn_001' });
    });
  });

  // ── Header alongside auth ──────────────────────────────────────────────────

  describe('header co-existence with auth', () => {
    it('sends both X-Api-Key and Idempotency-Key headers', async () => {
      const fetchMock = mockOk();
      global.fetch = fetchMock;

      await client().createOrder({ amount_usdc: '10.00' });

      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers['X-Api-Key']).toBe('stellar_card_test_key');
      expect(headers['Idempotency-Key']).toMatch(UUID_V4_RE);
    });

    it('sends Content-Type: application/json alongside idempotency key', async () => {
      const fetchMock = mockOk();
      global.fetch = fetchMock;

      await client().createOrder({ amount_usdc: '10.00' });

      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Idempotency-Key']).toMatch(UUID_V4_RE);
    });

    it('sends idempotency key even when custom client-level headers are set', async () => {
      const fetchMock = mockOk();
      global.fetch = fetchMock;

      const c = new Stellar_CardClient({
        baseUrl: 'http://localhost:3000/v1',
        apiKey: 'stellar_card_test_key',
        headers: { 'X-Custom-Client-Header': 'custom-value' },
        retry: { attempts: 0 },
      });

      await c.createOrder({ amount_usdc: '10.00' });

      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toMatch(UUID_V4_RE);
    });
  });

  // ── Endpoint targeting ─────────────────────────────────────────────────────

  describe('endpoint targeting', () => {
    it('sends createOrder request to POST /orders', async () => {
      const fetchMock = mockOk();
      global.fetch = fetchMock;

      await client().createOrder({ amount_usdc: '10.00' });

      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:3000/v1/orders');
      expect(opts.method).toBe('POST');
    });
  });
});
