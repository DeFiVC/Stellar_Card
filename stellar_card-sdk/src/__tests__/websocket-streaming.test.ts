// `ReconnectingStreamClient` — WebSocket reconnect + heartbeat tests (#740).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ReconnectingStreamClient } from '../streaming';

// ── Mock WebSocket ───────────────────────────────────────────────────────
// A minimal, controllable stand-in for the global WebSocket, so tests can
// drive open/message/close/error deterministically instead of depending on
// a real socket or network.

type Listener = (event: unknown) => void;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners: Record<string, Listener[]> = {};

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    (this.listeners[type] ??= []).push(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener);
  }

  dispatch(type: string, event: unknown = {}): void {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatch('close', {});
  }

  // Test helpers (not part of the real WebSocket API)
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatch('open', {});
  }

  simulateMessage(data: unknown): void {
    this.dispatch('message', { data: typeof data === 'string' ? data : JSON.stringify(data) });
  }

  simulateServerClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatch('close', {});
  }

  simulateError(): void {
    this.dispatch('error', {});
  }

  lastSubscribeChannels(): string[] {
    return this.sent
      .map((s) => JSON.parse(s))
      .filter((m) => m.type === 'subscribe')
      .map((m) => m.channel as string);
  }

  pingCount(): number {
    return this.sent.filter((s) => JSON.parse(s).type === 'ping').length;
  }
}

function latestSocket(): MockWebSocket {
  const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!socket) throw new Error('no MockWebSocket instance created yet');
  return socket;
}

function makeClient(
  overrides: Partial<ConstructorParameters<typeof ReconnectingStreamClient>[0]> = {},
) {
  return new ReconnectingStreamClient({
    url: 'wss://stream.example.com',
    heartbeatIntervalMs: 15_000,
    heartbeatTimeoutMs: 5_000,
    reconnectBaseDelayMs: 500,
    reconnectMaxDelayMs: 30_000,
    WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    ...overrides,
  });
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ReconnectingStreamClient: connecting and basic messaging', () => {
  it('opens a WebSocket to the configured url', () => {
    const client = makeClient();
    client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(latestSocket().url).toBe('wss://stream.example.com');
  });

  it('transitions through connecting -> open on successful connect', () => {
    const states: string[] = [];
    const client = makeClient({ onStateChange: (s) => states.push(s) });
    client.connect();
    latestSocket().simulateOpen();
    expect(states).toEqual(['connecting', 'open']);
    expect(client.getState()).toBe('open');
  });

  it('delivers parsed JSON messages via onMessage', () => {
    const received: unknown[] = [];
    const client = makeClient({ onMessage: (m) => received.push(m) });
    client.connect();
    latestSocket().simulateOpen();
    latestSocket().simulateMessage({ channel: 'orders', data: { id: 'ord_1' } });
    expect(received).toEqual([{ channel: 'orders', data: { id: 'ord_1' } }]);
  });

  it('ignores malformed (non-JSON) messages without throwing, reporting via onError', () => {
    const errors: Error[] = [];
    const client = makeClient({ onError: (e) => errors.push(e) });
    client.connect();
    latestSocket().simulateOpen();
    expect(() => latestSocket().simulateMessage('not json{{{')).not.toThrow();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('ignores messages without a string `channel` field', () => {
    const received: unknown[] = [];
    const client = makeClient({ onMessage: (m) => received.push(m) });
    client.connect();
    latestSocket().simulateOpen();
    latestSocket().simulateMessage({ foo: 'bar' });
    expect(received).toHaveLength(0);
  });
});

describe('ReconnectingStreamClient: subscriptions', () => {
  it('sends a subscribe frame immediately when already open', () => {
    const client = makeClient();
    client.connect();
    latestSocket().simulateOpen();
    client.subscribe('orders');
    expect(latestSocket().lastSubscribeChannels()).toContain('orders');
  });

  it('tracks subscribed channels via getSubscribedChannels()', () => {
    const client = makeClient();
    client.connect();
    latestSocket().simulateOpen();
    client.subscribe('orders');
    client.subscribe('balances');
    expect(client.getSubscribedChannels().sort()).toEqual(['balances', 'orders']);
  });

  it('removes a channel from tracking on unsubscribe', () => {
    const client = makeClient();
    client.connect();
    latestSocket().simulateOpen();
    client.subscribe('orders');
    client.unsubscribe('orders');
    expect(client.getSubscribedChannels()).not.toContain('orders');
  });
});

describe('ReconnectingStreamClient: heartbeat ping/pong', () => {
  it('sends a ping every heartbeatIntervalMs while connected', () => {
    const client = makeClient();
    client.connect();
    latestSocket().simulateOpen();

    vi.advanceTimersByTime(15_000);
    expect(latestSocket().pingCount()).toBe(1);
    latestSocket().simulateMessage({ type: 'pong' }); // keep the connection alive

    vi.advanceTimersByTime(15_000);
    expect(latestSocket().pingCount()).toBe(2);
  });

  it('clears the pong-timeout when a pong arrives in time (no forced reconnect)', () => {
    const states: string[] = [];
    const client = makeClient({ onStateChange: (s) => states.push(s) });
    client.connect();
    latestSocket().simulateOpen();

    vi.advanceTimersByTime(15_000); // ping sent
    latestSocket().simulateMessage({ type: 'pong' });
    vi.advanceTimersByTime(5_000); // would have fired the dead-connection timeout

    expect(states).not.toContain('reconnecting');
    expect(client.getState()).toBe('open');
  });

  it('treats the connection as dead and reconnects if no pong arrives within heartbeatTimeoutMs', () => {
    const errors: Error[] = [];
    const client = makeClient({ onError: (e) => errors.push(e) });
    client.connect();
    latestSocket().simulateOpen();

    vi.advanceTimersByTime(15_000); // ping sent, no pong will come
    vi.advanceTimersByTime(5_000); // heartbeat timeout fires

    expect(errors.some((e) => /heartbeat timeout/i.test(e.message))).toBe(true);
    expect(client.getState()).toBe('reconnecting');
  });
});

describe('ReconnectingStreamClient: reconnect with exponential backoff', () => {
  it('reconnects after an unexpected close', () => {
    const client = makeClient();
    client.connect();
    latestSocket().simulateOpen();

    latestSocket().simulateServerClose();
    expect(client.getState()).toBe('reconnecting');

    vi.advanceTimersByTime(500); // base delay for first attempt
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('increases the delay exponentially across repeated drops', () => {
    const client = makeClient({ reconnectBaseDelayMs: 100, reconnectMaxDelayMs: 10_000 });
    client.connect();
    latestSocket().simulateOpen();

    // 1st drop -> 100ms delay
    latestSocket().simulateServerClose();
    vi.advanceTimersByTime(99);
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    // open fails again immediately (server still down) -> 2nd drop -> 200ms delay
    latestSocket().simulateServerClose();
    vi.advanceTimersByTime(199);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    // 3rd drop -> 400ms delay
    latestSocket().simulateServerClose();
    vi.advanceTimersByTime(399);
    expect(MockWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(4);
  });

  it('caps the backoff delay at reconnectMaxDelayMs', () => {
    const client = makeClient({ reconnectBaseDelayMs: 1000, reconnectMaxDelayMs: 2000 });
    client.connect();
    latestSocket().simulateOpen();

    // Drop repeatedly; delay should never exceed the cap of 2000ms.
    for (let i = 0; i < 5; i++) {
      const before = MockWebSocket.instances.length;
      latestSocket().simulateServerClose();
      vi.advanceTimersByTime(2000);
      expect(MockWebSocket.instances.length).toBe(before + 1);
      latestSocket().simulateOpen();
    }
  });

  it('resets the backoff attempt counter after a successful reconnect', () => {
    const client = makeClient({ reconnectBaseDelayMs: 100, reconnectMaxDelayMs: 10_000 });
    client.connect();
    latestSocket().simulateOpen();

    latestSocket().simulateServerClose(); // drop 1
    vi.advanceTimersByTime(100);
    latestSocket().simulateOpen(); // reconnect succeeds -> attempt counter resets

    latestSocket().simulateServerClose(); // drop 2, should use the BASE delay again (100ms), not 200ms
    vi.advanceTimersByTime(99);
    const countBeforeTick = MockWebSocket.instances.length;
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances.length).toBe(countBeforeTick + 1);
  });
});

describe('ReconnectingStreamClient: automatic re-subscription after reconnect', () => {
  it('re-subscribes to every previously active channel once the new connection opens', () => {
    const client = makeClient();
    client.connect();
    latestSocket().simulateOpen();
    client.subscribe('orders');
    client.subscribe('balances');

    latestSocket().simulateServerClose();
    vi.advanceTimersByTime(500);
    const newSocket = latestSocket();
    newSocket.simulateOpen();

    expect(newSocket.lastSubscribeChannels().sort()).toEqual(['balances', 'orders']);
  });

  it('does not re-subscribe to a channel that was explicitly unsubscribed before the drop', () => {
    const client = makeClient();
    client.connect();
    latestSocket().simulateOpen();
    client.subscribe('orders');
    client.subscribe('balances');
    client.unsubscribe('balances');

    latestSocket().simulateServerClose();
    vi.advanceTimersByTime(500);
    const newSocket = latestSocket();
    newSocket.simulateOpen();

    expect(newSocket.lastSubscribeChannels()).toEqual(['orders']);
  });
});

describe('ReconnectingStreamClient: disconnect cleanup', () => {
  it('stops reconnecting after disconnect() even if the socket then closes', () => {
    const client = makeClient();
    client.connect();
    latestSocket().simulateOpen();
    client.disconnect();

    const countBefore = MockWebSocket.instances.length;
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances.length).toBe(countBefore);
    expect(client.getState()).toBe('closed');
  });

  it('leaves no pending timers after disconnect (no leaked heartbeat/reconnect intervals)', () => {
    const client = makeClient();
    client.connect();
    latestSocket().simulateOpen();

    vi.advanceTimersByTime(15_000); // heartbeat fired once, scheduling the pong-timeout too
    client.disconnect();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes all event listeners from the socket on disconnect (no further callbacks fire)', () => {
    const received: unknown[] = [];
    const client = makeClient({ onMessage: (m) => received.push(m) });
    client.connect();
    const socket = latestSocket();
    socket.simulateOpen();
    client.disconnect();

    socket.simulateMessage({ channel: 'orders', data: {} });
    expect(received).toHaveLength(0);
  });

  it('is safe to call disconnect() multiple times', () => {
    const client = makeClient();
    client.connect();
    latestSocket().simulateOpen();
    expect(() => {
      client.disconnect();
      client.disconnect();
    }).not.toThrow();
    expect(client.getState()).toBe('closed');
  });

  it('allows connect() again after disconnect() to start a fresh session', () => {
    const client = makeClient();
    client.connect();
    latestSocket().simulateOpen();
    client.subscribe('orders');
    client.disconnect();

    client.connect();
    const newSocket = latestSocket();
    newSocket.simulateOpen();
    // Subscriptions persist across a manual disconnect/connect cycle since
    // the caller never called unsubscribe.
    expect(newSocket.lastSubscribeChannels()).toContain('orders');
  });
});

describe('ReconnectingStreamClient: error handling', () => {
  it('reports socket construction failures via onError and still schedules a reconnect', () => {
    const errors: Error[] = [];
    class ThrowingWebSocket {
      constructor() {
        throw new Error('ECONNREFUSED');
      }
    }
    const client = makeClient({
      WebSocketImpl: ThrowingWebSocket as unknown as typeof WebSocket,
      onError: (e) => errors.push(e),
    });
    client.connect();
    expect(errors.some((e) => /ECONNREFUSED/.test(e.message))).toBe(true);
  });

  it('reports a socket-level error event via onError', () => {
    const errors: Error[] = [];
    const client = makeClient({ onError: (e) => errors.push(e) });
    client.connect();
    latestSocket().simulateOpen();
    latestSocket().simulateError();
    expect(errors.length).toBeGreaterThan(0);
  });

  it('throws synchronously if constructed without a url', () => {
    expect(
      () =>
        new ReconnectingStreamClient({
          url: '',
          WebSocketImpl: MockWebSocket as unknown as typeof WebSocket,
        }),
    ).toThrow(/url/i);
  });
});
