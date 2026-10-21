/**
 * SDK integration test — exercises Stellar_CardClient's HTTP serialisation
 * against the OpenAPI contract shapes by stubbing global fetch. No
 * Stellar, no VCC, no CTX.
 */

import { describe, it, expect, beforeAll } from 'vitest';

// Allow http:// base URLs in tests (assertSafeBaseUrl rejects them otherwise)
process.env.CARDS402_ALLOW_INSECURE_BASE_URL = '1';

import type { Stellar_CardClient as Stellar_CardClientType } from '../client';

describe('SDK integration (sandbox mode)', () => {
  let Stellar_CardClient: typeof Stellar_CardClientType;

  beforeAll(async () => {
    const mod = await import('../client');
    Stellar_CardClient = mod.Stellar_CardClient;
  });

  it('Stellar_CardClient constructor validates API key', () => {
    expect(() => new Stellar_CardClient({ apiKey: '' })).toThrow();
    expect(() => new Stellar_CardClient({ apiKey: '  ' })).toThrow();
    const client = new Stellar_CardClient({
      apiKey: 'test_key',
      baseUrl: 'http://localhost:1234/v1',
    });
    expect(client).toBeDefined();
  });

  it('Stellar_CardClient has all expected methods', () => {
    const client = new Stellar_CardClient({ apiKey: 'test_key' });
    expect(typeof client.createOrder).toBe('function');
    expect(typeof client.getOrder).toBe('function');
    expect(typeof client.waitForCard).toBe('function');
    expect(typeof client.listOrders).toBe('function');
    expect(typeof client.listOrdersPage).toBe('function');
    expect(typeof client.iterateOrders).toBe('function');
    expect(typeof client.getUsage).toBe('function');
  });

  it('createOrder sends correct request shape', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    let capturedHeaders: Record<string, string> = {};

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = init?.body as string;
      capturedHeaders = (init?.headers || {}) as Record<string, string>;
      return new Response(
        JSON.stringify({
          order_id: 'test-order-id',
          status: 'pending_payment',
          phase: 'awaiting_payment',
          amount_usdc: '10.00',
          payment: {
            type: 'soroban_contract',
            contract_id: 'CTEST',
            order_id: 'test-order-id',
            usdc: { amount: '10.0000000', asset: 'USDC:GTEST' },
          },
          poll_url: '/v1/orders/test-order-id',
          budget: { spent_usdc: '0', limit_usdc: null, remaining_usdc: null },
        }),
        { status: 201 },
      );
    }) as typeof fetch;

    try {
      const client = new Stellar_CardClient({
        apiKey: 'stellar_card_testkey',
        baseUrl: 'http://test/v1',
        retry: { attempts: 0 },
      });
      const result = await client.createOrder({ amount_usdc: '10.00' });

      expect(capturedUrl).toBe('http://test/v1/orders');
      expect(capturedHeaders['X-Api-Key']).toBe('stellar_card_testkey');
      expect(capturedHeaders['Content-Type']).toBe('application/json');
      expect(capturedHeaders['Idempotency-Key']).toBeTruthy();

      const body = JSON.parse(capturedBody);
      expect(body.amount_usdc).toBe('10.00');

      expect(result.order_id).toBe('test-order-id');
      expect(result.payment.type).toBe('soroban_contract');
      expect(result.budget.spent_usdc).toBe('0');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('getOrder sends correct request and parses response', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toContain('/orders/order-123');
      const headers = (init?.headers || {}) as Record<string, string>;
      expect(headers['X-Api-Key']).toBe('stellar_card_testkey');
      return new Response(
        JSON.stringify({
          order_id: 'order-123',
          status: 'delivered',
          phase: 'ready',
          amount_usdc: '5.00',
          payment_asset: 'xlm',
          card: { number: '4111111111111111', cvv: '123', expiry: '12/99', brand: 'Visa' },
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:01:00Z',
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const client = new Stellar_CardClient({
        apiKey: 'stellar_card_testkey',
        baseUrl: 'http://test/v1',
        retry: { attempts: 0 },
      });
      const order = await client.getOrder('order-123');

      expect(order.order_id).toBe('order-123');
      expect(order.phase).toBe('ready');
      expect(order.card?.number).toBe('4111111111111111');
      expect(order.card?.cvv).toBe('123');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('listOrders passes query params correctly', async () => {
    let capturedUrl = '';
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;

    try {
      const client = new Stellar_CardClient({
        apiKey: 'stellar_card_testkey',
        baseUrl: 'http://test/v1',
        retry: { attempts: 0 },
      });
      await client.listOrders({
        status: 'delivered',
        limit: 50,
        offset: 10,
        since_created_at: '2026-01-01T00:00:00Z',
      });

      const url = new URL(capturedUrl);
      expect(url.searchParams.get('status')).toBe('delivered');
      expect(url.searchParams.get('limit')).toBe('50');
      expect(url.searchParams.get('offset')).toBe('10');
      expect(url.searchParams.get('since_created_at')).toBe('2026-01-01T00:00:00Z');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('retry logic retries on 503 and succeeds on second attempt', async () => {
    let attempts = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      attempts++;
      if (attempts === 1) {
        return new Response('', { status: 503 });
      }
      return new Response(
        JSON.stringify({
          api_key_id: 'k1',
          label: 'test',
          budget: { spent_usdc: '0', limit_usdc: null, remaining_usdc: null },
          orders: { total: 0, delivered: 0, failed: 0, refunded: 0, in_progress: 0 },
        }),
        { status: 200 },
      );
    };

    try {
      const client = new Stellar_CardClient({
        apiKey: 'stellar_card_testkey',
        baseUrl: 'http://test/v1',
        retry: { attempts: 2, baseDelayMs: 10, maxDelayMs: 50 },
      });
      const usage = await client.getUsage();
      expect(attempts).toBe(2);
      expect(usage.budget.spent_usdc).toBe('0');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  describe('E2E order creation and card reveal flow', () => {
    it('creates order with USDC payment', async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.endsWith('/orders')) {
          return new Response(
            JSON.stringify({
              order_id: 'order-e2e-1',
              status: 'pending_payment',
              phase: 'awaiting_payment',
              amount_usdc: '10.00',
              payment_asset: 'usdc',
              payment: {
                type: 'soroban_contract',
                contract_id: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
                order_id: 'order-e2e-1',
                usdc: { amount: '10.0000000', asset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' },
              },
              poll_url: '/v1/orders/order-e2e-1',
              budget: { spent_usdc: '10.00', limit_usdc: '100.00', remaining_usdc: '90.00' },
              created_at: '2026-01-01T00:00:00Z',
            }),
            { status: 201 },
          );
        }
        return new Response('', { status: 404 });
      }) as typeof fetch;

      try {
        const client = new Stellar_CardClient({
          apiKey: 'stellar_card_testkey',
          baseUrl: 'http://test/v1',
          retry: { attempts: 0 },
        });
        const order = await client.createOrder({ amount_usdc: '10.00' });

        expect(order.order_id).toBe('order-e2e-1');
        expect(order.status).toBe('pending_payment');
        expect(order.phase).toBe('awaiting_payment');
        expect(order.payment_asset).toBe('usdc');
        expect(order.payment.type).toBe('soroban_contract');
        expect(order.budget.spent_usdc).toBe('10.00');
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('polls order status until fulfillment', async () => {
      let pollCount = 0;
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL) => {
        const urlStr = String(url);
        if (urlStr.endsWith('/order-e2e-2')) {
          pollCount++;
          if (pollCount === 1) {
            return new Response(
              JSON.stringify({
                order_id: 'order-e2e-2',
                status: 'pending_payment',
                phase: 'awaiting_payment',
                amount_usdc: '5.00',
              }),
              { status: 200 },
            );
          }
          if (pollCount === 2) {
            return new Response(
              JSON.stringify({
                order_id: 'order-e2e-2',
                status: 'processing',
                phase: 'soroban_processing',
                amount_usdc: '5.00',
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              order_id: 'order-e2e-2',
              status: 'delivered',
              phase: 'ready',
              amount_usdc: '5.00',
              card: {
                number: '4111111111111111',
                cvv: '123',
                expiry: '12/27',
                brand: 'Visa',
              },
            }),
            { status: 200 },
          );
        }
        return new Response('', { status: 404 });
      }) as typeof fetch;

      try {
        const client = new Stellar_CardClient({
          apiKey: 'stellar_card_testkey',
          baseUrl: 'http://test/v1',
          retry: { attempts: 0 },
        });

        const statuses: string[] = [];
        for (let i = 0; i < 3; i++) {
          const order = await client.getOrder('order-e2e-2');
          statuses.push(order.status);
          if (order.status === 'delivered') break;
        }

        expect(statuses).toEqual(['pending_payment', 'processing', 'delivered']);
        expect(pollCount).toBe(3);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('reveals card with valid PAN and expiry format', async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL) => {
        const urlStr = String(url);
        if (urlStr.endsWith('/order-e2e-3')) {
          return new Response(
            JSON.stringify({
              order_id: 'order-e2e-3',
              status: 'delivered',
              phase: 'ready',
              amount_usdc: '25.00',
              card: {
                number: '4111222233334444',
                cvv: '789',
                expiry: '08/29',
                brand: 'Visa',
              },
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:10:00Z',
            }),
            { status: 200 },
          );
        }
        return new Response('', { status: 404 });
      }) as typeof fetch;

      try {
        const client = new Stellar_CardClient({
          apiKey: 'stellar_card_testkey',
          baseUrl: 'http://test/v1',
          retry: { attempts: 0 },
        });
        const order = await client.getOrder('order-e2e-3');

        expect(order.status).toBe('delivered');
        expect(order.card).toBeDefined();
        expect(order.card?.number).toBe('4111222233334444');

        // Validate PAN format: 16 digits for Visa
        const panRegex = /^\d{16}$/;
        expect(panRegex.test(order.card?.number || '')).toBe(true);

        // Validate expiry format: MM/YY
        const expiryRegex = /^\d{2}\/\d{2}$/;
        expect(expiryRegex.test(order.card?.expiry || '')).toBe(true);

        // Validate CVV: 3-4 digits
        const cvvRegex = /^\d{3,4}$/;
        expect(cvvRegex.test(order.card?.cvv || '')).toBe(true);

        expect(order.card?.brand).toBe('Visa');
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('handles full order workflow: create -> poll -> reveal', async () => {
      const origFetch = globalThis.fetch;
      let requestCount = 0;

      globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const urlStr = String(url);
        requestCount++;

        if (urlStr.endsWith('/orders') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              order_id: 'order-workflow-1',
              status: 'pending_payment',
              phase: 'awaiting_payment',
              amount_usdc: '15.00',
              payment_asset: 'xlm',
              payment: {
                type: 'soroban_contract',
                contract_id: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
                order_id: 'order-workflow-1',
                xlm: { amount: '150.0000000', asset: 'native' },
              },
              budget: { spent_usdc: '15.00', limit_usdc: '500.00', remaining_usdc: '485.00' },
              created_at: '2026-01-01T00:00:00Z',
            }),
            { status: 201 },
          );
        }

        if (urlStr.includes('/order-workflow-1')) {
          if (requestCount <= 2) {
            return new Response(
              JSON.stringify({
                order_id: 'order-workflow-1',
                status: 'processing',
                phase: 'soroban_processing',
                amount_usdc: '15.00',
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              order_id: 'order-workflow-1',
              status: 'delivered',
              phase: 'ready',
              amount_usdc: '15.00',
              card: {
                number: '4999888877776666',
                cvv: '456',
                expiry: '06/28',
                brand: 'Visa',
              },
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:20:00Z',
            }),
            { status: 200 },
          );
        }

        return new Response('', { status: 404 });
      }) as typeof fetch;

      try {
        const client = new Stellar_CardClient({
          apiKey: 'stellar_card_testkey',
          baseUrl: 'http://test/v1',
          retry: { attempts: 0 },
        });

        // Create order
        const createOrder = await client.createOrder({ amount_usdc: '15.00' });
        expect(createOrder.order_id).toBe('order-workflow-1');
        expect(createOrder.status).toBe('pending_payment');

        // Poll for completion
        let order = createOrder;
        let attempts = 0;
        while (order.status !== 'delivered' && attempts < 5) {
          await new Promise((r) => setTimeout(r, 10));
          order = await client.getOrder('order-workflow-1');
          attempts++;
        }

        // Verify card revealed
        expect(order.status).toBe('delivered');
        expect(order.card).toBeDefined();
        expect(order.card?.number).toMatch(/^\d{16}$/);
        expect(order.card?.expiry).toMatch(/^\d{2}\/\d{2}$/);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });
});
