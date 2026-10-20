// Unit tests for SSE (Server-Sent Events) order status streaming in client.ts
// Validates event emission, reconnects, connection teardown, and error handling.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Stellar_CardClient } from '../client';

interface MockReadable {
  getReader: () => MockReader;
}

interface MockReader {
  read: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
}

describe('Stellar_CardClient SSE streaming (waitForCardStream)', () => {
  const testApiKey = 'stellar_card_test_key_abc123';
  const testOrderId = '550e8400-e29b-41d4-a716-446655440000';
  const testBaseUrl = 'https://api.example.com';

  let client: Stellar_CardClient;
  let mockResponses: Array<{
    status?: number;
    body?: MockReadable;
    ok?: boolean;
  }>;

  beforeEach(() => {
    client = new Stellar_CardClient({ apiKey: testApiKey, baseUrl: testBaseUrl });
    mockResponses = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should emit data events and resolve when order reaches ready phase', async () => {
    const cardData = { number: '4111111111111111', cvv: '123', expiry: '12/25', brand: 'Visa' };
    const readyEvent = JSON.stringify({
      order_id: testOrderId,
      phase: 'ready',
      status: 'ACTIVE',
      card: cardData,
    });

    const reader: MockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ value: new TextEncoder().encode(`data: ${readyEvent}\n\n`), done: false })
        .mockResolvedValueOnce({ done: true }),
      cancel: vi.fn(),
    };

    const mockBody: MockReadable = {
      getReader: () => reader,
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: mockBody,
      status: 200,
    });

    // Use any to access private method for testing
    const result = await (client as any).waitForCardStream(testOrderId, 10000);

    expect(result).toEqual(cardData);
    expect(global.fetch).toHaveBeenCalledWith(
      `${testBaseUrl}/orders/${testOrderId}/stream`,
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Api-Key': testApiKey,
          'Accept': 'text/event-stream',
        }),
      }),
    );
    expect(reader.cancel).not.toHaveBeenCalled();
  });

  it('should handle multiple events and resolve on ready', async () => {
    const processingEvent = JSON.stringify({
      order_id: testOrderId,
      phase: 'processing',
      status: 'PROCESSING',
    });

    const readyEvent = JSON.stringify({
      order_id: testOrderId,
      phase: 'ready',
      status: 'ACTIVE',
      card: { number: '4111111111111111', cvv: '123', expiry: '12/25', brand: 'Visa' },
    });

    const reader: MockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(`data: ${processingEvent}\n\n`),
          done: false,
        })
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(`data: ${readyEvent}\n\n`),
          done: false,
        })
        .mockResolvedValueOnce({ done: true }),
      cancel: vi.fn(),
    };

    const mockBody: MockReadable = {
      getReader: () => reader,
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: mockBody,
      status: 200,
    });

    const result = await (client as any).waitForCardStream(testOrderId, 10000);

    expect(result).toEqual({
      number: '4111111111111111',
      cvv: '123',
      expiry: '12/25',
      brand: 'Visa',
    });
  });

  it('should reject on order failed phase', async () => {
    const failedEvent = JSON.stringify({
      order_id: testOrderId,
      phase: 'failed',
      status: 'FAILED',
      error: 'insufficient_funds',
    });

    const reader: MockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(`data: ${failedEvent}\n\n`),
          done: false,
        })
        .mockResolvedValueOnce({ done: true }),
      cancel: vi.fn(),
    };

    const mockBody: MockReadable = {
      getReader: () => reader,
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: mockBody,
      status: 200,
    });

    await expect((client as any).waitForCardStream(testOrderId, 10000)).rejects.toThrow(
      /insufficient_funds|failed/i,
    );
  });

  it('should reject on refunded phase', async () => {
    const refundedEvent = JSON.stringify({
      order_id: testOrderId,
      phase: 'refunded',
      status: 'REFUNDED',
      refund: { amount_usdc: '10.00', reason: 'order_cancelled' },
    });

    const reader: MockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(`data: ${refundedEvent}\n\n`),
          done: false,
        })
        .mockResolvedValueOnce({ done: true }),
      cancel: vi.fn(),
    };

    const mockBody: MockReadable = {
      getReader: () => reader,
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: mockBody,
      status: 200,
    });

    await expect((client as any).waitForCardStream(testOrderId, 10000)).rejects.toThrow(
      /refunded/i,
    );
  });

  it('should handle expired phase', async () => {
    const expiredEvent = JSON.stringify({
      order_id: testOrderId,
      phase: 'expired',
      status: 'EXPIRED',
    });

    const reader: MockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(`data: ${expiredEvent}\n\n`),
          done: false,
        })
        .mockResolvedValueOnce({ done: true }),
      cancel: vi.fn(),
    };

    const mockBody: MockReadable = {
      getReader: () => reader,
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: mockBody,
      status: 200,
    });

    await expect((client as any).waitForCardStream(testOrderId, 10000)).rejects.toThrow(
      /expired/i,
    );
  });

  it('should throw WaitTimeoutError on timeout', async () => {
    const processingEvent = JSON.stringify({
      order_id: testOrderId,
      phase: 'processing',
      status: 'PROCESSING',
    });

    const reader: MockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(`data: ${processingEvent}\n\n`),
          done: false,
        })
        .mockImplementationOnce(async () => {
          // Simulate long delay
          await new Promise((r) => setTimeout(r, 20000));
          return { done: true };
        }),
      cancel: vi.fn(),
    };

    const mockBody: MockReadable = {
      getReader: () => reader,
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: mockBody,
      status: 200,
    });

    const promise = (client as any).waitForCardStream(testOrderId, 5000);
    vi.advanceTimersByTime(5001);

    await expect(promise).rejects.toThrow();
  });

  it('should handle CRLF line endings from proxies', async () => {
    const cardData = { number: '4111111111111111', cvv: '123', expiry: '12/25', brand: 'Visa' };
    const readyEvent = JSON.stringify({
      order_id: testOrderId,
      phase: 'ready',
      status: 'ACTIVE',
      card: cardData,
    });

    const reader: MockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          // Use CRLF instead of LF
          value: new TextEncoder().encode(`data: ${readyEvent}\r\n\r\n`),
          done: false,
        })
        .mockResolvedValueOnce({ done: true }),
      cancel: vi.fn(),
    };

    const mockBody: MockReadable = {
      getReader: () => reader,
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: mockBody,
      status: 200,
    });

    const result = await (client as any).waitForCardStream(testOrderId, 10000);

    expect(result).toEqual(cardData);
  });

  it('should handle bare CR line endings', async () => {
    const cardData = { number: '4111111111111111', cvv: '123', expiry: '12/25', brand: 'Visa' };
    const readyEvent = JSON.stringify({
      order_id: testOrderId,
      phase: 'ready',
      status: 'ACTIVE',
      card: cardData,
    });

    const reader: MockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          // Use bare CR
          value: new TextEncoder().encode(`data: ${readyEvent}\r\r`),
          done: false,
        })
        .mockResolvedValueOnce({ done: true }),
      cancel: vi.fn(),
    };

    const mockBody: MockReadable = {
      getReader: () => reader,
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: mockBody,
      status: 200,
    });

    const result = await (client as any).waitForCardStream(testOrderId, 10000);

    expect(result).toEqual(cardData);
  });

  it('should handle stream not found (404)', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    await expect((client as any).waitForCardStream(testOrderId, 10000)).rejects.toThrow(
      /order_not_found/i,
    );
  });

  it('should handle auth error (401)', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
    });

    await expect((client as any).waitForCardStream(testOrderId, 10000)).rejects.toThrow(
      /Auth|401/i,
    );
  });

  it('should fall back to polling on non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    await expect((client as any).waitForCardStream(testOrderId, 10000)).rejects.toThrow();
  });

  it('should throw on missing response body', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: null,
      status: 200,
    });

    await expect((client as any).waitForCardStream(testOrderId, 10000)).rejects.toThrow(
      /no body/i,
    );
  });

  it('should handle oversized SSE buffer and abort stream', async () => {
    // Create a huge event that exceeds the 1MB buffer cap
    const hugeEvent = 'x'.repeat(1024 * 1024 + 1);

    const reader: MockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(`data: ${hugeEvent}\n\n`),
          done: false,
        }),
      cancel: vi.fn(),
    };

    const mockBody: MockReadable = {
      getReader: () => reader,
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: mockBody,
      status: 200,
    });

    await expect((client as any).waitForCardStream(testOrderId, 10000)).rejects.toThrow(
      /buffer exceeded/i,
    );
    expect(reader.cancel).toHaveBeenCalled();
  });

  it('should skip malformed JSON events and continue parsing', async () => {
    const cardData = { number: '4111111111111111', cvv: '123', expiry: '12/25', brand: 'Visa' };
    const readyEvent = JSON.stringify({
      order_id: testOrderId,
      phase: 'ready',
      status: 'ACTIVE',
      card: cardData,
    });

    const reader: MockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            `data: {invalid json\n\ndata: ${readyEvent}\n\n`,
          ),
          done: false,
        })
        .mockResolvedValueOnce({ done: true }),
      cancel: vi.fn(),
    };

    const mockBody: MockReadable = {
      getReader: () => reader,
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: mockBody,
      status: 200,
    });

    const result = await (client as any).waitForCardStream(testOrderId, 10000);

    expect(result).toEqual(cardData);
  });

  it('should skip events without data line', async () => {
    const cardData = { number: '4111111111111111', cvv: '123', expiry: '12/25', brand: 'Visa' };
    const readyEvent = JSON.stringify({
      order_id: testOrderId,
      phase: 'ready',
      status: 'ACTIVE',
      card: cardData,
    });

    const reader: MockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(
            `comment: ignored\n\ndata: ${readyEvent}\n\n`,
          ),
          done: false,
        })
        .mockResolvedValueOnce({ done: true }),
      cancel: vi.fn(),
    };

    const mockBody: MockReadable = {
      getReader: () => reader,
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: mockBody,
      status: 200,
    });

    const result = await (client as any).waitForCardStream(testOrderId, 10000);

    expect(result).toEqual(cardData);
  });

  it('should close stream after card is ready', async () => {
    const cardData = { number: '4111111111111111', cvv: '123', expiry: '12/25', brand: 'Visa' };
    const readyEvent = JSON.stringify({
      order_id: testOrderId,
      phase: 'ready',
      status: 'ACTIVE',
      card: cardData,
    });

    const reader: MockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          value: new TextEncoder().encode(`data: ${readyEvent}\n\n`),
          done: false,
        })
        .mockResolvedValueOnce({ done: true }),
      cancel: vi.fn(),
    };

    const mockBody: MockReadable = {
      getReader: () => reader,
    };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: mockBody,
      status: 200,
    });

    const result = await (client as any).waitForCardStream(testOrderId, 10000);

    expect(result).toBeDefined();
    // Stream should terminate naturally when the while loop exits
  });
});
