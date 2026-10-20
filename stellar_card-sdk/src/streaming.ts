// Auto-reconnecting WebSocket streaming client with heartbeat ping/pong
// and exponential-backoff reconnect (#740).
//
// This is new: there was no `src/streaming.ts` or any WebSocket client in
// this SDK before. It uses the global `WebSocket` constructor (available
// in both Node 18+ and all modern browsers, via `@types/node`'s ambient
// types — see its lib.dom-adjacent `WebSocket` declaration), so this file
// needs no new runtime dependency (no `ws` package) and works unmodified
// in a browser bundle.

/** A message received on the stream, after JSON-parsing the WS payload. */
export interface StreamMessage {
  channel: string;
  data: unknown;
}

/** Connection lifecycle states a consumer may want to react to. */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface StreamingClientOptions {
  /** `wss://...` (or `ws://...`) endpoint to connect to. */
  url: string;
  /** How often to send a ping while connected, in ms. Default 15000 (15s). */
  heartbeatIntervalMs?: number;
  /** How long to wait for a pong before considering the connection dead, in ms. Default 5000 (5s). */
  heartbeatTimeoutMs?: number;
  /** Base delay for exponential backoff reconnects, in ms. Default 500. */
  reconnectBaseDelayMs?: number;
  /** Cap on the backoff delay, in ms. Default 30000 (30s). */
  reconnectMaxDelayMs?: number;
  /** Called with every lifecycle transition. */
  onStateChange?: (state: ConnectionState) => void;
  /** Called with every decoded message. */
  onMessage?: (message: StreamMessage) => void;
  /** Called on a terminal/unexpected error (does not itself trigger reconnect logic beyond what close already does). */
  onError?: (error: Error) => void;
  /**
   * WebSocket constructor to use. Defaults to the global `WebSocket`.
   * Overridable for tests (a fake/mock implementation) without touching
   * any global.
   */
  WebSocketImpl?: typeof WebSocket;
  /** Clock override for tests — defaults to the real timer functions. */
  _clock?: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
  };
}

const DEFAULTS = {
  heartbeatIntervalMs: 15_000,
  heartbeatTimeoutMs: 5_000,
  reconnectBaseDelayMs: 500,
  reconnectMaxDelayMs: 30_000,
};

/**
 * A reconnecting WebSocket streaming client with:
 * - a heartbeat ping every `heartbeatIntervalMs` while connected;
 * - the connection considered dead (and force-closed, triggering reconnect)
 *   if no pong arrives within `heartbeatTimeoutMs` of a ping;
 * - exponential backoff between reconnect attempts after any drop;
 * - automatic re-subscription to every channel that was subscribed to
 *   before the drop, once the new connection opens;
 * - full timer/socket cleanup on `disconnect()` — no leaked intervals or
 *   listeners survive a disconnect.
 */
export class ReconnectingStreamClient {
  private readonly url: string;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly onStateChange?: (state: ConnectionState) => void;
  private readonly onMessage?: (message: StreamMessage) => void;
  private readonly onError?: (error: Error) => void;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly clock: Required<StreamingClientOptions>['_clock'];

  private socket: WebSocket | null = null;
  private state: ConnectionState = 'closed';
  private readonly subscribedChannels = new Set<string>();
  private reconnectAttempt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set once `disconnect()` has been called, to stop any further reconnect attempts. */
  private disconnected = false;

  constructor(options: StreamingClientOptions) {
    if (!options.url) {
      throw new Error('ReconnectingStreamClient: `url` is required');
    }
    this.url = options.url;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULTS.heartbeatTimeoutMs;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? DEFAULTS.reconnectBaseDelayMs;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? DEFAULTS.reconnectMaxDelayMs;
    this.onStateChange = options.onStateChange;
    this.onMessage = options.onMessage;
    this.onError = options.onError;
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    this.clock = options._clock ?? {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    };
  }

  /** Current lifecycle state. */
  getState(): ConnectionState {
    return this.state;
  }

  /** Channels currently considered "active" (subscribed, and re-subscribed after any reconnect). */
  getSubscribedChannels(): string[] {
    return Array.from(this.subscribedChannels);
  }

  /** Open the connection. Safe to call once; subsequent drops reconnect automatically. */
  connect(): void {
    this.disconnected = false;
    this.openSocket();
  }

  /**
   * Subscribe to a channel. Tracked so that if the connection drops and
   * reconnects, this channel is automatically re-subscribed to on the new
   * connection.
   */
  subscribe(channel: string): void {
    this.subscribedChannels.add(channel);
    this.sendSubscribe(channel);
  }

  /** Unsubscribe from a channel. It will not be re-subscribed to after a future reconnect. */
  unsubscribe(channel: string): void {
    this.subscribedChannels.delete(channel);
    this.send({ type: 'unsubscribe', channel });
  }

  /**
   * Permanently close the connection: cancels any pending reconnect
   * attempt, stops the heartbeat interval and its pong-timeout timer,
   * removes all socket listeners, and closes the socket. After this call
   * the client will not reconnect on its own; call `connect()` again to
   * start fresh.
   */
  disconnect(): void {
    this.disconnected = true;
    this.clearHeartbeat();
    this.clearReconnectTimer();
    this.teardownSocket();
    this.setState('closed');
  }

  // ── internals ──────────────────────────────────────────────────────────

  private setState(state: ConnectionState): void {
    this.state = state;
    this.onStateChange?.(state);
  }

  private openSocket(): void {
    this.setState(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');

    let socket: WebSocket;
    try {
      socket = new this.WebSocketImpl(this.url);
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', this.handleOpen);
    socket.addEventListener('message', this.handleMessage);
    socket.addEventListener('close', this.handleClose);
    socket.addEventListener('error', this.handleError);
  }

  private handleOpen = (): void => {
    this.reconnectAttempt = 0;
    this.setState('open');
    this.startHeartbeat();
    // Re-subscribe to every channel that was active before this connect
    // (first connect: nothing to re-subscribe; post-reconnect: everything
    // the caller had subscribed to before the drop).
    for (const channel of this.subscribedChannels) {
      this.sendSubscribe(channel);
    }
  };

  private handleMessage = (event: MessageEvent): void => {
    let parsed: unknown;
    try {
      parsed = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch {
      this.onError?.(new Error(`Failed to parse WebSocket message: ${String(event.data)}`));
      return;
    }

    if (isPongMessage(parsed)) {
      this.clearHeartbeatTimeout();
      return;
    }

    if (isStreamMessage(parsed)) {
      this.onMessage?.(parsed);
    }
  };

  private handleClose = (): void => {
    this.clearHeartbeat();
    this.teardownSocket();
    if (this.disconnected) {
      this.setState('closed');
      return;
    }
    this.scheduleReconnect();
  };

  private handleError = (): void => {
    this.onError?.(new Error('WebSocket connection error'));
    // The spec guarantees a subsequent 'close' event after 'error' on a
    // real browser/Node WebSocket, so reconnect scheduling happens there,
    // not here, to avoid double-scheduling.
  };

  private teardownSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    socket.removeEventListener('open', this.handleOpen);
    socket.removeEventListener('message', this.handleMessage);
    socket.removeEventListener('close', this.handleClose);
    socket.removeEventListener('error', this.handleError);
    if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
      try {
        socket.close();
      } catch {
        /* already closing/closed — ignore */
      }
    }
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.disconnected) return;
    this.setState('reconnecting');
    const delay = Math.min(
      this.reconnectBaseDelayMs * 2 ** this.reconnectAttempt,
      this.reconnectMaxDelayMs,
    );
    this.reconnectAttempt += 1;
    this.clearReconnectTimer();
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disconnected) this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.clock.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = this.clock.setInterval(() => {
      this.sendPing();
      this.clearHeartbeatTimeout();
      this.heartbeatTimeoutTimer = this.clock.setTimeout(() => {
        // No pong within the timeout: the connection is dead. Force-close
        // it; `handleClose` takes care of scheduling the reconnect.
        this.onError?.(new Error('WebSocket heartbeat timeout: no pong received'));
        this.teardownSocket();
        this.scheduleReconnect();
      }, this.heartbeatTimeoutMs);
    }, this.heartbeatIntervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      this.clock.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearHeartbeatTimeout();
  }

  private clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeoutTimer !== null) {
      this.clock.clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  private sendPing(): void {
    this.send({ type: 'ping' });
  }

  private sendSubscribe(channel: string): void {
    this.send({ type: 'subscribe', channel });
  }

  private send(payload: unknown): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function isPongMessage(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value as { type: unknown }).type === 'pong'
  );
}

function isStreamMessage(value: unknown): value is StreamMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'channel' in value &&
    typeof (value as { channel: unknown }).channel === 'string'
  );
}
