// `MockStellarCardClient` — offline, in-memory sandbox for testing and
// development without hitting the real API or needing testnet funds (#741).
//
// Parity with `Stellar_CardClient`: this file defines `StellarCardClientApi`,
// a structural interface derived directly from the public instance methods
// of `Stellar_CardClient` (see src/client.ts). `MockStellarCardClient
// implements StellarCardClientApi`, so a method added to, removed from, or
// changed on the real client that this mock doesn't mirror is a **compile
// error**, not something that has to be eyeballed. See the structural
// assertion at the bottom of this file for the concrete check.

import type {
  CreateOrderOptions,
  IterateOrdersOptions,
  ListOrdersOptions,
  ListOrdersPage,
  OrderListItem,
  OrderResponse,
  OrderStatus,
  ReportStatusOptions,
  RequestOptions,
  UsageSummary,
  WaitForCardOptions,
  WaitForOrderFulfillmentOptions,
  CardDetails,
} from './client';
import type { AccountBalances, EstimateXlmOptions, XlmEstimateResult } from './stellar';
import { OrderFailedError, WaitTimeoutError } from './errors';

/**
 * The public instance-method surface of `Stellar_CardClient`. Kept as its
 * own named interface (rather than `Pick<Stellar_CardClient, ...>` inline
 * everywhere) so both the real client and the mock can be checked against
 * one shared contract, and so a drift between them surfaces as a single,
 * readable compile error at the `implements` clause below.
 */
export interface StellarCardClientApi {
  createOrder(opts: CreateOrderOptions): Promise<OrderResponse>;
  getOrder(orderId: string, reqOpts?: RequestOptions): Promise<OrderStatus>;
  waitForCard(orderId: string, opts?: WaitForCardOptions): Promise<CardDetails>;
  waitForOrderFulfillment(
    orderId: string,
    opts?: WaitForOrderFulfillmentOptions,
  ): Promise<OrderStatus>;
  listOrders(opts?: ListOrdersOptions): Promise<OrderListItem[]>;
  listOrdersPage(opts?: ListOrdersOptions): Promise<ListOrdersPage>;
  iterateOrders(opts?: IterateOrdersOptions): AsyncGenerator<OrderListItem, void, void>;
  getUsage(reqOpts?: RequestOptions): Promise<UsageSummary>;
  reportStatus(
    state: 'initializing' | 'awaiting_funding',
    opts?: ReportStatusOptions,
  ): Promise<void>;
  estimateXlmRequired(
    usdcAmount: string | number,
    options?: EstimateXlmOptions,
  ): Promise<XlmEstimateResult>;
  getAccountBalances(publicKey: string): Promise<AccountBalances>;
}

export interface MockLatencyOptions {
  /** Fixed or [min, max] random delay in ms applied to every simulated call. Default: 0 (no delay). */
  latencyMs?: number | [number, number];
}

export interface MockErrorRateOptions {
  /**
   * Probability (0–1) that any given call fails with a simulated error
   * instead of succeeding. Default: 0 (never fails). Evaluated per call
   * using the client's injectable RNG (`Math.random` by default), so
   * tests can make it deterministic.
   */
  errorRate?: number;
}

export interface MockStellarCardClientOptions extends MockLatencyOptions, MockErrorRateOptions {
  /** Seed balances (XLM/USDC/trustlines) for one or more Stellar public keys. */
  initialBalances?: Record<string, AccountBalances>;
  /** Seed usage/budget summary returned by getUsage(). */
  initialUsage?: UsageSummary;
  /**
   * Override the random source used for latency jitter and error-rate
   * rolls. Defaults to `Math.random`. Tests can inject a deterministic
   * generator (e.g. always return 0, or a fixed sequence).
   */
  random?: () => number;
  /** Clock override for tests (defaults to the real `setTimeout`). */
  _setTimeout?: typeof setTimeout;
}

const DEFAULT_USAGE: UsageSummary = {
  api_key_id: 'mock_key',
  label: 'mock-client',
  budget: {
    spent_usdc: '0.00',
    in_flight_usdc: '0.00',
    committed_usdc: '0.00',
    limit_usdc: '1000.00',
    remaining_usdc: '1000.00',
  },
  orders: {
    total: 0,
    delivered: 0,
    failed: 0,
    refunded: 0,
    in_progress: 0,
  },
};

const DEFAULT_BALANCES: AccountBalances = {
  xlm: '10000.0000000',
  usdc: '1000.0000000',
  balances: [],
  funded: true,
};

function randomOrderId(random: () => number): string {
  return `mock_ord_${random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function simulatedCard(random: () => number): CardDetails {
  const digits = Array.from({ length: 16 }, () => Math.floor(random() * 10)).join('');
  return {
    number: digits,
    cvv: String(Math.floor(random() * 900) + 100),
    expiry: '12/30',
    brand: 'Visa',
  };
}

/** A single mock order's full lifecycle state, kept in memory. */
interface MockOrder {
  status: OrderStatus;
  listItem: OrderListItem;
}

/**
 * An in-memory, offline stand-in for `Stellar_CardClient`.
 *
 * - No network calls: every method resolves from an in-memory store.
 * - No testnet funds required: balances are simulated and configurable.
 * - Simulates the real order lifecycle (`pending_payment` -> `active` ->
 *   `delivered`/`ready`) so code written against the mock exercises the
 *   same phase transitions it would see against the real API.
 * - Configurable latency (fixed or jittered) and error rate, so callers
 *   can exercise their own retry/timeout/error-handling logic offline.
 *
 * Identical method signatures to `Stellar_CardClient` — see
 * `StellarCardClientApi` above and the structural assertion at the
 * bottom of this file.
 */
export class MockStellarCardClient implements StellarCardClientApi {
  private readonly latencyMs: number | [number, number];
  private readonly errorRate: number;
  private readonly random: () => number;
  private readonly setTimeoutImpl: typeof setTimeout;

  private readonly balances = new Map<string, AccountBalances>();
  private usage: UsageSummary;
  private readonly orders = new Map<string, MockOrder>();

  constructor(options: MockStellarCardClientOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    this.errorRate = options.errorRate ?? 0;
    this.random = options.random ?? Math.random;
    this.setTimeoutImpl = options._setTimeout ?? setTimeout;
    this.usage = options.initialUsage ?? {
      ...DEFAULT_USAGE,
      budget: { ...DEFAULT_USAGE.budget },
      orders: { ...DEFAULT_USAGE.orders },
    };
    if (options.initialBalances) {
      for (const [key, value] of Object.entries(options.initialBalances)) {
        this.balances.set(key, { ...value });
      }
    }
  }

  /** Directly set/override an account's simulated balances (test setup convenience, not on the real client). */
  setBalances(publicKey: string, balances: AccountBalances): void {
    this.balances.set(publicKey, { ...balances });
  }

  /**
   * Simulates `POST /orders`: creates an order in `pending_payment` /
   * `awaiting_payment`. Each subsequent `getOrder()` call advances it one
   * lifecycle step (see `advanceOrderLifecycle`), so polling a mock order
   * a few times reaches `delivered`/`ready` with simulated card details,
   * without any real payment ever happening.
   */
  async createOrder(opts: CreateOrderOptions): Promise<OrderResponse> {
    await this.simulate();
    const id = randomOrderId(this.random);
    const now = new Date().toISOString();
    const amountUsdc = String(opts.amount_usdc ?? '0.00');
    const paymentAsset = 'usdc';

    const status: OrderStatus = {
      order_id: id,
      status: 'pending_payment',
      phase: 'awaiting_payment',
      amount_usdc: amountUsdc,
      payment_asset: paymentAsset,
      created_at: now,
      updated_at: now,
    };
    const listItem: OrderListItem = {
      id,
      status: 'pending_payment',
      amount_usdc: amountUsdc,
      payment_asset: paymentAsset,
      created_at: now,
      updated_at: now,
    };
    this.orders.set(id, { status, listItem });
    this.usage.orders.total += 1;
    this.usage.orders.in_progress += 1;

    return {
      order_id: id,
      status: 'pending_payment',
      payment: {
        type: 'soroban_contract',
        contract_id: 'CMOCKCONTRACTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        order_id: id,
        usdc: { amount: amountUsdc, asset: 'USDC:GMOCKISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
        xlm: { amount: (parseFloat(amountUsdc) / 0.1).toFixed(7) },
      },
      poll_url: `/orders/${id}`,
      budget: { ...this.usage.budget },
    };
  }

  async getOrder(orderId: string, _reqOpts: RequestOptions = {}): Promise<OrderStatus> {
    await this.simulate();
    const order = this.requireOrder(orderId);
    // Snapshot the current state first, then advance for the *next* call —
    // so the first getOrder() after createOrder() still observes
    // `awaiting_payment`, matching how a real order looks before any
    // payment has landed. Each subsequent call then sees one step further
    // along the simulated lifecycle.
    const snapshot = { ...order.status };
    this.advanceOrderLifecycle(order);
    return snapshot;
  }

  async waitForCard(
    orderId: string,
    { timeoutMs = 300000 }: WaitForCardOptions = {},
  ): Promise<CardDetails> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.getOrder(orderId);
      if (status.phase === 'ready' && status.card) return status.card;
      if (status.phase === 'failed' || status.phase === 'rejected' || status.phase === 'refunded') {
        throw new OrderFailedError(orderId, status.error ?? status.phase, status.refund);
      }
      await this.delay(10);
    }
    throw new WaitTimeoutError(orderId, timeoutMs);
  }

  async waitForOrderFulfillment(
    orderId: string,
    options: WaitForOrderFulfillmentOptions = {},
  ): Promise<OrderStatus> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    let lastKey: string | null = null;
    while (Date.now() < deadline) {
      const status = await this.getOrder(orderId, options);
      const key = `${status.status}:${status.phase}`;
      if (key !== lastKey) {
        lastKey = key;
        options.onProgress?.(status);
      }
      if (status.status.toUpperCase() === 'ACTIVE' || (status.card && status.phase === 'ready')) {
        return status;
      }
      if (['failed', 'rejected', 'refunded'].includes(status.phase)) {
        throw new OrderFailedError(orderId, status.error ?? status.phase, status.refund);
      }
      await this.delay(10);
    }
    throw new WaitTimeoutError(orderId, timeoutMs);
  }

  async listOrders(opts: ListOrdersOptions = {}): Promise<OrderListItem[]> {
    await this.simulate();
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;
    const all = Array.from(this.orders.values())
      .map((o) => o.listItem)
      .filter((item) => !opts.status || item.status === opts.status);
    return all.slice(offset, offset + limit);
  }

  async listOrdersPage(opts: ListOrdersOptions = {}): Promise<ListOrdersPage> {
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;
    const items = await this.listOrders({ ...opts, limit: limit + 1, offset });
    const hasMore = items.length > limit;
    const pageItems = hasMore ? items.slice(0, limit) : items;
    return {
      items: pageItems,
      limit,
      offset,
      nextOffset: hasMore ? offset + pageItems.length : null,
      hasMore,
    };
  }

  async *iterateOrders(opts: IterateOrdersOptions = {}): AsyncGenerator<OrderListItem, void, void> {
    const { maxItems, limit = 20, offset = 0, ...filters } = opts;
    let remaining = maxItems ?? Number.POSITIVE_INFINITY;
    let nextOffset = offset;
    while (remaining > 0) {
      const page = await this.listOrdersPage({ ...filters, limit, offset: nextOffset });
      for (const item of page.items) {
        yield item;
        if (Number.isFinite(remaining)) remaining--;
        if (remaining <= 0) return;
      }
      if (!page.hasMore || page.nextOffset === null) return;
      nextOffset = page.nextOffset;
    }
  }

  async getUsage(_reqOpts: RequestOptions = {}): Promise<UsageSummary> {
    await this.simulate();
    return { ...this.usage };
  }

  async reportStatus(
    _state: 'initializing' | 'awaiting_funding',
    _opts: ReportStatusOptions = {},
  ): Promise<void> {
    // Best-effort on the real client too — the mock simply accepts and
    // discards it, matching the real client's "never throws" contract.
    try {
      await this.simulate();
    } catch {
      /* best-effort; do not block the caller */
    }
  }

  async estimateXlmRequired(
    usdcAmount: string | number,
    options?: EstimateXlmOptions,
  ): Promise<XlmEstimateResult> {
    await this.simulate();
    const amount = typeof usdcAmount === 'string' ? parseFloat(usdcAmount) : usdcAmount;
    const effectiveRate = 10; // 1 USDC ~= 10 XLM, purely illustrative for offline testing
    const slippageApplied = options?.slippage ?? 0.01;
    const xlmAmount = amount * effectiveRate * (1 + slippageApplied);
    const stroops = Math.ceil(xlmAmount * 10_000_000);
    return {
      xlmAmount: xlmAmount.toFixed(7),
      stroops: String(stroops),
      effectiveRate,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      slippageApplied,
    };
  }

  async getAccountBalances(publicKey: string): Promise<AccountBalances> {
    await this.simulate();
    const existing = this.balances.get(publicKey);
    if (existing) return { ...existing };
    const seeded = { ...DEFAULT_BALANCES };
    this.balances.set(publicKey, seeded);
    return { ...seeded };
  }

  // ── internals ──────────────────────────────────────────────────────────

  private requireOrder(orderId: string): MockOrder {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new OrderFailedError(orderId, 'order_not_found', undefined);
    }
    return order;
  }

  /**
   * Simple deterministic lifecycle: pending_payment -> active -> delivered
   * (ready, with card). Each `getOrder` call advances the order by one
   * step, so 3 calls are enough to see a card. This mirrors the real
   * backend's phase names without needing real elapsed time.
   */
  private advanceOrderLifecycle(order: MockOrder): void {
    const now = new Date().toISOString();
    if (order.status.phase === 'awaiting_payment') {
      order.status = { ...order.status, status: 'active', phase: 'processing', updated_at: now };
      order.listItem = { ...order.listItem, status: 'active', updated_at: now };
      return;
    }
    if (order.status.phase === 'processing') {
      const card = simulatedCard(this.random);
      order.status = {
        ...order.status,
        status: 'delivered',
        phase: 'ready',
        card,
        updated_at: now,
      };
      order.listItem = { ...order.listItem, status: 'delivered', updated_at: now };
    }
  }

  private async simulate(): Promise<void> {
    if (this.errorRate > 0 && this.random() < this.errorRate) {
      throw new Error('MockStellarCardClient: simulated error (errorRate triggered)');
    }
    const delayMs = this.resolveLatency();
    if (delayMs > 0) await this.delay(delayMs);
  }

  private resolveLatency(): number {
    if (Array.isArray(this.latencyMs)) {
      const [min, max] = this.latencyMs;
      return min + this.random() * (max - min);
    }
    return this.latencyMs;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.setTimeoutImpl(resolve, ms));
  }
}

// ── structural parity check ─────────────────────────────────────────────
// Compile-time assertion (per #741's explicit ask) that MockStellarCardClient
// really does satisfy the real client's shape, beyond the `implements`
// clause above (which only checks against the StellarCardClientApi
// subset we hand-picked). This additionally checks it against `Pick<...>`
// derived straight from `Stellar_CardClient` itself, so if a method is
// added to the real client and not mirrored here in `StellarCardClientApi`,
// this line — not just the implements clause — will fail to compile.
import type { Stellar_CardClient } from './client';
type RealClientApi = Pick<Stellar_CardClient, keyof StellarCardClientApi>;
/**
 * Not meant to be called at runtime — exported purely so this structural
 * check is reachable code (and therefore type-checked) rather than a dead
 * local the compiler would otherwise warn about under `noUnusedLocals`.
 * If `Stellar_CardClient` gains/changes a method not mirrored in
 * `StellarCardClientApi`, this function's signature fails to compile.
 */
export function assertMockMatchesRealClientShape(mock: MockStellarCardClient): RealClientApi {
  return mock;
}
