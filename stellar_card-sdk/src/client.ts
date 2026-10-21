export {
  Stellar_CardError,
  SpendLimitError,
  RateLimitError,
  ServiceUnavailableError,
  PriceUnavailableError,
  InvalidAmountError,
  AuthError,
  OrderFailedError,
  WaitTimeoutError,
  ResumableError,
} from './errors';
import {
  parseApiError,
  Stellar_CardError as Stellar_CardErrorCtor,
  OrderFailedError,
  WaitTimeoutError,
  AuthError as AuthErrorCtor,
  ValidationError,
  TimeoutError,
  AbortError,
} from './errors';
import { calculateExponentialBackoffDelay, sleep } from './retry';
import { createLogger, type Logger, type LogLevel } from './logger';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  withRequestTimeout,
  sanitizeHeaders,
  mergeHeaders,
  RequestThrottle,
  RequestPriority,
  type RequestOptions,
} from './network';
import { validateClientOptions, validateCreateOrderInput } from './validation';
import type { AccountBalances } from './stellar';
import {
  createTelemetryCollector,
  createTelemetryEndpoint,
  isTelemetryEnabled,
  type TelemetryCollector,
  type TelemetryFeature,
} from './telemetry';

export type { RequestOptions } from './network';

export interface Budget {
  spent_usdc: string;
  /** In-flight orders (pending_payment, ordering, etc.) not yet settled. */
  in_flight_usdc: string;
  /** spent_usdc + in_flight_usdc — the committed total against the limit. */
  committed_usdc: string;
  limit_usdc: string | null;
  remaining_usdc: string | null;
}

export interface UsageSummary {
  api_key_id: string;
  label: string | null;
  budget: Budget;
  orders: {
    total: number;
    delivered: number;
    failed: number;
    refunded: number;
    in_progress: number;
  };
}

export interface OrderOptions {
  amount_usdc: string;
  webhook_url?: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentInstructions {
  // Tag identifying the payment model — currently always "soroban_contract".
  type: 'soroban_contract';
  // Stellar_Card receiver contract ID (C...) on Soroban.
  contract_id: string;
  // Order ID — pass this verbatim as the order_id argument to pay_usdc/pay_xlm.
  order_id: string;
  // USDC quote: amount as a 7-decimal string and the SAC asset in "CODE:ISSUER" form.
  usdc: { amount: string; asset: string };
  // XLM quote — present when the order supports XLM payment (always in current backend).
  xlm?: { amount: string };
}

export interface OrderResponse {
  order_id: string;
  status: string;
  payment: PaymentInstructions;
  poll_url: string;
  budget: Budget;
}

export interface CardDetails {
  number: string;
  cvv: string;
  expiry: string;
  brand: string | null;
}

export type OrderPhase =
  | 'awaiting_approval'
  | 'awaiting_payment'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'refunded'
  | 'rejected'
  | 'expired';

// Returned by GET /orders (list) — a subset of OrderStatus without card details.
// Note: uses `id` not `order_id`, and omits `phase` (use status to derive it).
export interface OrderListItem {
  id: string;
  status: string;
  amount_usdc: string;
  payment_asset: string;
  created_at: string;
  updated_at: string;
}

export interface OrderStatus {
  order_id: string;
  status: string;
  phase: OrderPhase;
  amount_usdc: string;
  payment_asset: string;
  card?: CardDetails;
  error?: string;
  note?: string;
  refund?: { stellar_txid: string };
  /**
   * Present when status === 'pending_payment'. Carries the Soroban
   * contract invocation the agent needs to submit. The backend
   * stores this verbatim in orders.vcc_payment_json and re-emits it
   * on GET /orders/:id so a resumed purchaseCardOWS can rebuild a
   * fresh payment tx without having to recompute the payment
   * instructions from scratch. Used by the F1-resume fix for dropped
   * Soroban txs.
   */
  payment?: PaymentInstructions;
  created_at: string;
  updated_at: string;
}

export interface RetryOptions {
  /** Max number of retry attempts on transient failures. 0 disables retries. */
  attempts?: number;
  /** Initial backoff in ms. Doubles on each retry. */
  baseDelayMs?: number;
  /** Max backoff cap in ms. */
  maxDelayMs?: number;
  /** Jitter strategy used for retry delays. Defaults to full jitter. */
  jitter?: 'full' | 'equal' | 'decorrelated' | 'none';
  /** Optional callback invoked before waiting for each retry. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export interface CreateOrderOptions extends OrderOptions, RequestOptions {
  /** Optional idempotency key for caller-managed create-order retries. */
  idempotencyKey?: string;
}

export interface WaitForCardOptions {
  /** Total time budget for SSE + polling fallback. Defaults to 300000ms. */
  timeoutMs?: number;
  /**
   * Polling interval in milliseconds used by the HTTP-polling fallback
   * when the SSE stream is unavailable. Defaults to 3000ms.
   */
  pollIntervalMs?: number;
}

export interface ListOrdersOptions extends RequestOptions {
  status?: string;
  limit?: number;
  offset?: number;
  since_created_at?: string;
  since_updated_at?: string;
}

export interface ListOrdersPage {
  /** Orders returned for the requested page. */
  items: OrderListItem[];
  /** Number of items requested for this page. */
  limit: number;
  /** Zero-based offset used to fetch this page. */
  offset: number;
  /** Offset to pass into the next request, or null when exhausted. */
  nextOffset: number | null;
  /**
   * Whether another request is available. Determined by probing one
   * extra row so callers do not need to infer it themselves.
   */
  hasMore: boolean;
}

export interface IterateOrdersOptions extends ListOrdersOptions {
  /** Optional hard cap on the total number of orders yielded. */
  maxItems?: number;
}

export interface ReportStatusOptions extends RequestOptions {
  wallet_public_key?: string;
  detail?: string;
}

/** A single entry from `GET /dashboard/audit` (#731). */
export interface AuditLogEntry {
  id: string;
  timestamp: string;
  action: string;
  actor: string;
  result: 'success' | 'failure' | string;
  detail?: string;
}

export interface ListAuditLogsOptions extends RequestOptions {
  /** Filter by action name, e.g. `"order.create"`. */
  action?: string;
  /** Page size. Defaults to 20. */
  limit?: number;
  /** ISO-8601 lower bound on `timestamp`. */
  since?: string;
}

export interface StellarCardClientOptions {
  baseUrl?: string;
  apiKey?: string;
  retry?: RetryOptions;
  logger?: Logger;
  logLevel?: LogLevel;
  /** Default per-request timeout in ms. Defaults to 30000. */
  timeout?: number;
  /** Stellar network used by on-chain helpers such as {@link Stellar_CardClient.getAccountBalances}. */
  network?: 'mainnet' | 'testnet' | 'futurenet';
  /** Optional Soroban RPC URL override. */
  rpcUrl?: string;
  /** Custom HTTP headers attached to all outgoing requests. */
  headers?: Record<string, string>;
  /** Disable automatic startup SDK version checking. */
  disableVersionCheck?: boolean;
  /** Enable anonymous SDK telemetry. Disabled unless explicitly opted in. */
  telemetry?: boolean;
  /**
   * Client-side throttle for outgoing API/Horizon requests (#728). When
   * set, requests queue automatically once this many requests have
   * started within the current 1-second sliding window, instead of
   * firing immediately and risking a Horizon 429. Transaction-submission
   * requests are prioritized ahead of routine polling/read requests
   * within the queue. Unset (default) disables throttling entirely —
   * existing callers see no behavior change.
   */
  maxRequestsPerSecond?: number;
}

export interface WaitForOrderFulfillmentOptions extends RequestOptions {
  /** Polling interval in milliseconds. Defaults to 2000 (2s). */
  intervalMs?: number;
  /** Maximum wait timeout in milliseconds. Defaults to 120000 (120s). */
  timeoutMs?: number;
  /** Optional callback invoked on order state transitions. */
  onProgress?: (status: OrderStatus) => void;
}

// Shared order-ID shape validator. Keeps the client, the MCP tool,
// and anything else that stamps an order id into a URL in lockstep.
// The backend mints UUIDv4 but we allow any 1–64 char alphanumeric +
// `_` + `-` string so hand-crafted test ids still work.
const ORDER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
function validateOrderId(orderId: string): void {
  if (typeof orderId !== 'string' || !ORDER_ID_PATTERN.test(orderId)) {
    throw new Stellar_CardErrorCtor(
      `Invalid order id: ${String(orderId).slice(0, 32)}`,
      'invalid_order_id',
      400,
    );
  }
}

function normalizeIntegerOption(
  field: 'limit' | 'offset' | 'maxItems',
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) {
    throw new ValidationError(field, 'must be an integer');
  }
  if (field === 'limit' && value < 1) {
    throw new ValidationError(field, 'must be at least 1');
  }
  if ((field === 'offset' || field === 'maxItems') && value < 0) {
    throw new ValidationError(field, 'must be a non-negative integer');
  }
  return value;
}

/** High-level SDK client for the stellar_card REST API. */
export class Stellar_CardClient {
  private baseUrl: string;
  private apiKey: string;
  private retry: Required<RetryOptions>;
  public readonly logger: Logger;
  private timeout: number;
  private network: 'mainnet' | 'testnet' | 'futurenet';
  private headers: Record<string, string>;
  private telemetry: TelemetryCollector;
  /** Set only when `maxRequestsPerSecond` is configured; undefined means throttling is off. */
  private throttle?: RequestThrottle;

  /**
   * Create a client from explicit options, env vars, or on-disk config.
   *
   * Credential resolution order:
   * 1. Explicit constructor arguments (`apiKey`, `baseUrl`).
   * 2. `CARDS402_API_KEY` / `CARDS402_BASE_URL` environment variables.
   * 3. `~/.stellar_card/config.json` written by `stellar_card onboard`.
   *
   * @param opts.apiKey - stellar_card API key. Required via one of the sources above.
   * @param opts.baseUrl - API base URL. Defaults to `https://api.stellar_card.com/v1`.
   * @param opts.retry - Retry policy applied to transient (429/502/503/504) errors.
   * @param opts.logger - Optional custom logger implementation (Pino, Winston, Console).
   * @param opts.logLevel - Optional log level filter ('debug' | 'info' | 'warn' | 'error' | 'silent').
   * @param opts.headers - Optional custom HTTP headers to attach to all outgoing requests.
   * @param opts.disableVersionCheck - Optional boolean to disable SDK version checks on startup.
   * @throws {AuthError} When no API key can be resolved.
   */
  constructor(options: StellarCardClientOptions = {}) {
    // Fail fast on malformed options (#700) with every bad field listed.
    validateClientOptions(options);
    const {
      baseUrl,
      apiKey,
      retry = {},
      logger,
      logLevel,
      headers,
      disableVersionCheck: _disableVersionCheck,
    } = options;
    this.logger = createLogger({ logger, logLevel });
    this.timeout = options.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.network = options.network ?? 'mainnet';
    this.headers = sanitizeHeaders(headers);
    this.throttle =
      options.maxRequestsPerSecond !== undefined
        ? new RequestThrottle({ maxRequestsPerSecond: options.maxRequestsPerSecond })
        : undefined;

    // Resolve api key + base URL in priority order:
    //   1. Explicit constructor args
    //   2. CARDS402_API_KEY / CARDS402_BASE_URL env vars
    //   3. ~/.stellar_card/config.json (written by `stellar_card onboard`)
    // This lets agents that went through the claim-code onboarding
    // flow just do `new Stellar_CardClient()` without passing anything.
    //
    // Use a synchronous require of ./config so the auto-load path
    // doesn't force callers into an async constructor.
    let resolvedKey = apiKey;
    let resolvedBase = baseUrl;
    if (!resolvedKey || !resolvedBase) {
      try {
        // Synchronous require avoids forcing the constructor to be async.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const config = require('./config');
        const resolved = (
          config as {
            resolveCredentials: (opts: { apiKey?: string; baseUrl?: string }) => {
              apiKey: string | undefined;
              baseUrl: string | undefined;
            };
          }
        ).resolveCredentials({ apiKey: resolvedKey, baseUrl: resolvedBase });
        if (!resolvedKey) resolvedKey = resolved.apiKey;
        if (!resolvedBase) resolvedBase = resolved.baseUrl;
      } catch {
        /* config helper unavailable (e.g. in a browser bundle) — fall through */
      }
    }
    if (!resolvedKey || !resolvedKey.trim()) throw new AuthErrorCtor();
    // F1-client-constructor (2026-04-16): validate baseUrl unconditionally.
    // Pre-fix, assertSafeBaseUrl only ran inside resolveCredentials —
    // which is skipped entirely when both apiKey and baseUrl are passed
    // explicitly (the common case for MCP, CLI purchase, and OWS callers).
    // An http:// or ftp:// URL would be used as-is, sending the agent's
    // API key over plaintext. Now every code path is covered.
    const finalBase = resolvedBase || 'https://api.stellar_card.com/v1';
    try {
      // Lazy-require to avoid circular deps in the browser-bundle path
      // where config.ts isn't available. If assertSafeBaseUrl isn't
      // loadable (browser, bundler that tree-shook config.ts), fall
      // through to the bare URL — the same behaviour as before the fix,
      // which is correct for environments without a filesystem.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { assertSafeBaseUrl } = require('./config') as {
        assertSafeBaseUrl: (url: string, opts?: { context?: string }) => string;
      };
      assertSafeBaseUrl(finalBase, { context: 'Stellar_CardClient constructor' });
    } catch (err) {
      // Re-throw URL-safety rejections (non-HTTPS, userinfo, etc.)
      // but swallow "module not found" errors from environments where
      // config.ts isn't bundled.
      if (err instanceof Error && !err.message.includes('Cannot find module')) {
        throw err;
      }
    }
    this.baseUrl = finalBase.replace(/\/$/, '');
    this.apiKey = resolvedKey;
    this.telemetry = createTelemetryCollector({
      enabled: isTelemetryEnabled(options.telemetry),
      endpoint: createTelemetryEndpoint(this.baseUrl),
    });
    // Audit A-23: default to retry on transient errors so every agent doesn't
    // reimplement its own backoff loop. 2 retries with 500ms base + 5s cap
    // covers brief network blips without punishing a persistent outage.
    this.retry = {
      attempts: retry.attempts ?? 2,
      baseDelayMs: retry.baseDelayMs ?? 500,
      maxDelayMs: retry.maxDelayMs ?? 5000,
      jitter: retry.jitter ?? 'full',
      onRetry: retry.onRetry ?? (() => undefined),
    };
  }

  private async handleError(res: Response): Promise<never> {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw parseApiError(res.status, body);
  }

  // Retry only on transient/network errors. Non-idempotent 2xx-class errors
  // (validation, auth, policy) are NOT retried because they're not transient.
  // createOrder is special-cased: it passes an Idempotency-Key so retries are
  // safe for 5xx and network errors only.
  private shouldRetry(status: number): boolean {
    return status === 429 || status === 503 || status === 504 || status === 502 || status === 0;
  }

  /**
   * Classify a request for the (optional) client-side throttle queue.
   * POSTs to the order-creation endpoint submit a payment/transaction
   * flow and are latency-sensitive, so they jump the queue ahead of
   * routine GET polling (status/usage/list) when `maxRequestsPerSecond`
   * is configured. See {@link RequestThrottle}.
   */
  private classifyPriority(url: string, init: RequestInit): RequestPriority {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'POST' && /\/orders(\?|$)/.test(url)) {
      return RequestPriority.Critical;
    }
    return RequestPriority.Normal;
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    { timeout = this.timeout, signal, headers: reqHeaders }: RequestOptions = {},
    telemetryFeature: TelemetryFeature = 'api_request',
  ): Promise<Response> {
    const { attempts, baseDelayMs, maxDelayMs, jitter, onRetry } = this.retry;
    const operation = `${init.method ?? 'GET'} ${url}`;
    let lastErr: unknown;
    this.logger.debug(`HTTP ${init.method ?? 'GET'} ${url}`);

    const baseHeaders = (init.headers as Record<string, string>) ?? {};
    const finalHeaders = mergeHeaders(baseHeaders, this.headers, reqHeaders);
    const mergedInit: RequestInit = {
      ...init,
      headers: finalHeaders,
    };
    const priority = this.classifyPriority(url, init);

    for (let i = 0; i <= attempts; i++) {
      try {
        const doFetch = (s: AbortSignal) => fetch(url, { ...mergedInit, signal: s });
        const res = await withRequestTimeout(
          operation,
          (s) => (this.throttle ? this.throttle.schedule(() => doFetch(s), priority) : doFetch(s)),
          {
            timeout,
            signal,
          },
        );
        if (res.ok || !this.shouldRetry(res.status) || i === attempts) {
          if (!res.ok) this.telemetry.recordFeatureError(telemetryFeature);
          this.logger.debug(`HTTP ${res.status} for ${init.method ?? 'GET'} ${url}`);
          return res;
        }
        lastErr = new Error(`HTTP ${res.status}`);
        // Enhanced exponential backoff with full jitter and Retry-After header support
        const delayMs = calculateExponentialBackoffDelay({
          attempt: i,
          baseDelayMs,
          maxDelayMs,
          retryAfter: res.headers?.get?.('Retry-After') ?? null,
          jitter,
          factor: 2, // Standard exponential backoff factor
        });
        this.logger.info(
          `Retrying request to ${url} (attempt ${i + 1}/${attempts}) after ${delayMs}ms due to HTTP ${res.status}`,
          { attempt: i, delayMs, status: res.status },
        );
        onRetry(lastErr, i, delayMs);
        await sleep(delayMs);
        continue;
      } catch (err) {
        lastErr = err;
        // Timeouts and caller aborts are final — never retried.
        if (err instanceof TimeoutError || err instanceof AbortError) throw err;
        if (i === attempts) {
          this.telemetry.recordFeatureError(telemetryFeature);
          this.logger.error(`HTTP request to ${url} failed after ${attempts} retries`, {
            error: err,
          });
          throw err;
        }
        // Enhanced exponential backoff for network errors
        const delayMs = calculateExponentialBackoffDelay({
          attempt: i,
          baseDelayMs,
          maxDelayMs,
          jitter,
          factor: 2,
        });
        this.logger.info(
          `Retrying request to ${url} (attempt ${i + 1}/${attempts}) after ${delayMs}ms due to network error`,
          { attempt: i, delayMs, error: err },
        );
        onRetry(err, i, delayMs);
        await sleep(delayMs);
      }
    }
    // Unreachable because we always either return or throw above.
    throw lastErr ?? new Error('fetchWithRetry: exhausted without result');
  }

  /**
   * Create a new card order and return the payment instructions.
   *
   * An `Idempotency-Key` is automatically generated (or forwarded from
   * `opts.idempotencyKey`) so retrying a 5xx response can never produce
   * duplicate charges.
   *
   * @param opts.amount_usdc - Card amount as a decimal string, e.g. `"10.00"`.
   * @param opts.idempotencyKey - Optional caller-supplied idempotency key.
   * @param opts.webhook_url - Optional webhook URL for order-status push events.
   * @param opts.metadata - Arbitrary key/value pairs forwarded to the backend.
   * @returns Order response containing payment instructions and initial budget.
   * @throws {InvalidAmountError} When `amount_usdc` is outside `[0.01, 10000]`.
   * @throws {AuthError} When the API key is invalid or missing.
   * @throws {SpendLimitError} When the API key's spend limit is exhausted.
   * @throws {RateLimitError} When the order-creation rate limit (60/hour) is hit.
   */
  async createOrder(opts: CreateOrderOptions): Promise<OrderResponse> {
    validateCreateOrderInput(opts);
    const { idempotencyKey: providedKey, timeout, signal, ...body } = opts;
    const idempotencyKey = providedKey ?? crypto.randomUUID();
    // Safe to retry: the Idempotency-Key collapses duplicate creates on the
    // backend, so replaying on a 5xx/timeout can't charge twice.
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/orders`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': this.apiKey,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      },
      { timeout, signal },
      'orders',
    );
    if (!res.ok) return this.handleError(res);
    return res.json() as Promise<OrderResponse>;
  }

  /**
   * Fetch the current status for a single order.
   *
   * @param orderId - Order UUID returned by {@link createOrder}.
   * @returns Current order status including phase and card details when ready.
   * @throws {ValidationError} When `orderId` fails the UUID-shaped pattern check.
   * @throws {AuthError} When the API key is invalid.
   */
  async getOrder(orderId: string, reqOpts: RequestOptions = {}): Promise<OrderStatus> {
    // Validate and encode — path param must be a UUID-shaped identifier.
    // The server also validates, but failing here avoids a round-trip
    // on typos and eliminates a path-traversal surface on misuse.
    validateOrderId(orderId);
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/orders/${encodeURIComponent(orderId)}`,
      { headers: { 'X-Api-Key': this.apiKey } },
      reqOpts,
      'orders',
    );
    if (!res.ok) return this.handleError(res);
    return res.json() as Promise<OrderStatus>;
  }

  /**
   * Wait until the order reaches `ready` and card details are available.
   *
   * Uses SSE first and falls back to HTTP polling if the stream cannot
   * be established or is interrupted by the network path.
   *
   * @param orderId - Order UUID to wait for.
   * @param opts - Options for waiting including timeout and poll interval.
   * @returns A promise resolving to the card details once ready.
   * @throws {WaitTimeoutError} When the timeout is reached before the order is ready.
   */
  async waitForCard(
    orderId: string,
    { timeoutMs = 300000, pollIntervalMs = 3000 }: WaitForCardOptions = {},
  ): Promise<CardDetails> {
    validateOrderId(orderId);
    const deadlineMs = Date.now() + timeoutMs;
    try {
      return await this.waitForCardStream(orderId, timeoutMs);
    } catch (err) {
      if (
        err instanceof OrderFailedError ||
        err instanceof WaitTimeoutError ||
        err instanceof Stellar_CardErrorCtor
      ) {
        throw err;
      }
      if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
        throw new WaitTimeoutError(orderId, timeoutMs);
      }
      const remainingMs = Math.max(0, deadlineMs - Date.now());
      if (remainingMs === 0) throw new WaitTimeoutError(orderId, timeoutMs);
      return this.waitForCardPoll(orderId, remainingMs, pollIntervalMs);
    }
  }

  // SSE fast path.
  private async waitForCardStream(orderId: string, timeoutMs: number): Promise<CardDetails> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/orders/${orderId}/stream`, {
        headers: mergeHeaders(
          { 'X-Api-Key': this.apiKey, Accept: 'text/event-stream' },
          this.headers,
        ),
        signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status === 404) throw new OrderFailedError(orderId, 'order_not_found', undefined);
        if (res.status === 401) throw new AuthErrorCtor();
        // Fall back to polling on any other non-2xx.
        throw new Error(`stream http ${res.status}`);
      }
      if (!res.body) throw new Error('stream has no body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // F2-sdk (2026-04-16): cap the SSE buffer so a misbehaving server
      // or MITM can't OOM the agent process by injecting a single
      // multi-megabyte "event" between delimiters. 1 MB is generous for
      // any realistic SSE payload (the backend sends <2 KB per phase
      // change); anything larger is definitionally adversarial or corrupt.
      const SSE_BUFFER_CAP = 1024 * 1024;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // F1-sdk (2026-04-16): normalize CRLF and bare CR to LF before
        // accumulating into the buffer. The SSE spec (HTML Living
        // Standard § EventSource) defines end-of-line as \r\n, \r, or
        // \n. The backend sends \n, but a transparent HTTP proxy
        // (nginx on Windows, some Cloudflare configs, corporate proxy
        // appliances) can rewrite line endings to \r\n. Pre-fix, the
        // parser split on '\n\n' only — a \r\n rewrite meant
        // buffer.indexOf('\n\n') never matched and the buffer grew
        // unbounded until OOM. Normalizing at ingestion fixes all
        // three delimiter variants in one step.
        const chunk = decoder
          .decode(value, { stream: true })
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n');
        buffer += chunk;

        // F2-sdk: abort if the buffer exceeds the cap — drop the stream
        // and fall through to the polling fallback (or re-throw as a
        // generic error that waitForCard's catch handler routes to
        // polling).
        if (buffer.length > SSE_BUFFER_CAP) {
          reader.cancel();
          throw new Error('sse buffer exceeded 1 MB — aborting stream');
        }

        // Split on blank lines — each SSE event is terminated by \n\n.
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = raw.split('\n').find((line) => line.startsWith('data: '));
          if (!dataLine) continue;
          const json = dataLine.slice(6);
          let payload: OrderStatus;
          try {
            payload = JSON.parse(json) as OrderStatus;
          } catch {
            continue;
          }

          if (payload.phase === 'ready' && payload.card) {
            return payload.card;
          }
          if (
            payload.phase === 'failed' ||
            payload.phase === 'refunded' ||
            payload.phase === 'rejected'
          ) {
            throw new OrderFailedError(orderId, payload.error ?? payload.phase, payload.refund);
          }
          if (payload.phase === 'expired') {
            throw new OrderFailedError(
              orderId,
              'Payment window expired — no funds were taken',
              undefined,
            );
          }
        }
      }
      // Stream ended without a terminal event — treat as timeout.
      throw new WaitTimeoutError(orderId, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }

  // Legacy polling path — kept as the fallback so old backends still work.
  private async waitForCardPoll(
    orderId: string,
    timeoutMs: number,
    intervalMs: number,
  ): Promise<CardDetails> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const order = await this.getOrder(orderId);

      if (order.phase === 'ready' && order.card) return order.card;

      if (order.phase === 'failed' || order.phase === 'refunded' || order.phase === 'rejected') {
        throw new OrderFailedError(orderId, order.error ?? order.phase, order.refund);
      }

      if (order.phase === 'expired') {
        throw new OrderFailedError(
          orderId,
          'Payment window expired — no funds were taken',
          undefined,
        );
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new WaitTimeoutError(orderId, timeoutMs);
  }

  /**
   * Poll an order until its card becomes active or reaches a terminal failure state.
   *
   * @param orderId - UUID or identifier of the order.
   * @param options.intervalMs - Polling interval in milliseconds (defaults to 2000).
   * @param options.timeoutMs - Maximum timeout in milliseconds (defaults to 120000).
   * @param options.onProgress - Optional callback invoked whenever the order status transitions.
   * @returns The fulfilled OrderStatus when status reaches ACTIVE.
   * @throws {OrderFailedError} If the order reaches a terminal failure state.
   * @throws {TimeoutError} If polling exceeds timeoutMs.
   */
  async waitForOrderFulfillment(
    orderId: string,
    options: WaitForOrderFulfillmentOptions = {},
  ): Promise<OrderStatus> {
    validateOrderId(orderId);
    const intervalMs = options.intervalMs ?? 2000;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const { onProgress, signal } = options;

    if (signal?.aborted) throw new AbortError(`waitForOrderFulfillment ${orderId}`);

    const startTime = Date.now();
    const deadline = startTime + timeoutMs;
    let lastState: string | null = null;

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new AbortError(`waitForOrderFulfillment ${orderId}`);

      const order = await this.getOrder(orderId, options);
      const currentStatus = order.status ? order.status.toUpperCase() : '';
      const currentPhase = order.phase ? order.phase.toLowerCase() : '';
      const stateKey = `${currentStatus}:${currentPhase}`;

      // Notify onProgress callback on state transition
      if (stateKey !== lastState) {
        lastState = stateKey;
        if (onProgress) {
          try {
            onProgress(order);
          } catch (callbackErr) {
            this.logger.warn(`onProgress callback threw for order ${orderId}`, {
              error: callbackErr,
            });
          }
        }
      }

      // Check if order is fulfilled / active
      if (currentStatus === 'ACTIVE' || (order.card && currentPhase === 'ready')) {
        return order;
      }

      // Check for terminal failure states
      if (
        currentStatus === 'FAILED' ||
        currentStatus === 'REJECTED' ||
        currentStatus === 'REFUNDED' ||
        currentPhase === 'failed' ||
        currentPhase === 'rejected' ||
        currentPhase === 'refunded'
      ) {
        throw new OrderFailedError(
          orderId,
          order.error ?? order.status ?? order.phase,
          order.refund,
        );
      }

      if (currentStatus === 'EXPIRED' || currentPhase === 'expired') {
        throw new OrderFailedError(
          orderId,
          order.error ?? 'Payment window expired — no funds were taken',
          undefined,
        );
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;

      const sleepTime = Math.min(intervalMs, remainingMs);
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new AbortError(`waitForOrderFulfillment ${orderId}`));
          return;
        }
        let onAbort: (() => void) | undefined;
        const timer = setTimeout(() => {
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
          resolve();
        }, sleepTime);

        if (signal) {
          onAbort = () => {
            clearTimeout(timer);
            reject(new AbortError(`waitForOrderFulfillment ${orderId}`));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }

    throw new TimeoutError(`waitForOrderFulfillment ${orderId}`, timeoutMs);
  }

  /**
   * List this agent's recent orders.
   *
   * Supports offset/limit pagination plus created/updated time filters
   * so agents can sync deltas after a crash or handoff. For automatic
   * page iteration use {@link iterateOrders} or {@link listOrdersPage}.
   *
   * @param opts.status - Filter by order status string, e.g. `"delivered"`.
   * @param opts.limit - Page size. Defaults to 20.
   * @param opts.offset - Zero-based row offset for the page. Defaults to 0.
   * @param opts.since_created_at - ISO-8601 lower bound on `created_at`.
   * @param opts.since_updated_at - ISO-8601 lower bound on `updated_at`.
   * @returns Array of lightweight order list items for the requested page.
   * @throws {ValidationError} When `limit` or `offset` are non-integers.
   */
  async listOrders({
    status,
    limit = 20,
    offset,
    since_created_at,
    since_updated_at,
    timeout,
    signal,
  }: ListOrdersOptions = {}): Promise<OrderListItem[]> {
    const normalizedLimit = normalizeIntegerOption('limit', limit, 20);
    const normalizedOffset =
      offset === undefined ? undefined : normalizeIntegerOption('offset', offset, 0);
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    params.set('limit', String(normalizedLimit));
    if (normalizedOffset !== undefined) params.set('offset', String(normalizedOffset));
    if (since_created_at) params.set('since_created_at', since_created_at);
    if (since_updated_at) params.set('since_updated_at', since_updated_at);
    const qs = params.toString() ? `?${params}` : '';
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/orders${qs}`,
      { headers: { 'X-Api-Key': this.apiKey } },
      { timeout, signal },
      'orders',
    );
    if (!res.ok) return this.handleError(res);
    return res.json() as Promise<OrderListItem[]>;
  }

  /**
   * Fetch a single page of orders plus continuation metadata.
   *
   * The SDK probes one extra row to determine whether another page is
   * available, so callers get a reliable `hasMore` signal even though
   * the API itself returns a bare array. Use {@link iterateOrders} when
   * you need to walk all pages without manually tracking offsets.
   *
   * @param opts - Same filters and pagination options as {@link listOrders}.
   * @returns Page result with `items`, `hasMore`, and `nextOffset`.
   */
  async listOrdersPage(opts: ListOrdersOptions = {}): Promise<ListOrdersPage> {
    const limit = normalizeIntegerOption('limit', opts.limit, 20);
    const offset = normalizeIntegerOption('offset', opts.offset, 0);
    const items = await this.listOrders({
      ...opts,
      limit: limit + 1,
      offset,
    });
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

  /**
   * Iterate orders across pages without manually managing offsets.
   *
   * Useful for CLI sync jobs, reporting, or exporting an entire order
   * history while still bounding memory to one page at a time.
   *
   * @param opts.maxItems - Hard cap on total yielded items. Unlimited when omitted.
   * @param opts.limit - Page size. Defaults to 20.
   * @param opts.offset - Zero-based starting offset. Defaults to 0.
   * @yields Each {@link OrderListItem} across all pages in ascending offset order.
   *
   * @example
   * for await (const order of client.iterateOrders({ status: 'delivered' })) {
   *   console.log(order.id, order.amount_usdc);
   * }
   */
  async *iterateOrders({
    maxItems,
    limit = 20,
    offset = 0,
    ...filters
  }: IterateOrdersOptions = {}): AsyncGenerator<OrderListItem, void, void> {
    let remaining =
      maxItems === undefined
        ? Number.POSITIVE_INFINITY
        : normalizeIntegerOption('maxItems', maxItems, 0);
    let nextOffset = normalizeIntegerOption('offset', offset, 0);
    const pageSize = normalizeIntegerOption('limit', limit, 20);

    while (remaining > 0) {
      const requestLimit = Number.isFinite(remaining)
        ? Math.max(1, Math.min(pageSize, remaining))
        : pageSize;
      const page = await this.listOrdersPage({
        ...filters,
        limit: requestLimit,
        offset: nextOffset,
      });

      for (const item of page.items) {
        yield item;
        if (Number.isFinite(remaining)) remaining--;
      }

      if (!page.hasMore || page.nextOffset === null) return;
      nextOffset = page.nextOffset;
    }
  }

  /**
   * Get the agent's spend and budget summary.
   *
   * Returns lifetime totals plus the current in-flight amount and remaining
   * budget for the API key. Useful for budget-gating logic before creating
   * an order.
   *
   * @returns Spend summary including budget limits and order counts.
   * @throws {AuthError} When the API key is invalid.
   */
  async getUsage(reqOpts: RequestOptions = {}): Promise<UsageSummary> {
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/usage`,
      { headers: { 'X-Api-Key': this.apiKey } },
      reqOpts,
    );
    if (!res.ok) return this.handleError(res);
    return res.json() as Promise<UsageSummary>;
  }

  /**
   * List recent audit events (API calls, card authorizations, webhook
   * deliveries) for the dashboard tied to this API key (#731).
   *
   * @param opts.action - Filter by action name, e.g. `"order.create"`.
   * @param opts.limit - Page size. Defaults to 20.
   * @param opts.since - ISO-8601 lower bound on `timestamp`.
   * @returns Audit log entries, most recent first.
   * @throws {AuthError} When the API key is invalid.
   */
  async getAuditLogs({
    action,
    limit = 20,
    since,
    timeout,
    signal,
  }: ListAuditLogsOptions = {}): Promise<AuditLogEntry[]> {
    const normalizedLimit = normalizeIntegerOption('limit', limit, 20);
    const params = new URLSearchParams();
    if (action) params.set('action', action);
    params.set('limit', String(normalizedLimit));
    if (since) params.set('since', since);
    const qs = params.toString() ? `?${params}` : '';
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/dashboard/audit${qs}`,
      { headers: { 'X-Api-Key': this.apiKey } },
      { timeout, signal },
    );
    if (!res.ok) return this.handleError(res);
    return res.json() as Promise<AuditLogEntry[]>;
  }

  /**
   * Report a wallet setup lifecycle transition to the backend.
   *
   * This endpoint is best-effort by design — failures are swallowed so a
   * transient dashboard outage cannot block onboarding or purchases.
   * Called automatically by the `stellar_card onboard` CLI command.
   *
   * @param state - Lifecycle state: `"initializing"` or `"awaiting_funding"`.
   * @param opts.wallet_public_key - Stellar public key of the agent's wallet.
   * @param opts.detail - Optional free-text detail for the dashboard.
   */
  async reportStatus(
    state: 'initializing' | 'awaiting_funding',
    opts: ReportStatusOptions = {},
  ): Promise<void> {
    try {
      await this.fetchWithRetry(
        `${this.baseUrl}/agent/status`,
        {
          method: 'POST',
          headers: {
            'X-Api-Key': this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            state,
            wallet_public_key: opts.wallet_public_key,
            detail: opts.detail,
          }),
        },
        { timeout: opts.timeout, signal: opts.signal },
      );
    } catch {
      /* best-effort; do not block the caller */
    }
  }

  /**
   * Estimate the XLM required to pay for a given USDC order amount before payment,
   * querying the Stellar Horizon DEX orderbook with configurable slippage.
   *
   * @param usdcAmount - Amount in USDC
   * @param options - Estimation options including slippage buffer and fallback quote fetcher
   * @returns Estimated stroops, effective exchange rate, and expiration timestamp
   */
  async estimateXlmRequired(
    usdcAmount: string | number,
    options?: import('./stellar').EstimateXlmOptions,
  ): Promise<import('./stellar').XlmEstimateResult> {
    const { estimateXlmRequired } = await import('./stellar');
    return estimateXlmRequired(usdcAmount, options);
  }

  /**
   * Fetch XLM, USDC and every trustline balance for a Stellar account in a
   * single Horizon call (#701). Unfunded accounts resolve to zero balances.
   * Results are cached for 3 seconds.
   *
   * @param publicKey - Stellar G-address to inspect.
   */
  async getAccountBalances(publicKey: string): Promise<AccountBalances> {
    const { getAccountBalances } = await import('./stellar');
    const { Networks } = await import('@stellar/stellar-sdk');
    const passphrase = {
      mainnet: Networks.PUBLIC,
      testnet: Networks.TESTNET,
      futurenet: Networks.FUTURENET,
    }[this.network];
    return getAccountBalances(publicKey, passphrase);
  }
}
