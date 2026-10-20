/**
 * Structured error types for the stellar_card SDK.
 *
 * Catch by type so your agent can handle each case without string-parsing:
 *
 *   try {
 *     const card = await client.createOrder({ amount_usdc: '10.00' });
 *   } catch (err) {
 *     if (err instanceof SpendLimitError) { ... }
 *     if (err instanceof ServiceUnavailableError) { ... }
 *   }
 */

/** Error source context for debugging. */
export interface ErrorContext {
  /** Where the error originated (e.g., 'stellar_card_api', 'soroban_rpc', 'horizon', 'ows_wallet'). */
  source?: string;
  /** The operation being attempted when error occurred (e.g., 'create_order', 'pay_contract'). */
  operation?: string;
  /** Wrapped underlying error for root cause analysis. */
  cause?: Error;
  /** Suggested next action for recovery. */
  recoveryHint?: string;
  /** Context-specific data for debugging. */
  metadata?: Record<string, unknown>;
}

/** Base class — all stellar_card errors extend this. */
export class Stellar_CardError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly raw?: unknown,
    public readonly context?: ErrorContext,
  ) {
    super(message, context?.cause ? { cause: context.cause } : undefined);
    this.name = 'Stellar_CardError';
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Format error with full context for debugging. */
  toDebugString(): string {
    const parts = [this.message];
    if (this.context?.source) parts.push(`[source: ${this.context.source}]`);
    if (this.context?.operation) parts.push(`[operation: ${this.context.operation}]`);
    if (this.context?.recoveryHint) parts.push(`[recovery: ${this.context.recoveryHint}]`);
    if (this.context?.cause) parts.push(`[caused by: ${this.context.cause.message}]`);
    return parts.join('\n');
  }

  /** Serialize to a plain object safe for JSON.stringify / structured logging. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      status: this.status,
      context: this.context
        ? {
            source: this.context.source,
            operation: this.context.operation,
            recoveryHint: this.context.recoveryHint,
            metadata: this.context.metadata,
          }
        : undefined,
    };
  }
}

/** The API key's spend limit has been reached. */
export class SpendLimitError extends Stellar_CardError {
  constructor(
    public readonly limit: string,
    public readonly spent: string,
    context?: ErrorContext,
  ) {
    super(
      `Spend limit exceeded: $${spent} spent of $${limit} limit. Ask your operator to raise the limit or wait for the next reset period.`,
      'spend_limit_exceeded',
      403,
      undefined,
      {
        recoveryHint: 'Contact your dashboard to raise the spend limit or wait for reset.',
        ...context,
      },
    );
    this.name = 'SpendLimitError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Rate limit hit. The backend returns `rate_limit_exceeded` for two
 * different limits — 60 orders/hour on POST /v1/orders, and 10
 * requests/second (600/minute) on GET /v1/orders/:id status polling.
 * Which one fired is in the server's `message` field, not in the
 * error code, so we forward the message verbatim instead of hardcoding
 * the wrong explanation.
 */
export class RateLimitError extends Stellar_CardError {
  constructor(message = 'Rate limit exceeded. Back off and retry.', context?: ErrorContext) {
    super(message, 'rate_limit_exceeded', 429, undefined, {
      recoveryHint: 'Wait a few moments before retrying. Implement exponential backoff.',
      ...context,
    });
    this.name = 'RateLimitError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Service is temporarily suspended (fulfillment circuit breaker tripped). */
export class ServiceUnavailableError extends Stellar_CardError {
  constructor(
    message = 'Card fulfillment is temporarily suspended. Retry in a few minutes.',
    context?: ErrorContext,
  ) {
    super(message, 'service_temporarily_unavailable', 503, undefined, {
      recoveryHint: 'Check https://status.stellar_card.com or retry in 5-10 minutes.',
      ...context,
    });
    this.name = 'ServiceUnavailableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** XLM price feed is unavailable — retry or use USDC. */
export class PriceUnavailableError extends Stellar_CardError {
  constructor(
    message = 'XLM price is temporarily unavailable. Retry shortly, or use payment_asset: "usdc".',
    context?: ErrorContext,
  ) {
    super(message, 'price_unavailable', 503, undefined, {
      recoveryHint: 'Try paying in USDC instead, or wait a few minutes for the price feed.',
      ...context,
    });
    this.name = 'PriceUnavailableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * amount_usdc was missing, zero, non-numeric, or outside the bounds
 * [0.01, 10000]. The message defaults to the full-range explanation
 * but is overridden by whatever the backend sent so a call with e.g.
 * "9.99999999" (too many decimals) gets the specific reason instead
 * of the generic bounds message.
 */
export class InvalidAmountError extends Stellar_CardError {
  constructor(
    message = 'Invalid amount_usdc — must be a decimal string between "0.01" and "10000.00" (e.g. "10.00").',
    context?: ErrorContext,
  ) {
    super(message, 'invalid_amount', 400, undefined, context);
    this.name = 'InvalidAmountError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The API key is missing or invalid. */
export class AuthError extends Stellar_CardError {
  constructor(context?: ErrorContext) {
    super(
      'Invalid or missing API key. Pass it as the X-Api-Key header, or set CARDS402_API_KEY.',
      'invalid_api_key',
      401,
      undefined,
      {
        recoveryHint: 'Verify your API key is set in CARDS402_API_KEY or the apiKey option.',
        ...context,
      },
    );
    this.name = 'AuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Order failed during fulfillment. A refund may be in progress. */
export class OrderFailedError extends Stellar_CardError {
  constructor(
    public readonly orderId: string,
    reason: string,
    public readonly refund?: { stellar_txid: string },
    context?: ErrorContext,
  ) {
    const refundNote = refund
      ? ` Your payment is being refunded (txid: ${refund.stellar_txid}).`
      : ' A refund will be processed if payment was received.';
    super(
      `Order ${orderId} failed: ${reason}.${refundNote}`,
      'order_failed',
      200,
      {
        orderId,
        reason,
        refund,
      },
      {
        recoveryHint: `Check order status with: stellar_card purchase --resume ${orderId}`,
        ...context,
      },
    );
    this.name = 'OrderFailedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by purchaseCardOWS when the order was created (and possibly paid)
 * but the flow couldn't finish — e.g. Soroban RPC finalization timed out,
 * or waitForCard hit its deadline. Always carries the orderId so the caller
 * can resume via `stellar_card purchase --resume <order-id>` without minting a
 * new order (which would strand the original one until it expires).
 *
 * `txHash` is present when the payment was submitted onto the ledger (even
 * if finalization wasn't confirmed client-side) — the backend watcher can
 * still credit the order after the fact.
 *
 * `phase: 'paid'` means payViaContractOWS returned successfully, so resume
 * should skip straight to waitForCard. `phase: 'unpaid'` means the payment
 * never went out and resume may need to retry the Soroban submit.
 */
export class ResumableError extends Stellar_CardError {
  constructor(
    public readonly orderId: string,
    reason: string,
    public readonly phase: 'unpaid' | 'paid',
    public readonly txHash?: string,
    public readonly cause?: unknown,
    context?: ErrorContext,
  ) {
    const hashNote = txHash ? ` (tx: ${txHash})` : '';
    super(
      `Purchase could not finish for order ${orderId}: ${reason}${hashNote}. ` +
        `Resume with: stellar_card purchase --resume ${orderId}`,
      'resumable',
      0,
      { orderId, reason, phase, txHash },
      {
        recoveryHint: `Your payment may have been received. Resume with: stellar_card purchase --resume ${orderId}`,
        ...context,
      },
    );
    this.name = 'ResumableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Waiting for a card timed out — order may still be processing. */
export class WaitTimeoutError extends Stellar_CardError {
  constructor(
    public readonly orderId: string,
    timeoutMs: number,
  ) {
    super(
      `Timed out waiting for card after ${timeoutMs / 1000}s (order: ${orderId}). ` +
        'Poll GET /v1/orders/:id to check status — it may still complete.',
      'wait_timeout',
      408,
    );
    this.name = 'WaitTimeoutError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Network request failed — connection, DNS, or timeout. */
export class NetworkError extends Stellar_CardError {
  constructor(
    reason: string,
    public readonly endpoint?: string,
    cause?: Error,
    context?: ErrorContext,
  ) {
    const message =
      `Network error communicating with ${endpoint || 'API'}: ${reason}. ` +
      'Check your internet connection and try again.';
    super(message, 'network_error', 0, { endpoint, reason }, { cause, ...context });
    this.name = 'NetworkError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Request timed out. */
export class TimeoutError extends Stellar_CardError {
  constructor(operation: string, timeoutMs: number, context?: ErrorContext) {
    super(
      `Operation "${operation}" timed out after ${timeoutMs}ms. ` +
        'Network may be slow — try again or increase timeout.',
      'timeout',
      0,
      undefined,
      context,
    );
    this.name = 'TimeoutError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Request was cancelled through a caller-supplied `AbortSignal`. */
export class AbortError extends Stellar_CardError {
  constructor(operation: string, context?: ErrorContext) {
    super(`Operation "${operation}" was aborted by the caller.`, 'aborted', 0, undefined, context);
    this.name = 'AbortError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A single field-level configuration problem. */
export interface ConfigurationIssue {
  field: string;
  message: string;
}

/** Invalid client configuration (bad apiKey, baseUrl, timeout, ...). */
export class ConfigurationError extends Stellar_CardError {
  constructor(public readonly issues: ConfigurationIssue[]) {
    super(
      `Invalid Stellar_Card configuration: ${issues.map((i) => `${i.field}: ${i.message}`).join('; ')}`,
      'configuration_error',
      0,
      { issues },
    );
    this.name = 'ConfigurationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Validation error — invalid input parameters. */
export class ValidationError extends Stellar_CardError {
  constructor(
    public readonly field: string,
    reason: string,
  ) {
    super(`Validation error for field "${field}": ${reason}`, 'validation_error', 400, {
      field,
      reason,
    });
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Invalid memo value or memo type passed to {@link buildTransactionMemo}. */
export class InvalidMemoError extends Stellar_CardError {
  constructor(
    public readonly memoType: string,
    reason: string,
    context?: ErrorContext,
  ) {
    super(
      `Invalid memo (type "${memoType}"): ${reason}`,
      'invalid_memo',
      400,
      { memoType, reason },
      context,
    );
    this.name = 'InvalidMemoError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Soroban RPC error. */
export class SorobanRpcError extends Stellar_CardError {
  constructor(
    reason: string,
    public readonly rpcUrl?: string,
    cause?: Error,
    context?: ErrorContext,
  ) {
    super(
      `Soroban RPC error: ${reason}. Check the RPC endpoint or try a different network.`,
      'soroban_rpc_error',
      0,
      { rpcUrl },
      { cause, ...context },
    );
    this.name = 'SorobanRpcError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Horizon API error. */
export class HorizonError extends Stellar_CardError {
  constructor(
    reason: string,
    public readonly endpoint?: string,
    cause?: Error,
    context?: ErrorContext,
  ) {
    super(
      `Horizon error: ${reason}. The Stellar network may be temporarily unavailable.`,
      'horizon_error',
      0,
      { endpoint },
      { cause, ...context },
    );
    this.name = 'HorizonError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** OWS wallet operation failed. */
export class WalletError extends Stellar_CardError {
  constructor(
    reason: string,
    public readonly operation?: string,
    cause?: Error,
    context?: ErrorContext,
  ) {
    super(
      `Wallet error: ${reason}. ` +
        (operation
          ? `Check your ${operation} settings or try re-creating the wallet.`
          : 'Try again.'),
      'wallet_error',
      0,
      { operation },
      { cause, ...context },
    );
    this.name = 'WalletError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Parse a raw API error response into the appropriate typed error.
 * Falls back to generic Stellar_CardError for unknown codes.
 */
export function parseApiError(
  status: number,
  body: Record<string, unknown>,
  context?: Partial<ErrorContext>,
): Stellar_CardError {
  const code = String(body.error ?? 'unknown');
  const message = String(body.message ?? body.error ?? 'Unknown error');

  const errorContext: ErrorContext = {
    source: 'stellar_card_api',
    ...context,
  };

  switch (code) {
    case 'spend_limit_exceeded':
      return new SpendLimitError(
        String(body.limit ?? '?'),
        String(body.spent ?? '?'),
        errorContext,
      );
    case 'rate_limit_exceeded':
      // Forward the backend message verbatim — the code is shared
      // between order-creation and polling rate limits, and the
      // message is the only way to tell them apart.
      return new RateLimitError(message, errorContext);
    case 'service_temporarily_unavailable':
      return new ServiceUnavailableError(message, errorContext);
    case 'price_unavailable':
    case 'xlm_price_unavailable':
      return new PriceUnavailableError(message, errorContext);
    case 'invalid_amount':
      return new InvalidAmountError(message, errorContext);
    case 'missing_api_key':
    case 'invalid_api_key':
      return new AuthError(errorContext);
    default:
      return new Stellar_CardError(message, code, status, body, errorContext);
  }
}

/**
 * Wrap an unknown error with context.
 * If it's already a Stellar_CardError, enhance its context while preserving
 * the original `raw` payload. Otherwise, wrap it in a generic Stellar_CardError
 * with the original error recorded as `cause`.
 */
export function wrapError(err: unknown, context: Partial<ErrorContext>): Stellar_CardError {
  if (err instanceof Stellar_CardError) {
    // Enhance existing error with context — preserve raw and merge contexts so
    // callers higher up the stack can add operation/source without losing
    // lower-level detail.
    return new Stellar_CardError(err.message, err.code, err.status, err.raw, {
      ...err.context,
      ...context,
    });
  }

  const message = err instanceof Error ? err.message : String(err);
  return new Stellar_CardError(message, 'unknown_error', 0, undefined, {
    cause: err instanceof Error ? err : new Error(String(err)),
    ...context,
  });
}

/**
 * Wrap a validation error for a specific field.
 *
 * Convenience wrapper around {@link ValidationError} that standardises the
 * context so callers don't have to construct the class directly.
 *
 * @param field   - The parameter or property that failed validation.
 * @param reason  - Human-readable description of why validation failed.
 * @param context - Optional extra context for debugging.
 */
export function wrapValidationError(
  field: string,
  reason: string,
  context?: Partial<ErrorContext>,
): ValidationError {
  const err = new ValidationError(field, reason);
  if (context) {
    // Return an enriched copy that keeps ValidationError identity.
    Object.assign(err, {
      context: {
        source: context.source,
        operation: context.operation,
        recoveryHint: context.recoveryHint,
        metadata: context.metadata,
        cause: context.cause,
      },
    });
  }
  return err;
}

/**
 * Build a human-readable error chain string from a series of nested causes.
 *
 * Useful for structured logging where you want to record the full causal
 * chain without serialising the entire Error prototype tree.
 *
 * @param err - The top-level error.
 * @returns A string like `"outer: inner: root cause"`.
 *
 * @example
 * ```typescript
 * catch (err) {
 *   logger.error({ chain: buildErrorChain(err) }, 'Operation failed');
 * }
 * ```
 */
export function buildErrorChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  const seen = new Set<unknown>();

  while (current != null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Stellar_CardError) {
      parts.push(current.message);
      current = current.context?.cause;
    } else if (current instanceof Error) {
      parts.push(current.message);
      // `cause` is standard in ES2022+ Error but not always typed.
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }

  return parts.join(' → ');
}

/**
 * Returns `true` for error types that are safe to retry by default:
 * {@link RateLimitError}, {@link ServiceUnavailableError},
 * {@link NetworkError}, {@link TimeoutError}, and {@link PriceUnavailableError}.
 *
 * Use this as a sensible default for `isRetryable` in {@link withRetry} when
 * you don't need custom logic.
 *
 * @example
 * ```typescript
 * const card = await withRetry({
 *   fn: () => client.createOrder({ amount_usdc: '10.00' }),
 *   maxRetries: 3,
 *   isRetryable: isRetryableByDefault,
 * });
 * ```
 */
export function isRetryableByDefault(err: unknown): boolean {
  return (
    err instanceof RateLimitError ||
    err instanceof ServiceUnavailableError ||
    err instanceof NetworkError ||
    err instanceof TimeoutError ||
    err instanceof PriceUnavailableError
  );
}

/**
 * Wrap a network error with helpful context.
 */
export function wrapNetworkError(
  err: unknown,
  endpoint?: string,
  operation?: string,
): NetworkError {
  const message = err instanceof Error ? err.message : 'Unknown network error';
  const wrapped = new NetworkError(message, endpoint, err instanceof Error ? err : undefined, {
    recoveryHint:
      'Check your internet connection, firewall rules, and that the endpoint is reachable.',
    operation,
  });
  if (Error.captureStackTrace) Error.captureStackTrace(wrapped, wrapNetworkError);
  return wrapped;
}

/**
 * Wrap a timeout error with context about what timed out.
 */
export function wrapTimeoutError(
  operation: string,
  timeoutMs: number,
  cause?: Error,
): TimeoutError {
  return new TimeoutError(operation, timeoutMs, {
    cause,
    recoveryHint: `Increase timeoutMs above ${timeoutMs}ms if operations frequently take longer.`,
  });
}

/**
 * Wrap a Soroban RPC error with context.
 */
export function wrapSorobanError(
  err: unknown,
  rpcUrl?: string,
  operation?: string,
): SorobanRpcError {
  const message = err instanceof Error ? err.message : String(err);
  return new SorobanRpcError(message, rpcUrl, err instanceof Error ? err : undefined, {
    operation,
    recoveryHint: rpcUrl
      ? `Try a different Soroban RPC endpoint or check ${rpcUrl} status.`
      : 'Configure a custom sorobanRpcUrl if using a private endpoint.',
  });
}

/**
 * Wrap a Horizon API error with context.
 */
export function wrapHorizonError(
  err: unknown,
  endpoint?: string,
  operation?: string,
): HorizonError {
  const message = err instanceof Error ? err.message : String(err);
  return new HorizonError(message, endpoint, err instanceof Error ? err : undefined, {
    operation,
    recoveryHint: 'The Stellar Horizon API may be rate-limited; try again in a few seconds.',
  });
}

/**
 * Wrap a wallet operation error with context.
 */
export function wrapWalletError(err: unknown, operation?: string): WalletError {
  const message = err instanceof Error ? err.message : String(err);
  return new WalletError(message, operation, err instanceof Error ? err : undefined);
}

/**
 * Thrown when a Soroban contract execution fails with a custom contract error code.
 */
export class ContractExecutionError extends Stellar_CardError {
  public override readonly code: any;
  public readonly contractCode: number;
  public readonly explanation: string;

  constructor(code: number, explanation: string, raw?: unknown, context?: ErrorContext) {
    super(`Contract execution error ${code}: ${explanation}`, String(code), 400, raw, context);
    this.name = 'ContractExecutionError';
    this.code = code;
    this.contractCode = code;
    this.explanation = explanation;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
