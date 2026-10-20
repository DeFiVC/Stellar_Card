import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderResourceProvider } from '../mcp';
import { Stellar_CardError } from '../errors';
import type { OrderStatus, Stellar_CardClient } from '../client';

const RESOURCE_URI = 'stellar-card://orders/ord_abc123';

function makeOrder(status: string): OrderStatus {
  return {
    order_id: 'ord_abc123',
    status,
    phase: status === 'delivered' ? 'ready' : 'awaiting_payment',
    amount_usdc: '25.00',
    payment_asset: 'USDC',
    payment: {
      type: 'soroban_contract',
      contract_id: 'contract-id',
      order_id: 'ord_abc123',
      usdc: { amount: '25.00', asset: 'USDC:issuer' },
    },
    card:
      status === 'delivered'
        ? { number: '4111111111111111', cvv: '123', expiry: '12/27', brand: 'Visa' }
        : undefined,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function makeProvider(
  getOrder: () => Promise<OrderStatus>,
  notify = vi.fn().mockResolvedValue(undefined),
) {
  const client = { getOrder } as unknown as Pick<Stellar_CardClient, 'getOrder'>;
  return { provider: new OrderResourceProvider(client, notify, 100), notify };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MCP order resources', () => {
  it('returns order status, payment, and fulfillment as JSON', async () => {
    const order = makeOrder('pending_payment');
    const { provider } = makeProvider(vi.fn().mockResolvedValue(order));

    const result = await provider.read(RESOURCE_URI);

    expect(result.contents[0]).toMatchObject({ uri: RESOURCE_URI, mimeType: 'application/json' });
    expect(JSON.parse(result.contents[0].text)).toEqual(order);
  });

  it('uses the standard MCP resource-not-found error for missing orders', async () => {
    const getOrder = vi
      .fn()
      .mockRejectedValue(new Stellar_CardError('Order not found', 'order_not_found', 404));
    const { provider } = makeProvider(getOrder);

    await expect(provider.read(RESOURCE_URI)).rejects.toMatchObject({
      name: 'McpError',
      code: -32002,
    });
  });

  it('notifies subscribers only when the order snapshot changes and stops after unsubscribe', async () => {
    vi.useFakeTimers();
    let order = makeOrder('pending_payment');
    const getOrder = vi.fn().mockImplementation(async () => order);
    const { provider, notify } = makeProvider(getOrder);

    await provider.subscribe(RESOURCE_URI);
    await vi.advanceTimersByTimeAsync(100);
    expect(notify).not.toHaveBeenCalled();

    order = makeOrder('processing');
    await vi.advanceTimersByTimeAsync(100);
    expect(notify).toHaveBeenCalledExactlyOnceWith(RESOURCE_URI);

    provider.unsubscribe(RESOURCE_URI);
    order = makeOrder('delivered');
    await vi.advanceTimersByTimeAsync(200);
    expect(notify).toHaveBeenCalledExactlyOnceWith(RESOURCE_URI);
  });

  it('notifies once and stops polling when a subscribed order disappears', async () => {
    vi.useFakeTimers();
    const getOrder = vi
      .fn()
      .mockResolvedValueOnce(makeOrder('pending_payment'))
      .mockRejectedValue(new Stellar_CardError('Order not found', 'order_not_found', 404));
    const { provider, notify } = makeProvider(getOrder);

    await provider.subscribe(RESOURCE_URI);
    await vi.advanceTimersByTimeAsync(100);
    expect(notify).toHaveBeenCalledExactlyOnceWith(RESOURCE_URI);

    await vi.advanceTimersByTimeAsync(200);
    expect(getOrder).toHaveBeenCalledTimes(2);
  });
});
