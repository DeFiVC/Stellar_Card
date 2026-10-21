// Unit tests for the sliding-window token-bucket request throttle
// (issue #728): src/network.ts RequestThrottle + Stellar_CardClient's
// maxRequestsPerSecond wiring.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RequestThrottle, RequestPriority } from '../network';
import { Stellar_CardClient } from '../client';

describe('RequestThrottle — construction', () => {
  it('defaults to 10 requests per 1000ms window', () => {
    const throttle = new RequestThrottle();
    expect(throttle.limit).toBe(10);
  });

  it('accepts a custom maxRequestsPerSecond', () => {
    const throttle = new RequestThrottle({ maxRequestsPerSecond: 3 });
    expect(throttle.limit).toBe(3);
  });

  it('rejects a non-positive maxRequestsPerSecond', () => {
    expect(() => new RequestThrottle({ maxRequestsPerSecond: 0 })).toThrow(/positive integer/);
    expect(() => new RequestThrottle({ maxRequestsPerSecond: -1 })).toThrow(/positive integer/);
  });

  it('rejects a non-integer maxRequestsPerSecond', () => {
    expect(() => new RequestThrottle({ maxRequestsPerSecond: 2.5 })).toThrow(/positive integer/);
  });

  it('rejects a non-positive windowMs', () => {
    expect(() => new RequestThrottle({ windowMs: 0 })).toThrow(/positive integer/);
  });
});

describe('RequestThrottle — under the limit', () => {
  it('runs tasks immediately when under the rate limit', async () => {
    const throttle = new RequestThrottle({ maxRequestsPerSecond: 10 });
    const results = await Promise.all([
      throttle.schedule(() => Promise.resolve(1)),
      throttle.schedule(() => Promise.resolve(2)),
      throttle.schedule(() => Promise.resolve(3)),
    ]);
    expect(results).toEqual([1, 2, 3]);
    expect(throttle.queueLength).toBe(0);
  });

  it('propagates rejection from the scheduled task', async () => {
    const throttle = new RequestThrottle({ maxRequestsPerSecond: 10 });
    await expect(throttle.schedule(() => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
  });
});

describe('RequestThrottle — sliding window queuing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues requests beyond the per-window limit and runs them once the window opens', async () => {
    const throttle = new RequestThrottle({ maxRequestsPerSecond: 2, windowMs: 1000 });
    const order: number[] = [];
    const makeTask = (id: number) => () => {
      order.push(id);
      return Promise.resolve(id);
    };

    const p1 = throttle.schedule(makeTask(1));
    const p2 = throttle.schedule(makeTask(2));
    // These two run immediately — capacity is 2.
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([1, 2]);

    // Third request exceeds capacity within the same window — queues.
    const p3 = throttle.schedule(makeTask(3));
    await vi.advanceTimersByTimeAsync(0);
    expect(throttle.queueLength).toBeGreaterThan(0);
    expect(order).toEqual([1, 2]);

    // Advance past the window — queued task should now run.
    await vi.advanceTimersByTimeAsync(1001);
    expect(order).toEqual([1, 2, 3]);

    await Promise.all([p1, p2, p3]);
  });

  it('never exceeds maxRequestsPerSecond starts within any 1-second window', async () => {
    const throttle = new RequestThrottle({ maxRequestsPerSecond: 3, windowMs: 1000 });
    const startTimes: number[] = [];
    const tasks = Array.from({ length: 9 }, () =>
      throttle.schedule(() => {
        startTimes.push(Date.now());
        return Promise.resolve();
      }),
    );

    // Drain the queue across several windows.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    await Promise.all(tasks);

    // Bucket start times into 1s windows and verify no bucket exceeds the limit.
    const buckets = new Map<number, number>();
    for (const t of startTimes) {
      const bucket = Math.floor(t / 1000);
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    for (const count of buckets.values()) {
      expect(count).toBeLessThanOrEqual(3);
    }
    expect(startTimes.length).toBe(9);
  });
});

describe('RequestThrottle — priority ordering', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a Critical task ahead of previously-queued Normal tasks once capacity frees up', async () => {
    const throttle = new RequestThrottle({ maxRequestsPerSecond: 1, windowMs: 1000 });
    const order: string[] = [];

    // Saturate the single slot in this window.
    const pFirst = throttle.schedule(() => {
      order.push('first');
      return Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['first']);

    // Queue two Normal requests and one Critical request behind them.
    const pNormalA = throttle.schedule(() => {
      order.push('normalA');
      return Promise.resolve();
    }, RequestPriority.Normal);
    const pNormalB = throttle.schedule(() => {
      order.push('normalB');
      return Promise.resolve();
    }, RequestPriority.Normal);
    const pCritical = throttle.schedule(() => {
      order.push('critical');
      return Promise.resolve();
    }, RequestPriority.Critical);

    expect(throttle.queueLength).toBe(3);

    // Drain through three more windows — critical must come out first,
    // then the two normals in original (FIFO) order.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    await Promise.all([pFirst, pNormalA, pNormalB, pCritical]);
    expect(order).toEqual(['first', 'critical', 'normalA', 'normalB']);
  });
});

describe('Stellar_CardClient — maxRequestsPerSecond wiring', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('does not throttle by default (no maxRequestsPerSecond configured)', async () => {
    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount++;
      return new Response(JSON.stringify({ order_id: 'x' }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new Stellar_CardClient({ apiKey: 'test-key', maxRequestsPerSecond: undefined });
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => client.getOrder(`order-${i}`.padEnd(8, '0'))),
    );
    expect(callCount).toBe(5);
  });

  it('accepts maxRequestsPerSecond without throwing and still completes requests', async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ order_id: 'x' }), { status: 200 }),
    ) as unknown as typeof fetch;

    const client = new Stellar_CardClient({ apiKey: 'test-key', maxRequestsPerSecond: 5 });
    const result = await client.getOrder('order_1');
    expect(result).toEqual({ order_id: 'x' });
  });
});
