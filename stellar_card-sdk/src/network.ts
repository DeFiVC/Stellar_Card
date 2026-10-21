/**
 * Network configuration helpers for the stellar_card SDK.
 *
 * These utilities let callers swap out the Soroban RPC and Horizon URLs
 * used by payment functions — useful for custom deployments, private
 * validators, or Futurenet / testnet scenarios.
 */

import { Networks } from '@stellar/stellar-sdk';
import { AbortError, TimeoutError, ValidationError } from './errors';
import { calculateExponentialBackoffDelay } from './retry';
import type { Logger } from './logger';

/** Well-known Soroban RPC endpoints. */
const MAINNET_RPC = 'https://mainnet.sorobanrpc.com';
const TESTNET_RPC = 'https://soroban-testnet.stellar.org';
const FUTURENET_RPC = 'https://rpc-futurenet.stellar.org';

/** Well-known Horizon REST endpoints. */
const MAINNET_HORIZON = 'https://horizon.stellar.org';
const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
const FUTURENET_HORIZON = 'https://horizon-futurenet.stellar.org';

/**
 * RPC endpoint configuration with optional authentication and timeout.
 */
export interface RpcEndpointConfig {
  /** RPC endpoint URL */
  url: string;
  /** Optional request timeout in milliseconds. Defaults to 30000. */
  timeout?: number;
  /** Optional API key for authenticated endpoints */
  apiKey?: string;
  /** Optional custom headers for requests */
  headers?: Record<string, string>;
}

/**
 * Full network endpoint configuration.
 *
 * All fields are optional — omitting a field causes the default for the
 * resolved `networkPassphrase` to be used.
 */
export interface NetworkConfig {
  /** Stellar network passphrase. Defaults to `Networks.PUBLIC`. */
  networkPassphrase?: string;
  /** Soroban RPC URL or configuration. Defaults to the public mainnet / testnet endpoint. */
  sorobanRpcUrl?: string | RpcEndpointConfig;
  /** Horizon REST API URL or configuration. Defaults to the public mainnet / testnet endpoint. */
  horizonUrl?: string | RpcEndpointConfig;
  /** Optional network name for identification */
  networkName?: string;
  /** Optional custom user agent for requests */
  customUserAgent?: string;
  /** Optional logger instance */
  logger?: Logger;
}

/**
 * Normalized RPC endpoint configuration after resolution.
 */
export interface ResolvedRpcEndpoint {
  url: string;
  timeout: number;
  apiKey?: string;
  headers?: Record<string, string>;
}

/**
 * Fully resolved network configuration with all fields populated.
 */
export interface ResolvedNetworkConfig {
  networkPassphrase: string;
  sorobanRpc: ResolvedRpcEndpoint;
  horizon: ResolvedRpcEndpoint;
  networkName: string;
  customUserAgent?: string;
}

/**
 * Normalize an RPC endpoint config from string or object form.
 */
function normalizeRpcEndpoint(
  input: string | RpcEndpointConfig | undefined,
  defaultUrl: string,
): ResolvedRpcEndpoint {
  if (typeof input === 'string') {
    const url = normalizeString(input);
    return { url: url ?? defaultUrl, timeout: 30000 };
  }
  if (input && typeof input === 'object') {
    const url = normalizeString(input.url);
    return {
      url: url ?? defaultUrl,
      timeout: input.timeout ?? 30000,
      apiKey: input.apiKey,
      headers: input.headers,
    };
  }
  return { url: defaultUrl, timeout: 30000 };
}

/**
 * Resolve a `NetworkConfig` object into fully-qualified configuration.
 *
 * Callers can pass a partial config and rely on this function to fill in
 * the public defaults for the selected network passphrase.
 *
 * @param config - Partial network configuration object (optional)
 * @returns Fully resolved network configuration with all endpoints populated
 *
 * @example
 * ```typescript
 * const config = resolveNetworkConfig({
 *   networkPassphrase: Networks.TESTNET,
 *   sorobanRpcUrl: 'https://custom-rpc.example.com'
 * });
 * console.log('Soroban RPC:', config.sorobanRpc.url);
 * ```
 */
export function resolveNetworkConfig(config: NetworkConfig = {}): ResolvedNetworkConfig {
  const networkPassphrase = normalizeString(config.networkPassphrase) ?? Networks.PUBLIC;

  let defaultSorobanRpc: string;
  let defaultHorizon: string;
  let defaultName: string;

  if (networkPassphrase === Networks.TESTNET) {
    defaultSorobanRpc = TESTNET_RPC;
    defaultHorizon = TESTNET_HORIZON;
    defaultName = 'Testnet';
  } else if (networkPassphrase === Networks.FUTURENET) {
    defaultSorobanRpc = FUTURENET_RPC;
    defaultHorizon = FUTURENET_HORIZON;
    defaultName = 'Futurenet';
  } else {
    defaultSorobanRpc = MAINNET_RPC;
    defaultHorizon = MAINNET_HORIZON;
    defaultName = 'Mainnet';
  }

  return {
    networkPassphrase,
    sorobanRpc: normalizeRpcEndpoint(config.sorobanRpcUrl, defaultSorobanRpc),
    horizon: normalizeRpcEndpoint(config.horizonUrl, defaultHorizon),
    networkName: normalizeString(config.networkName) ?? defaultName,
    customUserAgent: normalizeString(config.customUserAgent),
  };
}

/**
 * Return the default Soroban RPC URL for a given network passphrase.
 *
 * Supports Mainnet, Testnet, and Futurenet networks.
 *
 * @param networkPassphrase - Stellar network passphrase (defaults to mainnet)
 * @returns The default Soroban RPC URL for the specified network
 *
 * @example
 * ```typescript
 * const rpcUrl = getDefaultSorobanRpcUrl(Networks.TESTNET);
 * console.log('Testnet RPC:', rpcUrl); // https://soroban-testnet.stellar.org
 * ```
 */
export function getDefaultSorobanRpcUrl(networkPassphrase = Networks.PUBLIC): string {
  if (networkPassphrase === Networks.TESTNET) return TESTNET_RPC;
  if (networkPassphrase === Networks.FUTURENET) return FUTURENET_RPC;
  return MAINNET_RPC;
}

/**
 * Return the default Horizon URL for a given network passphrase.
 *
 * Supports Mainnet, Testnet, and Futurenet networks.
 *
 * @param networkPassphrase - Stellar network passphrase (defaults to mainnet)
 * @returns The default Horizon URL for the specified network
 *
 * @example
 * ```typescript
 * const horizonUrl = getDefaultHorizonUrl(Networks.TESTNET);
 * console.log('Testnet Horizon:', horizonUrl); // https://horizon-testnet.stellar.org
 * ```
 */
export function getDefaultHorizonUrl(networkPassphrase = Networks.PUBLIC): string {
  if (networkPassphrase === Networks.TESTNET) return TESTNET_HORIZON;
  if (networkPassphrase === Networks.FUTURENET) return FUTURENET_HORIZON;
  return MAINNET_HORIZON;
}

/**
 * Create a custom network configuration for private or non-standard deployments.
 *
 * @example
 * const config = createCustomNetworkConfig({
 *   networkPassphrase: 'Custom Network ; January 2025',
 *   sorobanRpcUrl: 'https://custom-rpc.example.com',
 *   horizonUrl: 'https://custom-horizon.example.com',
 *   networkName: 'Custom Network'
 * });
 */
export function createCustomNetworkConfig(params: {
  networkPassphrase: string;
  sorobanRpcUrl: string | RpcEndpointConfig;
  horizonUrl: string | RpcEndpointConfig;
  networkName?: string;
}): ResolvedNetworkConfig {
  return resolveNetworkConfig(params);
}

/**
 * Validate that an RPC endpoint URL is well-formed.
 *
 * Checks URL format and warns about insecure HTTP endpoints in production.
 *
 * @param url - The RPC endpoint URL to validate
 * @param context - Optional context description for error messages
 * @throws {Error} When the URL is malformed or uses an invalid protocol
 *
 * @example
 * ```typescript
 * validateRpcEndpoint('https://rpc.example.com', 'Soroban RPC');
 * // Validates successfully
 *
 * validateRpcEndpoint('ftp://invalid.com');
 * // Throws: Invalid protocol: ftp:
 * ```
 */
export function validateRpcEndpoint(url: string, context?: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Invalid protocol: ${parsed.protocol}`);
    }
    // Warn about http in production contexts
    if (parsed.protocol === 'http:' && !url.includes('localhost') && !url.includes('127.0.0.1')) {
      console.warn(
        `Warning: Using insecure HTTP endpoint ${url}${context ? ` for ${context}` : ''}. ` +
          'Consider using HTTPS for production deployments.',
      );
    }
  } catch (err) {
    throw new Error(
      `Invalid RPC endpoint URL "${url}"${context ? ` for ${context}` : ''}: ${(err as Error).message}`,
    );
  }
}

// ── Custom RPC endpoint validation ────────────────────────────────────────────

/** Proxy configuration for RPC endpoints */
export interface RpcProxyConfig {
  /** Proxy URL (e.g., 'http://proxy.example.com:8080') */
  url: string;
  /** Optional proxy authentication username */
  username?: string;
  /** Optional proxy authentication password */
  password?: string;
  /** Optional list of hosts to bypass the proxy */
  noProxy?: string[];
}

/** Extended RPC endpoint config with proxy and retry support */
export interface ExtendedRpcEndpointConfig extends RpcEndpointConfig {
  /** Optional proxy configuration */
  proxy?: RpcProxyConfig;
  /** Optional retry configuration for failed requests */
  retry?: {
    /** Maximum number of retry attempts */
    maxAttempts: number;
    /** Base delay between retries in milliseconds */
    baseDelayMs: number;
    /** Whether to use exponential backoff */
    exponentialBackoff: boolean;
  };
}

/**
 * Validate a NetworkConfig object, checking that all URLs are well-formed
 * and that required fields are present.
 *
 * @param config - The network configuration to validate
 * @returns Array of validation error messages (empty if valid)
 *
 * @example
 * ```typescript
 * const errors = validateNetworkConfig({
 *   networkPassphrase: Networks.PUBLIC,
 *   sorobanRpcUrl: 'https://rpc.example.com',
 * });
 * if (errors.length > 0) {
 *   console.error('Invalid config:', errors);
 * }
 * ```
 */
export function validateNetworkConfig(config: NetworkConfig): string[] {
  const errors: string[] = [];

  if (config.networkPassphrase !== undefined) {
    if (typeof config.networkPassphrase !== 'string' || config.networkPassphrase.length === 0) {
      errors.push('networkPassphrase must be a non-empty string');
    }
  }

  if (config.sorobanRpcUrl !== undefined) {
    const url =
      typeof config.sorobanRpcUrl === 'string' ? config.sorobanRpcUrl : config.sorobanRpcUrl.url;
    try {
      validateRpcEndpoint(url, 'Soroban RPC');
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  if (config.horizonUrl !== undefined) {
    const url = typeof config.horizonUrl === 'string' ? config.horizonUrl : config.horizonUrl.url;
    try {
      validateRpcEndpoint(url, 'Horizon');
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  if (config.networkName !== undefined) {
    if (typeof config.networkName !== 'string' || config.networkName.length === 0) {
      errors.push('networkName must be a non-empty string');
    }
  }

  return errors;
}

/**
 * Resolve network configuration with retry support for endpoint health checks.
 *
 * Attempts to reach the Soroban RPC endpoint to verify connectivity before
 * returning the resolved config. Falls back to the resolved config without
 * verification if all attempts fail.
 *
 * @param config - Partial network configuration (optional)
 * @param retryOptions - Retry configuration for the health check
 * @returns Promise resolving to the fully-resolved network configuration
 *
 * @example
 * ```typescript
 * const config = await resolveNetworkConfigWithRetry({
 *   networkPassphrase: Networks.TESTNET,
 *   sorobanRpcUrl: 'https://custom-rpc.example.com',
 * }, { maxAttempts: 3, delayMs: 1000 });
 * ```
 */
export async function resolveNetworkConfigWithRetry(
  config: NetworkConfig = {},
  retryOptions: { maxAttempts?: number; delayMs?: number } = {},
): Promise<ResolvedNetworkConfig> {
  const { maxAttempts = 3, delayMs = 1000 } = retryOptions;
  const resolved = resolveNetworkConfig(config);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    config.logger?.debug?.(
      `Soroban RPC health check attempt ${attempt + 1}/${maxAttempts} for ${resolved.sorobanRpc.url}`,
    );
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), resolved.sorobanRpc.timeout);
      const response = await fetch(resolved.sorobanRpc.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(resolved.sorobanRpc.apiKey
            ? { Authorization: `Bearer ${resolved.sorobanRpc.apiKey}` }
            : {}),
          ...resolved.sorobanRpc.headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.ok) {
        config.logger?.debug?.(`Soroban RPC ${resolved.sorobanRpc.url} is healthy`);
        return resolved;
      }
    } catch (err) {
      config.logger?.debug?.(
        `Soroban RPC health check attempt ${attempt + 1} failed: ${String(err)}`,
      );
      // Health check failed — wait before retrying
      if (attempt < maxAttempts - 1) {
        const backoffMs = calculateExponentialBackoffDelay({
          attempt,
          baseDelayMs: delayMs,
          maxDelayMs: delayMs * 10,
        });
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  // All attempts failed — return the resolved config anyway.
  // The caller can handle connectivity issues at call time.
  return resolved;
}

/**
 * Create a fully custom network configuration for private or non-standard
 * deployments with extended endpoint options including proxy and retry.
 *
 * @param params - Custom network parameters
 * @returns Fully resolved network configuration
 *
 * @example
 * ```typescript
 * const config = createExtendedNetworkConfig({
 *   networkPassphrase: 'Custom Network ; January 2025',
 *   sorobanRpc: {
 *     url: 'https://private-rpc.example.com',
 *     apiKey: 'my-api-key',
 *     timeout: 60000,
 *     proxy: { url: 'http://proxy.example.com:8080' },
 *     retry: { maxAttempts: 3, baseDelayMs: 1000, exponentialBackoff: true },
 *   },
 *   horizon: {
 *     url: 'https://private-horizon.example.com',
 *     timeout: 30000,
 *   },
 *   networkName: 'Private Network',
 * });
 * ```
 */
export function createExtendedNetworkConfig(params: {
  networkPassphrase: string;
  sorobanRpc: ExtendedRpcEndpointConfig;
  horizon: ExtendedRpcEndpointConfig;
  networkName?: string;
}): ResolvedNetworkConfig {
  return resolveNetworkConfig({
    networkPassphrase: params.networkPassphrase,
    sorobanRpcUrl: {
      url: params.sorobanRpc.url,
      timeout: params.sorobanRpc.timeout,
      apiKey: params.sorobanRpc.apiKey,
      headers: params.sorobanRpc.headers,
    },
    horizonUrl: {
      url: params.horizon.url,
      timeout: params.horizon.timeout,
      apiKey: params.horizon.apiKey,
      headers: params.horizon.headers,
    },
    networkName: params.networkName,
  });
}

/** Environment variable names recognised by {@link resolveNetworkConfigFromEnv}. */
export const NETWORK_ENV_VARS = {
  networkPassphrase: 'STELLAR_NETWORK_PASSPHRASE',
  sorobanRpcUrl: 'STELLAR_SOROBAN_RPC_URL',
  horizonUrl: 'STELLAR_HORIZON_URL',
  apiKey: 'STELLAR_RPC_API_KEY',
  timeout: 'STELLAR_RPC_TIMEOUT',
  networkName: 'STELLAR_NETWORK_NAME',
} as const;

/**
 * Resolve network configuration from environment variables, falling back to
 * the public defaults for any variable that is unset.
 *
 * Recognised variables (see {@link NETWORK_ENV_VARS}):
 *   - `STELLAR_NETWORK_PASSPHRASE` — network passphrase (defaults to PUBLIC)
 *   - `STELLAR_SOROBAN_RPC_URL`    — custom Soroban RPC endpoint
 *   - `STELLAR_HORIZON_URL`        — custom Horizon endpoint
 *   - `STELLAR_RPC_API_KEY`        — API key applied to both endpoints
 *   - `STELLAR_RPC_TIMEOUT`        — request timeout in ms (must be a positive integer)
 *   - `STELLAR_NETWORK_NAME`       — human-readable network name
 *
 * A `overrides` object can be supplied to take precedence over the
 * environment — handy when only some values come from `process.env`.
 *
 * Browser-safe: when `process.env` is unavailable (e.g. in a bundled browser
 * build) this behaves exactly like {@link resolveNetworkConfig} with only the
 * supplied `overrides` applied.
 */
export function resolveNetworkConfigFromEnv(overrides: NetworkConfig = {}): ResolvedNetworkConfig {
  const env: Record<string, string | undefined> =
    typeof process !== 'undefined' && process.env ? process.env : {};

  const apiKey = normalizeString(env[NETWORK_ENV_VARS.apiKey]);

  let timeout: number | undefined;
  const rawTimeout = normalizeString(env[NETWORK_ENV_VARS.timeout]);
  if (rawTimeout !== undefined) {
    const parsed = Number(rawTimeout);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(
        `${NETWORK_ENV_VARS.timeout} must be a positive integer (ms), got "${rawTimeout}"`,
      );
    }
    timeout = parsed;
  }

  const buildEndpoint = (url: string | undefined): string | RpcEndpointConfig | undefined => {
    const cleaned = normalizeString(url);
    if (cleaned === undefined) return undefined;
    if (apiKey || timeout !== undefined) {
      return { url: cleaned, apiKey, timeout };
    }
    return cleaned;
  };

  return resolveNetworkConfig({
    networkPassphrase:
      normalizeString(overrides.networkPassphrase) ??
      normalizeString(env[NETWORK_ENV_VARS.networkPassphrase]),
    sorobanRpcUrl: overrides.sorobanRpcUrl ?? buildEndpoint(env[NETWORK_ENV_VARS.sorobanRpcUrl]),
    horizonUrl: overrides.horizonUrl ?? buildEndpoint(env[NETWORK_ENV_VARS.horizonUrl]),
    networkName:
      normalizeString(overrides.networkName) ?? normalizeString(env[NETWORK_ENV_VARS.networkName]),
  });
}

/** Default per-request timeout in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Per-request cancellation options accepted by every SDK API method. */
export interface RequestOptions {
  /** Request timeout in ms. Overrides the client-level `timeout`. */
  timeout?: number;
  /** Caller-supplied signal; aborting it cancels the request. */
  signal?: AbortSignal;
  /** Custom per-request HTTP headers. */
  headers?: Record<string, string>;
}

/**
 * Run `fn` with an `AbortSignal` that fires when either `timeoutMs` elapses
 * or the caller's `signal` aborts. Rejects with a typed {@link TimeoutError}
 * or {@link AbortError} respectively.
 */
export async function withRequestTimeout<T>(
  operation: string,
  fn: (signal: AbortSignal) => Promise<T>,
  { timeout = DEFAULT_REQUEST_TIMEOUT_MS, signal }: RequestOptions = {},
): Promise<T> {
  if (signal?.aborted) throw new AbortError(operation);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (timedOut) throw new TimeoutError(operation, timeout);
    if (signal?.aborted) throw new AbortError(operation);
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Validate that a header key does not contain disallowed control characters or whitespace.
 * Conforms to RFC 7230 §3.2.6 token requirements.
 */
export function validateHeaderKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new ValidationError('headers', 'Header key must be a non-empty string');
  }
  // Disallow control characters (0x00-0x1F, 0x7F) and whitespace
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code <= 32 || code === 127) {
      throw new ValidationError(
        'headers',
        `Header key "${key}" contains disallowed control characters or whitespace`,
      );
    }
  }
}

/**
 * Validate that a header value does not contain disallowed control characters (CR, LF, NUL).
 */
export function validateHeaderValue(key: string, value: string): void {
  if (typeof value !== 'string') {
    throw new ValidationError('headers', `Header value for "${key}" must be a string`);
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0 || code === 10 || code === 13) {
      throw new ValidationError(
        'headers',
        `Header value for "${key}" contains disallowed control characters`,
      );
    }
  }
}

/**
 * Sanitize and validate a dictionary of custom HTTP headers.
 */
export function sanitizeHeaders(headers?: Record<string, string>): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {};
  const sanitized: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(headers)) {
    const key = rawKey.trim();
    validateHeaderKey(key);
    validateHeaderValue(key, rawVal);
    sanitized[key] = rawVal;
  }
  return sanitized;
}

/**
 * Merge base headers, custom client headers, and per-request headers.
 * Protects critical auth headers from being overridden by custom headers.
 */
export function mergeHeaders(
  baseHeaders: Record<string, string>,
  customClientHeaders?: Record<string, string>,
  perRequestHeaders?: Record<string, string>,
): Record<string, string> {
  const sanitizedClient = sanitizeHeaders(customClientHeaders);
  const sanitizedRequest = sanitizeHeaders(perRequestHeaders);

  // Combine custom client headers and per-request overrides
  const customMerged = {
    ...sanitizedClient,
    ...sanitizedRequest,
  };

  const result: Record<string, string> = { ...customMerged };

  // Base auth and critical headers always take precedence over custom headers
  for (const [key, value] of Object.entries(baseHeaders)) {
    result[key] = value;
  }

  return result;
}

/**
 * Normalize a string value, trimming whitespace and converting empty strings to undefined.
 */
function normalizeString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ── Client-side request throttle queue (#728) ───────────────────────────────
//
// A sliding-window token-bucket limiter for outgoing Horizon / API
// requests, so batch SDK usage (e.g. polling many orders, or fanning out
// balance checks for many agent wallets) doesn't trip Horizon's 429
// rate limiting. Requests above the configured `maxRequestsPerSecond`
// are queued rather than rejected, and critical requests (transaction
// submission) jump ahead of routine polling requests in that queue.

/** Relative priority of a throttled request. Higher runs first. */
export enum RequestPriority {
  /** Routine polling / read queries (order status, balances, listings). */
  Normal = 0,
  /** Transaction-submission or other critical, latency-sensitive calls. */
  Critical = 10,
}

/** Options accepted by {@link RequestThrottle}. */
export interface RequestThrottleOptions {
  /**
   * Maximum number of requests allowed to start within any rolling
   * `windowMs` window. Must be a positive integer. Defaults to 10,
   * matching Horizon's common default rate limit guidance.
   */
  maxRequestsPerSecond?: number;
  /** Size of the sliding window, in ms. Defaults to 1000 (1 second). */
  windowMs?: number;
  /** Optional logger for queue/throttle diagnostics. */
  logger?: Logger;
}

interface QueuedTask<T> {
  priority: RequestPriority;
  /** Monotonic sequence number — preserves FIFO order within the same priority. */
  seq: number;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

/**
 * Client-side sliding-window token-bucket request throttle.
 *
 * Call {@link RequestThrottle.schedule} to run a function under the
 * throttle instead of calling it directly. When the configured rate is
 * already saturated, the call is queued (in priority order, then FIFO)
 * and runs as soon as the sliding window has room again — it is never
 * rejected outright, matching the issue's "auto-queue" requirement
 * rather than a hard reject-on-429-risk policy.
 *
 * @example
 * ```typescript
 * const throttle = new RequestThrottle({ maxRequestsPerSecond: 10 });
 *
 * // Routine polling — queues behind critical requests under load.
 * const order = await throttle.schedule(() => client.getOrder(id));
 *
 * // Transaction submission — jumps ahead of queued polling requests.
 * const result = await throttle.schedule(
 *   () => submitPayment(tx),
 *   RequestPriority.Critical,
 * );
 * ```
 */
export class RequestThrottle {
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly logger?: Logger;

  /** Start timestamps (ms) of requests that began within the current window. */
  private timestamps: number[] = [];
  private queue: QueuedTask<unknown>[] = [];
  private seqCounter = 0;
  private draining = false;

  constructor(options: RequestThrottleOptions = {}) {
    const maxRequestsPerSecond = options.maxRequestsPerSecond ?? 10;
    if (!Number.isInteger(maxRequestsPerSecond) || maxRequestsPerSecond < 1) {
      throw new ValidationError('maxRequestsPerSecond', 'must be a positive integer when provided');
    }
    const windowMs = options.windowMs ?? 1000;
    if (!Number.isInteger(windowMs) || windowMs < 1) {
      throw new ValidationError('windowMs', 'must be a positive integer when provided');
    }
    this.maxPerWindow = maxRequestsPerSecond;
    this.windowMs = windowMs;
    this.logger = options.logger;
  }

  /** Current configured rate limit (requests per window). */
  get limit(): number {
    return this.maxPerWindow;
  }

  /** Number of tasks currently waiting in the queue (not yet started). */
  get queueLength(): number {
    return this.queue.length;
  }

  /** Drop timestamps that have fallen outside the sliding window. */
  private pruneWindow(now: number): void {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.timestamps.length && this.timestamps[i] <= cutoff) i++;
    if (i > 0) this.timestamps.splice(0, i);
  }

  /** Whether a new request may start immediately under the current window. */
  private hasCapacity(now: number): boolean {
    this.pruneWindow(now);
    return this.timestamps.length < this.maxPerWindow;
  }

  /**
   * Schedule `fn` to run under this throttle. Resolves/rejects with
   * whatever `fn` resolves/rejects with, once it has actually run.
   *
   * @param fn - The request to run once throttle capacity allows it.
   * @param priority - {@link RequestPriority.Critical} requests are
   *   dequeued ahead of {@link RequestPriority.Normal} ones. Defaults
   *   to Normal (routine polling/read traffic).
   */
  schedule<T>(
    fn: () => Promise<T>,
    priority: RequestPriority = RequestPriority.Normal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<T> = {
        priority,
        seq: this.seqCounter++,
        run: fn,
        resolve,
        reject,
      };
      // Insert in priority order (higher priority first), FIFO within
      // the same priority — a simple sorted-insert is fine at the
      // queue depths this throttle is meant for (batch SDK calls, not
      // a high-throughput message broker).
      let insertAt = this.queue.length;
      for (let i = 0; i < this.queue.length; i++) {
        if (this.queue[i].priority < task.priority) {
          insertAt = i;
          break;
        }
      }
      this.queue.splice(insertAt, 0, task as QueuedTask<unknown>);
      this.logger?.debug?.(
        `RequestThrottle: queued (priority=${priority}, queueLength=${this.queue.length})`,
      );
      void this.drain();
    });
  }

  /** Process the queue, starting as many tasks as current capacity allows. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const now = Date.now();
        if (!this.hasCapacity(now)) {
          // Wait until the oldest timestamp in the window falls out of it,
          // then re-check — avoids a busy-loop while still being responsive
          // to new headroom as soon as it exists.
          const oldest = this.timestamps[0];
          const waitMs = Math.max(1, oldest + this.windowMs - now);
          this.logger?.debug?.(`RequestThrottle: at capacity, waiting ${waitMs}ms`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        const task = this.queue.shift();
        if (!task) continue;
        this.timestamps.push(Date.now());
        // Run without awaiting here — tasks run concurrently once
        // admitted, only their *start* is rate-limited. Awaiting would
        // serialize unrelated requests behind each other's full
        // round-trip latency, which the "throttle," not "mutex," intent
        // of this queue does not call for.
        task.run().then(task.resolve, task.reject);
      }
    } finally {
      this.draining = false;
    }
  }
}
