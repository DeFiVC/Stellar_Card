// `MockStellarCardClient` — offline sandbox client tests (#741).

import { describe, it, expect } from 'vitest';
import { MockStellarCardClient, assertMockMatchesRealClientShape } from '../mock';
import { OrderFailedError, WaitTimeoutError } from '../errors';

describe('MockStellarCardClient: structural parity with Stellar_CardClient', () => {
  it('compiles against the shared structural-parity helper (type-level check)', () => {
    // If MockStellarCardClient's method signatures ever drift from
    // Stellar_CardClient's, `assertMockMatchesRealClientShape` fails to
    // compile (see src/mock.ts) long before this test runs. Calling it
    // here keeps that check exercised as part of the normal test run.
    const mock = new MockStellarCardClient();
    const asRealShape = assertMockMatchesRealClientShape(mock);
    expect(typeof asRealShape.createOrder).toBe('function');
    expect(typeof asRealShape.getOrder).toBe('function');
    expect(typeof asRealShape.waitForCard).toBe('function');
    expect(typeof asRealShape.waitForOrderFulfillment).toBe('function');
    expect(typeof asRealShape.listOrders).toBe('function');
    expect(typeof asRealShape.listOrdersPage).toBe('function');
    expect(typeof asRealShape.iterateOrders).toBe('function');
    expect(typeof asRealShape.getUsage).toBe('function');
    expect(typeof asRealShape.reportStatus).toBe('function');
    expect(typeof asRealShape.estimateXlmRequired).toBe('function');
    expect(typeof asRealShape.getAccountBalances).toBe('function');
  });
});

describe('MockStellarCardClient: order creation and in-memory state', () => {
  it('creates an order in pending_payment with no network access', async () => {
    const client = new MockStellarCardClient();
    const response = await client.createOrder({ amount_usdc: '25.00' });
    expect(response.order_id).toBeTruthy();
    expect(response.status).toBe('pending_payment');
    expect(response.payment.usdc.amount).toBe('25.00');
    expect(response.budget).toBeDefined();
  });

  it('returns a fetchable order via getOrder right after creation', async () => {
    const client = new MockStellarCardClient();
    const { order_id } = await client.createOrder({ amount_usdc: '10.00' });
    const status = await client.getOrder(order_id);
    expect(status.order_id).toBe(order_id);
    expect(status.amount_usdc).toBe('10.00');
  });

  it('throws OrderFailedError for an unknown order id', async () => {
    const client = new MockStellarCardClient();
    await expect(client.getOrder('does-not-exist')).rejects.toBeInstanceOf(OrderFailedError);
  });
});

describe('MockStellarCardClient: mock payment state transitions', () => {
  it('advances pending_payment -> active -> delivered/ready across successive getOrder calls', async () => {
    const client = new MockStellarCardClient();
    const { order_id } = await client.createOrder({ amount_usdc: '10.00' });

    const first = await client.getOrder(order_id);
    expect(first.phase).toBe('awaiting_payment');

    const second = await client.getOrder(order_id);
    expect(second.phase).toBe('processing');
    expect(second.status).toBe('active');

    const third = await client.getOrder(order_id);
    expect(third.phase).toBe('ready');
    expect(third.status).toBe('delivered');
    expect(third.card).toBeDefined();
    expect(third.card?.number).toHaveLength(16);
  });

  it('stays at ready/delivered once reached (idempotent terminal state)', async () => {
    const client = new MockStellarCardClient();
    const { order_id } = await client.createOrder({ amount_usdc: '10.00' });
    await client.getOrder(order_id);
    await client.getOrder(order_id);
    const third = await client.getOrder(order_id);
    const fourth = await client.getOrder(order_id);
    expect(fourth.phase).toBe('ready');
    expect(fourth.card?.number).toBe(third.card?.number);
  });
});

describe('MockStellarCardClient: card fulfillment via waitForCard', () => {
  it('resolves with card details once the order reaches ready, polling in-memory', async () => {
    const client = new MockStellarCardClient();
    const { order_id } = await client.createOrder({ amount_usdc: '10.00' });
    const card = await client.waitForCard(order_id, { timeoutMs: 5000 });
    expect(card.number).toHaveLength(16);
    expect(card.brand).toBe('Visa');
  });

  it('times out with WaitTimeoutError when the deadline is in the past', async () => {
    const client = new MockStellarCardClient();
    const { order_id } = await client.createOrder({ amount_usdc: '10.00' });
    await expect(client.waitForCard(order_id, { timeoutMs: 0 })).rejects.toBeInstanceOf(
      WaitTimeoutError,
    );
  });
});

describe('MockStellarCardClient: waitForOrderFulfillment', () => {
  it('resolves once the order becomes ACTIVE or ready-with-card, calling onProgress on each transition', async () => {
    const client = new MockStellarCardClient();
    const { order_id } = await client.createOrder({ amount_usdc: '10.00' });
    const seen: string[] = [];
    const result = await client.waitForOrderFulfillment(order_id, {
      timeoutMs: 5000,
      intervalMs: 1,
      onProgress: (s) => seen.push(`${s.status}:${s.phase}`),
    });
    expect(result.status.toUpperCase()).toBe('ACTIVE');
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe('MockStellarCardClient: listing and pagination', () => {
  it('lists created orders', async () => {
    const client = new MockStellarCardClient();
    await client.createOrder({ amount_usdc: '1.00' });
    await client.createOrder({ amount_usdc: '2.00' });
    const orders = await client.listOrders();
    expect(orders).toHaveLength(2);
  });

  it('filters listOrders by status', async () => {
    const client = new MockStellarCardClient();
    await client.createOrder({ amount_usdc: '1.00' });
    const pendingOnly = await client.listOrders({ status: 'pending_payment' });
    expect(pendingOnly).toHaveLength(1);
    const noneActive = await client.listOrders({ status: 'active' });
    expect(noneActive).toHaveLength(0);
  });

  it('paginates with listOrdersPage, reporting hasMore and nextOffset', async () => {
    const client = new MockStellarCardClient();
    for (let i = 0; i < 5; i++) await client.createOrder({ amount_usdc: '1.00' });

    const page1 = await client.listOrdersPage({ limit: 2, offset: 0 });
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextOffset).toBe(2);

    const page3 = await client.listOrdersPage({ limit: 2, offset: 4 });
    expect(page3.items).toHaveLength(1);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextOffset).toBeNull();
  });

  it('walks every order via iterateOrders across pages', async () => {
    const client = new MockStellarCardClient();
    for (let i = 0; i < 5; i++) await client.createOrder({ amount_usdc: '1.00' });

    const ids: string[] = [];
    for await (const order of client.iterateOrders({ limit: 2 })) {
      ids.push(order.id);
    }
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it('respects maxItems in iterateOrders', async () => {
    const client = new MockStellarCardClient();
    for (let i = 0; i < 5; i++) await client.createOrder({ amount_usdc: '1.00' });

    const ids: string[] = [];
    for await (const order of client.iterateOrders({ limit: 2, maxItems: 3 })) {
      ids.push(order.id);
    }
    expect(ids).toHaveLength(3);
  });
});

describe('MockStellarCardClient: usage / budget', () => {
  it('starts from a default usage summary and increments orders.total on create', async () => {
    const client = new MockStellarCardClient();
    const before = await client.getUsage();
    expect(before.orders.total).toBe(0);

    await client.createOrder({ amount_usdc: '5.00' });
    const after = await client.getUsage();
    expect(after.orders.total).toBe(1);
    expect(after.orders.in_progress).toBe(1);
  });

  it('accepts a seeded initialUsage summary', async () => {
    const client = new MockStellarCardClient({
      initialUsage: {
        api_key_id: 'seeded',
        label: 'seeded-agent',
        budget: {
          spent_usdc: '50.00',
          in_flight_usdc: '0.00',
          committed_usdc: '50.00',
          limit_usdc: '100.00',
          remaining_usdc: '50.00',
        },
        orders: { total: 3, delivered: 2, failed: 0, refunded: 0, in_progress: 1 },
      },
    });
    const usage = await client.getUsage();
    expect(usage.api_key_id).toBe('seeded');
    expect(usage.orders.total).toBe(3);
  });
});

describe('MockStellarCardClient: account balances', () => {
  it('returns default simulated balances for an unseeded account', async () => {
    const client = new MockStellarCardClient();
    const balances = await client.getAccountBalances(
      'GUNSEENACCOUNTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    );
    expect(parseFloat(balances.xlm)).toBeGreaterThan(0);
    expect(balances.funded).toBe(true);
  });

  it('returns seeded balances for a configured account', async () => {
    const client = new MockStellarCardClient({
      initialBalances: {
        GSEEDED: { xlm: '1.0000000', usdc: '0.0000000', balances: [], funded: true },
      },
    });
    const balances = await client.getAccountBalances('GSEEDED');
    expect(balances.xlm).toBe('1.0000000');
  });

  it('lets a test override balances mid-run via setBalances', async () => {
    const client = new MockStellarCardClient();
    client.setBalances('GX', { xlm: '0.0000000', usdc: '0.0000000', balances: [], funded: false });
    const balances = await client.getAccountBalances('GX');
    expect(balances.funded).toBe(false);
  });
});

describe('MockStellarCardClient: estimateXlmRequired', () => {
  it('returns a well-formed XLM estimate without any network call', async () => {
    const client = new MockStellarCardClient();
    const estimate = await client.estimateXlmRequired('10.00');
    expect(parseFloat(estimate.xlmAmount)).toBeGreaterThan(0);
    expect(parseInt(estimate.stroops, 10)).toBeGreaterThan(0);
    expect(estimate.effectiveRate).toBeGreaterThan(0);
    expect(new Date(estimate.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('accepts a numeric amount as well as a string', async () => {
    const client = new MockStellarCardClient();
    const estimate = await client.estimateXlmRequired(5);
    expect(parseFloat(estimate.xlmAmount)).toBeGreaterThan(0);
  });
});

describe('MockStellarCardClient: reportStatus', () => {
  it("never throws, matching the real client's best-effort contract", async () => {
    const client = new MockStellarCardClient();
    await expect(
      client.reportStatus('initializing', { wallet_public_key: 'GX' }),
    ).resolves.toBeUndefined();
  });
});

describe('MockStellarCardClient: configurable mock latency', () => {
  it('delays resolution by a fixed latencyMs', async () => {
    const client = new MockStellarCardClient({ latencyMs: 50 });
    const start = Date.now();
    await client.getUsage();
    expect(Date.now() - start).toBeGreaterThanOrEqual(45); // small tolerance for timer jitter
  });

  it('delays resolution within a jittered [min, max] range', async () => {
    const client = new MockStellarCardClient({ latencyMs: [10, 20], random: () => 1 });
    const start = Date.now();
    await client.getUsage();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(15); // random()=1 -> max end of the range
  });

  it('defaults to zero latency when unset', async () => {
    const client = new MockStellarCardClient();
    const start = Date.now();
    await client.getUsage();
    expect(Date.now() - start).toBeLessThan(20);
  });
});

describe('MockStellarCardClient: configurable error rate', () => {
  it('never errors when errorRate is 0 (default)', async () => {
    const client = new MockStellarCardClient({ random: () => 0.999 });
    await expect(client.getUsage()).resolves.toBeDefined();
  });

  it('always errors when errorRate is 1', async () => {
    const client = new MockStellarCardClient({ errorRate: 1, random: () => 0 });
    await expect(client.getUsage()).rejects.toThrow(/simulated error/i);
  });

  it('respects a fractional errorRate deterministically via an injected random source', async () => {
    let call = 0;
    const sequence = [0.1, 0.9]; // first call "unlucky" (fails), second "lucky" (succeeds) for errorRate=0.5
    const client = new MockStellarCardClient({
      errorRate: 0.5,
      random: () => sequence[call++ % sequence.length] ?? 0,
    });
    await expect(client.getUsage()).rejects.toThrow(/simulated error/i);
    await expect(client.getUsage()).resolves.toBeDefined();
  });
});
