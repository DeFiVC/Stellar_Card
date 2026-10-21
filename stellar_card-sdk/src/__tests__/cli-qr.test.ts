// `stellar_card qr <order-id>` CLI command (issue #727).

import { describe, it, expect } from 'vitest';
import { qrCommand, buildQrDataForOrder } from '../commands/qr';

const ORDER_AWAITING_PAYMENT = {
  order_id: 'ord_abc',
  status: 'pending_payment',
  phase: 'awaiting_payment' as const,
  amount_usdc: '10.00',
  payment_asset: 'usdc',
  payment: {
    type: 'soroban_contract',
    contract_id: 'CARDS402CONTRACTIDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    usdc: { amount: '10.00', asset: 'USDC:GA5Z...' },
  },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const ORDER_DELIVERED = {
  order_id: 'ord_def',
  status: 'delivered',
  phase: 'ready' as const,
  amount_usdc: '25.00',
  payment_asset: 'xlm',
  card: { number: '4111111111111234', cvv: '123', expiry: '12/27', brand: 'Visa' },
  created_at: '2026-01-02T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

function harness(client: Record<string, unknown>) {
  let out = '';
  let err = '';
  return {
    deps: {
      client: client as never,
      out: (t: string) => (out += t),
      err: (t: string) => (err += t),
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

describe('buildQrDataForOrder', () => {
  it('encodes contract + amount + asset for an order awaiting Soroban payment', () => {
    const data = buildQrDataForOrder(ORDER_AWAITING_PAYMENT as never);
    expect(data).toContain('id=ord_abc');
    expect(data).toContain('amount=10.00');
    expect(data).toContain('contract=');
  });

  it('falls back to order id + amount + status for a delivered order (no payment field)', () => {
    const data = buildQrDataForOrder(ORDER_DELIVERED as never);
    expect(data).toContain('id=ord_def');
    expect(data).toContain('amount=25.00');
    expect(data).toContain('status=delivered');
  });
});

describe('qrCommand', () => {
  it('prints terminal QR art + encoded data by default', async () => {
    const h = harness({ getOrder: async () => ORDER_AWAITING_PAYMENT });
    const code = await qrCommand(['ord_abc'], h.deps);
    expect(code).toBe(0);
    expect(h.out).toContain('id=ord_abc');
    // Terminal art uses block characters
    expect(/[█▀▄]/.test(h.out)).toBe(true);
  });

  it('prints SVG with --svg', async () => {
    const h = harness({ getOrder: async () => ORDER_AWAITING_PAYMENT });
    const code = await qrCommand(['ord_abc', '--svg'], h.deps);
    expect(code).toBe(0);
    expect(h.out.trim().startsWith('<svg')).toBe(true);
  });

  it('prints a PNG data URL with --png', async () => {
    const h = harness({ getOrder: async () => ORDER_AWAITING_PAYMENT });
    const code = await qrCommand(['ord_abc', '--png'], h.deps);
    expect(code).toBe(0);
    expect(h.out.trim().startsWith('data:image/png;base64,')).toBe(true);
  });

  it('prints structured JSON with --json', async () => {
    const h = harness({ getOrder: async () => ORDER_AWAITING_PAYMENT });
    const code = await qrCommand(['ord_abc', '--json'], h.deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(h.out);
    expect(parsed.order_id).toBe('ord_abc');
    expect(parsed.data).toContain('id=ord_abc');
    expect(parsed.svg).toContain('<svg');
    expect(parsed.png_data_url).toContain('data:image/png');
  });

  it('errors with usage message when no order id is given', async () => {
    const h = harness({ getOrder: async () => ORDER_AWAITING_PAYMENT });
    const code = await qrCommand([], h.deps);
    expect(code).toBe(2);
    expect(h.err).toContain('usage: stellar_card qr');
  });

  it('errors cleanly when the order lookup fails', async () => {
    const h = harness({
      getOrder: async () => {
        throw new Error('order not found');
      },
    });
    const code = await qrCommand(['ord_missing'], h.deps);
    expect(code).toBe(1);
    expect(h.err).toContain('order not found');
  });
});
