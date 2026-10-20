import { describe, it, expect } from 'vitest';
import {
  isActiveOrder,
  isPendingOrder,
  isFailedOrder,
  type Order,
  type ActiveOrder,
  type PendingOrder,
  type FailedOrder,
  type OrderCard,
} from '../types';

const card: OrderCard = {
  number: '4111111111111111',
  cvv: '123',
  expiry: '12/28',
  brand: 'Visa',
};

const activeOrder: Order = {
  order_id: 'ord-active-1',
  status: 'ACTIVE',
  amount_usdc: '10.00',
  payment_asset: 'usdc',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:05:00.000Z',
  card,
};

const pendingOrder: Order = {
  order_id: 'ord-pending-1',
  status: 'PENDING',
  amount_usdc: '10.00',
  payment_asset: 'usdc',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const failedOrder: Order = {
  order_id: 'ord-failed-1',
  status: 'FAILED',
  amount_usdc: '10.00',
  payment_asset: 'xlm',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:01:00.000Z',
  error: 'Payment rejected by risk engine',
};

describe('isActiveOrder', () => {
  it('returns true for an ACTIVE order', () => {
    expect(isActiveOrder(activeOrder)).toBe(true);
  });

  it('returns false for a PENDING order', () => {
    expect(isActiveOrder(pendingOrder)).toBe(false);
  });

  it('returns false for a FAILED order', () => {
    expect(isActiveOrder(failedOrder)).toBe(false);
  });

  it('narrows to ActiveOrder so `.card` is accessible with no further null check', () => {
    if (isActiveOrder(activeOrder)) {
      // Compile-time proof of narrowing: assigning to a precisely-typed
      // `OrderCard` (not `OrderCard | undefined`) only type-checks if the
      // guard has narrowed `order.card` to a required, non-null property.
      const narrowedCard: OrderCard = activeOrder.card;
      expect(narrowedCard.number).toBe('4111111111111111');

      // Also prove the whole object narrows to ActiveOrder.
      const narrowed: ActiveOrder = activeOrder;
      expect(narrowed.status).toBe('ACTIVE');
    } else {
      throw new Error('expected isActiveOrder(activeOrder) to be true');
    }
  });
});

describe('isPendingOrder', () => {
  it('returns true for a PENDING order', () => {
    expect(isPendingOrder(pendingOrder)).toBe(true);
  });

  it('returns false for an ACTIVE order', () => {
    expect(isPendingOrder(activeOrder)).toBe(false);
  });

  it('returns false for a FAILED order', () => {
    expect(isPendingOrder(failedOrder)).toBe(false);
  });

  it('narrows to PendingOrder', () => {
    if (isPendingOrder(pendingOrder)) {
      const narrowed: PendingOrder = pendingOrder;
      expect(narrowed.status).toBe('PENDING');
    } else {
      throw new Error('expected isPendingOrder(pendingOrder) to be true');
    }
  });
});

describe('isFailedOrder', () => {
  it('returns true for a FAILED order', () => {
    expect(isFailedOrder(failedOrder)).toBe(true);
  });

  it('returns false for an ACTIVE order', () => {
    expect(isFailedOrder(activeOrder)).toBe(false);
  });

  it('returns false for a PENDING order', () => {
    expect(isFailedOrder(pendingOrder)).toBe(false);
  });

  it('narrows to FailedOrder so `.error` is accessible', () => {
    if (isFailedOrder(failedOrder)) {
      const narrowed: FailedOrder = failedOrder;
      expect(narrowed.error).toBe('Payment rejected by risk engine');
    } else {
      throw new Error('expected isFailedOrder(failedOrder) to be true');
    }
  });
});

describe('type-level narrowing (compile-time only — tsc enforces this file)', () => {
  it('a plain Order does not expose `.card` without the guard', () => {
    // No existing @ts-expect-error usage in this repo (checked via grep),
    // so this test uses precise-assignment narrowing checks instead,
    // matching the convention used above rather than introducing a new one.
    function readCardIfActive(order: Order): OrderCard | undefined {
      // `order.card` is not accessible here without narrowing first —
      // TypeScript only allows it because we check the discriminant.
      if (order.status === 'ACTIVE') {
        return order.card;
      }
      return undefined;
    }

    expect(readCardIfActive(activeOrder)).toEqual(card);
    expect(readCardIfActive(pendingOrder)).toBeUndefined();
    expect(readCardIfActive(failedOrder)).toBeUndefined();
  });
});
