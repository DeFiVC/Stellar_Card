/**
 * Comprehensive TypeScript type definitions for the stellar_card SDK.
 *
 * This module provides all the core types, interfaces, and type guards
 * used across the SDK for type-safe interactions with the stellar_card API.
 */

// ============================================================================
// NETWORK & CONFIGURATION TYPES
// ============================================================================

/** Supported Stellar network identifiers */
export type NetworkType = 'mainnet' | 'testnet' | 'futurenet' | 'custom';

/** RPC endpoint configuration */
export interface RpcEndpoint {
  /** Soroban RPC URL */
  url: string;
  /** Optional request timeout in milliseconds */
  timeout?: number;
  /** Optional API key for authenticated RPC endpoints */
  apiKey?: string;
}

/** Complete network configuration with custom endpoints */
export interface ExtendedNetworkConfig {
  /** Network passphrase (e.g., Networks.PUBLIC) */
  networkPassphrase: string;
  /** Soroban RPC configuration */
  sorobanRpc: RpcEndpoint;
  /** Horizon REST API configuration */
  horizon: RpcEndpoint;
  /** Optional friendly name for the network */
  name?: string;
}

// ============================================================================
// API CLIENT TYPES
// ============================================================================

/** HTTP method types */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** HTTP request headers */
export interface HttpHeaders {
  [key: string]: string;
}

/** HTTP request options */
export interface HttpRequestOptions {
  method: HttpMethod;
  headers?: HttpHeaders;
  body?: string;
  signal?: AbortSignal;
  timeout?: number;
}

/** HTTP response wrapper */
export interface HttpResponse<T = unknown> {
  status: number;
  statusText: string;
  headers: HttpHeaders;
  data: T;
}

// ============================================================================
// WALLET & TRANSACTION TYPES
// ============================================================================

/** Wallet keypair information */
export interface WalletKeypair {
  /** Stellar public key (G...) */
  publicKey: string;
  /** Stellar secret key (S...) - keep secure */
  secret: string;
}

/** OWS wallet metadata */
export interface OWSWalletMetadata {
  /** Unique wallet identifier */
  walletId: string;
  /** Wallet name */
  name: string;
  /** Stellar public key */
  publicKey: string;
  /** Vault file path */
  vaultPath?: string;
  /** Whether the wallet is encrypted */
  encrypted: boolean;
}

/** Transaction simulation result */
export interface TransactionSimulation {
  /** Estimated fee in stroops */
  fee: string;
  /** Resource usage estimation */
  resources: {
    cpuInstructions: number;
    readBytes: number;
    writeBytes: number;
  };
  /** Whether simulation succeeded */
  success: boolean;
  /** Simulation error if any */
  error?: string;
}

/** Transaction submission result */
export interface TransactionResult {
  /** Transaction hash */
  hash: string;
  /** Ledger number where tx was included */
  ledger: number;
  /** Whether transaction succeeded */
  successful: boolean;
  /** Result XDR */
  resultXdr?: string;
  /** Fee actually charged by the network, in stroops */
  feeCharged?: string;
  /** Fee refunded (maxFee − feeCharged), in stroops */
  feeRefunded?: string;
  /** Maximum fee allocated when the transaction was built, in stroops */
  maxFee?: string;
}

/** Result of a Soroban contract payment (pay_usdc / pay_xlm). */
export interface ContractPaymentResult {
  /** Transaction hash (64-char hex) */
  hash: string;
  /** Fee actually charged, in stroops */
  feeCharged: string;
  /** Fee refunded (maxFee − feeCharged), in stroops */
  feeRefunded: string;
  /** Max fee allocated on the envelope, in stroops */
  maxFee: string;
}

// ============================================================================
// PAYMENT & ORDER TYPES
// ============================================================================

/** Payment asset types */
export type PaymentAsset = 'usdc' | 'xlm';

/** Order creation parameters */
export interface OrderCreationParams {
  /** Amount in USDC (decimal string like "10.00") */
  amount_usdc: string;
  /** Optional webhook URL for order status updates */
  webhook_url?: string;
  /** Optional metadata attached to the order */
  metadata?: Record<string, unknown>;
  /** Optional idempotency key */
  idempotency_key?: string;
}

/** Payment quote details */
export interface PaymentQuote {
  /** Quoted amount (decimal string) */
  amount: string;
  /** Asset identifier (e.g., "USDC:issuer" or just "XLM") */
  asset: string;
  /** Exchange rate if applicable */
  rate?: string;
  /** Quote expiration timestamp */
  expiresAt?: string;
}

/** Extended payment instructions with validation */
export interface ExtendedPaymentInstructions {
  /** Payment model type */
  type: 'soroban_contract';
  /** Contract address (C...) */
  contract_id: string;
  /** Order ID to include in payment */
  order_id: string;
  /** USDC payment quote */
  usdc: PaymentQuote;
  /** Optional XLM payment quote */
  xlm?: PaymentQuote;
  /** Network passphrase for the payment */
  networkPassphrase?: string;
  /** Deadline timestamp for payment */
  deadline?: string;
}

// ============================================================================
// ORDER STATUS & LIFECYCLE TYPES
// ============================================================================

/** Detailed order phase with substates */
export type DetailedOrderPhase =
  | 'awaiting_approval'
  | 'awaiting_payment'
  | 'payment_received'
  | 'processing'
  | 'fulfilling'
  | 'ready'
  | 'delivered'
  | 'failed'
  | 'refunded'
  | 'rejected'
  | 'expired'
  | 'cancelled';

/** Order status history entry */
export interface OrderStatusHistory {
  /** Status at this point */
  status: string;
  /** Phase at this point */
  phase: DetailedOrderPhase;
  /** Timestamp of status change */
  timestamp: string;
  /** Optional note about the change */
  note?: string;
}

/** Specific order history event types for detailed tracking */
export type OrderHistoryEventType =
  | 'payment_initiated'
  | 'payment_confirmed'
  | 'card_issued'
  | 'refund_processed'
  | 'order_cancelled';

/** Order history event with typed payload */
export interface OrderHistoryEvent {
  /** Type of the event */
  type: OrderHistoryEventType;
  /** Timestamp of the event */
  timestamp: string;
  /** Additional payload data */
  payload?: Record<string, unknown>;
}

/** Extended order status with history */
export interface ExtendedOrderStatus {
  /** Order identifier */
  order_id: string;
  /** Current status string */
  status: string;
  /** Current lifecycle phase */
  phase: DetailedOrderPhase;
  /** Ordered amount in USDC */
  amount_usdc: string;
  /** Payment asset used */
  payment_asset: PaymentAsset;
  /** Card details if ready */
  card?: {
    number: string;
    cvv: string;
    expiry: string;
    brand: string | null;
  };
  /** Error message if failed */
  error?: string;
  /** Additional notes */
  note?: string;
  /** Refund info if applicable */
  refund?: {
    stellar_txid: string;
    amount: string;
    asset: string;
  };
  /** Payment instructions if pending */
  payment?: ExtendedPaymentInstructions;
  /** Order creation timestamp */
  created_at: string;
  /** Last update timestamp */
  updated_at: string;
  /** Status change history */
  history?: OrderStatusHistory[];
}

// ============================================================================
// BUDGET & USAGE TYPES
// ============================================================================

/** Detailed budget information */
export interface DetailedBudget {
  /** Total spent in USDC */
  spent_usdc: string;
  /** In-flight orders amount */
  in_flight_usdc: string;
  /** Total committed (spent + in-flight) */
  committed_usdc: string;
  /** Spend limit or null if unlimited */
  limit_usdc: string | null;
  /** Remaining budget or null if unlimited */
  remaining_usdc: string | null;
  /** Budget period (e.g., "monthly", "lifetime") */
  period?: string;
  /** Period start timestamp */
  period_start?: string;
  /** Period end timestamp */
  period_end?: string;
}

/** Order statistics */
export interface OrderStatistics {
  /** Total order count */
  total: number;
  /** Delivered orders */
  delivered: number;
  /** Failed orders */
  failed: number;
  /** Refunded orders */
  refunded: number;
  /** In-progress orders */
  in_progress: number;
  /** Average completion time in seconds */
  avg_completion_time?: number;
  /** Success rate (0-1) */
  success_rate?: number;
}

/** Extended usage summary with analytics */
export interface ExtendedUsageSummary {
  /** API key identifier */
  api_key_id: string;
  /** Optional label for the key */
  label: string | null;
  /** Budget information */
  budget: DetailedBudget;
  /** Order statistics */
  orders: OrderStatistics;
  /** Last activity timestamp */
  last_activity?: string;
  /** Account creation timestamp */
  created_at?: string;
}

// ============================================================================
// ERROR & RETRY TYPES
// ============================================================================

/** Error severity levels */
export type ErrorSeverity = 'fatal' | 'error' | 'warning' | 'info';

/** Extended error context */
export interface ExtendedErrorContext {
  /** Error source component */
  source?: string;
  /** Operation being attempted */
  operation?: string;
  /** Root cause error */
  cause?: Error;
  /** Suggested recovery action */
  recoveryHint?: string;
  /** Error-specific metadata */
  metadata?: Record<string, unknown>;
  /** Error severity */
  severity?: ErrorSeverity;
  /** Whether error is retryable */
  retryable?: boolean;
  /** Retry attempt number */
  retryAttempt?: number;
}

/** Retry strategy configuration */
export interface RetryStrategy {
  /** Maximum retry attempts */
  maxAttempts: number;
  /** Base delay between retries */
  baseDelayMs: number;
  /** Maximum delay cap */
  maxDelayMs: number;
  /** Backoff multiplier */
  backoffMultiplier: number;
  /** Whether to use jitter */
  useJitter: boolean;
  /** Custom retry condition */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

// ============================================================================
// PAGINATION & FILTERING TYPES
// ============================================================================

/** Sort direction */
export type SortDirection = 'asc' | 'desc';

/** Sort options */
export interface SortOptions {
  /** Field to sort by */
  field: string;
  /** Sort direction */
  direction: SortDirection;
}

/** Filter operator */
export type FilterOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';

/** Filter condition */
export interface FilterCondition {
  /** Field to filter on */
  field: string;
  /** Filter operator */
  operator: FilterOperator;
  /** Filter value */
  value: unknown;
}

/** Advanced list options with filtering */
export interface AdvancedListOptions {
  /** Status filter */
  status?: string;
  /** Page limit */
  limit?: number;
  /** Page offset */
  offset?: number;
  /** Filter by creation time */
  since_created_at?: string;
  /** Filter by update time */
  since_updated_at?: string;
  /** Sort options */
  sort?: SortOptions;
  /** Additional filters */
  filters?: FilterCondition[];
  /** Include related resources */
  include?: string[];
}

// ============================================================================
// TYPE GUARDS
// ============================================================================

/** Type guard for PaymentAsset */
export function isPaymentAsset(value: unknown): value is PaymentAsset {
  return value === 'usdc' || value === 'xlm';
}

/** Type guard for OrderPhase */
export function isOrderPhase(value: unknown): value is DetailedOrderPhase {
  const phases: DetailedOrderPhase[] = [
    'awaiting_approval',
    'awaiting_payment',
    'payment_received',
    'processing',
    'fulfilling',
    'ready',
    'delivered',
    'failed',
    'refunded',
    'rejected',
    'expired',
    'cancelled',
  ];
  return typeof value === 'string' && phases.includes(value as DetailedOrderPhase);
}

/** Type guard for NetworkType */
export function isNetworkType(value: unknown): value is NetworkType {
  return value === 'mainnet' || value === 'testnet' || value === 'futurenet' || value === 'custom';
}

/** Type guard to check if error has a specific code */
export function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code
  );
}

/** Type guard to check if error is retryable */
export function isRetryableError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as { status?: number; code?: string; retryable?: boolean };
  if (typeof err.retryable === 'boolean') return err.retryable;
  if (typeof err.status === 'number') {
    return err.status === 429 || err.status === 502 || err.status === 503 || err.status === 504;
  }
  return false;
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

/** Make all properties of T required and non-nullable */
export type DeepRequired<T> = {
  [P in keyof T]-?: DeepRequired<NonNullable<T[P]>>;
};

/** Make all properties of T optional */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/** Extract keys of T that are of type U */
export type KeysOfType<T, U> = {
  [P in keyof T]: T[P] extends U ? P : never;
}[keyof T];

/** Async version of a function type */
export type AsyncFunction<T extends (...args: never[]) => unknown> = (
  ...args: Parameters<T>
) => Promise<Awaited<ReturnType<T>>>;

/** Callback function type */
export type Callback<T = void, E = Error> = (error: E | null, result?: T) => void;

/** Event emitter interface */
export interface EventEmitter<Events extends Record<string, unknown[]>> {
  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): void;
  off<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): void;
  emit<K extends keyof Events>(event: K, ...args: Events[K]): void;
}

// ============================================================================
// ENHANCED INTERFACES - PART 3
// ============================================================================

/** Server-Sent Events stream interface */
export interface SSEStream {
  /** Stream URL */
  url: string;
  /** Connection state */
  readyState: 'connecting' | 'open' | 'closed';
  /** Last event ID for resumption */
  lastEventId?: string;
  /** Event handlers */
  onopen?: (event: Event) => void;
  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: Event) => void;
  /** Close the stream */
  close(): void;
}

/** Enhanced HTTP client configuration */
export interface AdvancedHttpConfig {
  /** Base URL for all requests */
  baseUrl: string;
  /** Default headers for all requests */
  defaultHeaders?: HttpHeaders;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Retry configuration */
  retryConfig?: RetryStrategy;
  /** Request interceptors */
  requestInterceptors?: Array<(config: HttpRequestOptions) => HttpRequestOptions>;
  /** Response interceptors */
  responseInterceptors?: Array<(response: HttpResponse) => HttpResponse>;
}

/** Request context for debugging and monitoring */
export interface RequestContext {
  /** Unique request identifier */
  requestId: string;
  /** Request timestamp */
  timestamp: Date;
  /** Request method */
  method: HttpMethod;
  /** Request URL */
  url: string;
  /** Request attempt number */
  attempt: number;
  /** Parent trace ID for distributed tracing */
  traceId?: string;
}

/** Wallet security configuration */
export interface WalletSecurityConfig {
  /** Encryption algorithm used */
  encryption: 'aes-256-gcm' | 'chacha20-poly1305';
  /** Key derivation function */
  kdf: 'pbkdf2' | 'scrypt' | 'argon2id';
  /** KDF iterations/parameters */
  kdfParams: Record<string, number>;
  /** Whether biometric unlock is enabled */
  biometricEnabled?: boolean;
  /** Hardware security module integration */
  hsmConfig?: {
    provider: string;
    keyId: string;
  };
}

/** Multi-signature wallet configuration */
export interface MultiSigWalletConfig {
  /** Required signatures for transactions */
  threshold: number;
  /** Authorized signers */
  signers: Array<{
    publicKey: string;
    weight: number;
    label?: string;
  }>;
  /** Transaction approval workflow */
  approvalWorkflow?: {
    requireManualApproval: boolean;
    approvers: string[];
    timeoutMs: number;
  };
}

/** Hardware wallet interface */
export interface HardwareWalletInfo {
  /** Hardware wallet type */
  type: 'ledger' | 'trezor' | 'keepkey';
  /** Device connection status */
  connected: boolean;
  /** Device firmware version */
  firmwareVersion: string;
  /** Supported applications */
  supportedApps: string[];
  /** Device-specific metadata */
  deviceMetadata: Record<string, unknown>;
}

/** Transaction performance metrics */
export interface TransactionMetrics {
  /** Transaction build time in ms */
  buildTimeMs: number;
  /** Signature time in ms */
  signTimeMs: number;
  /** Network submission time in ms */
  submitTimeMs: number;
  /** Total confirmation time in ms */
  confirmTimeMs: number;
  /** Network fee paid */
  feePaid: string;
  /** Resource consumption */
  resourceUsage: {
    cpuInstructions: number;
    memoryBytes: number;
    storageBytes: number;
  };
}

/** Order completion analytics */
export interface OrderAnalytics {
  /** Order processing stages with timestamps */
  stages: Array<{
    stage: string;
    timestamp: string;
    durationMs?: number;
  }>;
  /** Performance metrics */
  metrics: {
    totalProcessingTimeMs: number;
    paymentConfirmationTimeMs: number;
    cardIssuanceTimeMs: number;
  };
  /** Geographic data if available */
  location?: {
    country: string;
    region?: string;
    city?: string;
  };
}

/** Environment-specific configuration */
export interface EnvironmentConfig {
  /** Environment name */
  environment: 'development' | 'staging' | 'production' | 'test';
  /** Debug mode enabled */
  debug: boolean;
  /** Logging configuration */
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    destinations: Array<'console' | 'file' | 'remote'>;
    format: 'json' | 'text';
  };
  /** Feature flags */
  features: Record<string, boolean>;
  /** Rate limiting configuration */
  rateLimits: {
    requestsPerSecond: number;
    burstCapacity: number;
    windowSizeMs: number;
  };
}

/** SDK configuration with all options */
export interface ComprehensiveSDKConfig {
  /** API credentials */
  apiKey: string;
  /** API base URL */
  baseUrl?: string;
  /** Network configuration */
  network?: ExtendedNetworkConfig;
  /** HTTP client configuration */
  httpConfig?: AdvancedHttpConfig;
  /** Wallet configuration */
  walletConfig?: {
    type: 'ows' | 'raw-keypair' | 'hardware';
    name?: string;
    security?: WalletSecurityConfig;
  };
  /** Environment configuration */
  environment?: EnvironmentConfig;
}

// ============================================================================
// ENHANCED TYPE GUARDS & VALIDATORS
// ============================================================================

/** Enhanced type guard for API responses */
export function isValidApiResponse<T>(
  response: unknown,
  validator: (data: unknown) => data is T,
): response is { data: T; status: number } {
  return (
    typeof response === 'object' &&
    response !== null &&
    'data' in response &&
    'status' in response &&
    typeof (response as { status: unknown }).status === 'number' &&
    validator((response as { data: unknown }).data)
  );
}

/** Type guard for network configuration */
export function isValidNetworkConfig(config: unknown): config is ExtendedNetworkConfig {
  return (
    typeof config === 'object' &&
    config !== null &&
    (!('networkPassphrase' in config) ||
      typeof (config as { networkPassphrase: unknown }).networkPassphrase === 'string')
  );
}

/** Type guard for wallet keypair */
export function isValidWalletKeypair(keypair: unknown): keypair is WalletKeypair {
  return (
    typeof keypair === 'object' &&
    keypair !== null &&
    'publicKey' in keypair &&
    'secret' in keypair &&
    typeof (keypair as { publicKey: unknown }).publicKey === 'string' &&
    typeof (keypair as { secret: unknown }).secret === 'string' &&
    (keypair as { publicKey: string }).publicKey.startsWith('G') &&
    (keypair as { secret: string }).secret.startsWith('S')
  );
}

/** Type guard for order status */
export function isValidOrderStatus(status: unknown): status is ExtendedOrderStatus {
  return (
    typeof status === 'object' &&
    status !== null &&
    'order_id' in status &&
    'status' in status &&
    'phase' in status &&
    typeof (status as { order_id: unknown }).order_id === 'string' &&
    typeof (status as { status: unknown }).status === 'string' &&
    isOrderPhase((status as { phase: unknown }).phase)
  );
}

// ============================================================================
// ADVANCED UTILITY TYPES
// ============================================================================

/** Extract promise result type */
export type PromiseResult<T> = T extends Promise<infer U> ? U : never;

/** Make specific properties required */
export type RequireFields<T, K extends keyof T> = T & Required<Pick<T, K>>;

/** Make specific properties optional */
export type PartialFields<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/** Create a union type from object values */
export type ValueOf<T> = T[keyof T];

/** Recursive readonly type */
export type DeepReadonly<T> = {
  readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P];
};

/** Mutable version of readonly type */
export type Mutable<T> = {
  -readonly [P in keyof T]: T[P];
};

/** Function that returns a promise */
export type AsyncFn<TArgs extends readonly unknown[] = readonly unknown[], TReturn = unknown> = (
  ...args: TArgs
) => Promise<TReturn>;

/** Non-nullable version of type */
export type StrictNonNullable<T> = T extends null | undefined ? never : T;

/** JSON-serializable version of type */
export type JSONSerializable<T> = T extends string | number | boolean | null
  ? T
  : T extends readonly (infer U)[]
    ? readonly JSONSerializable<U>[]
    : T extends { [key: string]: unknown }
      ? { [K in keyof T]: JSONSerializable<T[K]> }
      : never;

// ============================================================================
// ADDITIONAL TYPINGS (#150)
// ============================================================================

/**
 * Lightweight order summary for display, reporting, and analytics dashboards.
 * A subset of {@link ExtendedOrderStatus} with only the fields needed for
 * list views and aggregation.
 */
export interface OrderSummary {
  /** Order identifier */
  order_id: string;
  /** Current status string */
  status: string;
  /** Ordered amount in USDC */
  amount_usdc: string;
  /** Payment asset used */
  payment_asset: PaymentAsset;
  /** Order creation timestamp (ISO-8601) */
  created_at: string;
  /** Whether the order is in a terminal state */
  is_terminal: boolean;
}

/**
 * Result returned once a card has been successfully issued.
 * Extends the raw card fields from the API with a convenience
 * `issued_at` timestamp and the originating `order_id`.
 */
export interface CardIssuanceResult {
  /** Originating order identifier */
  order_id: string;
  /** 16-digit card number */
  number: string;
  /** 3-digit CVV */
  cvv: string;
  /** Expiry in MM/YY format */
  expiry: string;
  /** Card brand (e.g. "Visa"), or null when not provided */
  brand: string | null;
  /** ISO-8601 timestamp when the card was issued */
  issued_at: string;
}

/**
 * Pre-flight budget check result used to gate order creation.
 *
 * @example
 * ```typescript
 * const guard = await checkBudget(client, '25.00');
 * if (!guard.allowed) {
 *   console.error(guard.reason);
 * } else {
 *   await client.createOrder({ amount_usdc: '25.00' });
 * }
 * ```
 */
export interface BudgetGuard {
  /** Whether the requested amount fits within the remaining budget */
  allowed: boolean;
  /** Human-readable reason when `allowed` is `false` */
  reason?: string;
  /** Requested amount in USDC */
  requested_usdc: string;
  /** Remaining budget after this order, or null when unlimited */
  remaining_after_usdc: string | null;
}

/**
 * SDK version information exposed via `getSdkVersion()` (if present) or
 * bundled at build time for runtime compatibility checks.
 */
export interface StellarCardSDKVersion {
  /** Semantic version string, e.g. `"0.4.7"` */
  version: string;
  /** Major version number */
  major: number;
  /** Minor version number */
  minor: number;
  /** Patch version number */
  patch: number;
  /** Optional pre-release identifier, e.g. `"beta.1"` */
  prerelease?: string;
}

/**
 * Type guard — narrows `value` to {@link OrderSummary}.
 *
 * Checks for the minimum required fields rather than every optional field
 * so it handles both full API responses and trimmed list items.
 */
export function isOrderSummary(value: unknown): value is OrderSummary {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['order_id'] === 'string' &&
    typeof v['status'] === 'string' &&
    typeof v['amount_usdc'] === 'string' &&
    typeof v['created_at'] === 'string'
  );
}

/**
 * Type guard — narrows `value` to {@link CardIssuanceResult}.
 */
export function isCardIssuanceResult(value: unknown): value is CardIssuanceResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['order_id'] === 'string' &&
    typeof v['number'] === 'string' &&
    typeof v['cvv'] === 'string' &&
    typeof v['expiry'] === 'string'
  );
}

// ============================================================================
// ORDER HISTORY EVENT TYPES (Part 5)
// ============================================================================

/** Order lifecycle event types emitted during order processing */
export type OrderEventType =
  | 'order_created'
  | 'payment_initiated'
  | 'payment_received'
  | 'payment_confirmed'
  | 'payment_failed'
  | 'trustline_added'
  | 'trustline_failed'
  | 'processing_started'
  | 'card_issued'
  | 'card_delivery_failed'
  | 'order_completed'
  | 'order_failed'
  | 'order_refunded'
  | 'order_cancelled'
  | 'order_expired';

/** Source of an order event */
export type OrderEventSource = 'api' | 'webhook' | 'sse' | 'polling' | 'system';

/** Order lifecycle event with metadata */
export interface OrderEvent {
  /** Unique event identifier */
  event_id: string;
  /** Order this event belongs to */
  order_id: string;
  /** Type of lifecycle event */
  event_type: OrderEventType;
  /** When the event occurred */
  timestamp: string;
  /** Source that generated the event */
  source: OrderEventSource;
  /** Human-readable description of the event */
  message?: string;
  /** Event-specific metadata */
  metadata?: Record<string, unknown>;
  /** Error details if the event represents a failure */
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

/** Webhook delivery status for order events */
export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'retrying';

/** Webhook configuration for order event notifications */
export interface OrderWebhookConfig {
  /** Webhook URL to receive order events */
  url: string;
  /** Event types to subscribe to (empty = all events) */
  events?: OrderEventType[];
  /** Optional secret for HMAC signature verification */
  secret?: string;
  /** Maximum delivery attempts before marking as failed */
  maxRetries?: number;
  /** Custom headers to include in webhook requests */
  headers?: Record<string, string>;
}

/** Webhook delivery record for an order event */
export interface WebhookDelivery {
  /** Delivery identifier */
  delivery_id: string;
  /** Event that was delivered */
  event_id: string;
  /** Order this delivery belongs to */
  order_id: string;
  /** Webhook URL that received the event */
  webhook_url: string;
  /** HTTP status code of the delivery attempt */
  status_code?: number;
  /** Delivery status */
  status: WebhookDeliveryStatus;
  /** Number of delivery attempts made */
  attempts: number;
  /** Timestamp of the last delivery attempt */
  last_attempt_at: string;
  /** Timestamp of successful delivery (if delivered) */
  delivered_at?: string;
  /** Error message if delivery failed */
  error?: string;
}

/** Order event subscription for receiving real-time order updates */
export interface OrderEventSubscription {
  /** Subscription identifier */
  subscription_id: string;
  /** Order IDs to subscribe to (empty = all orders for the API key) */
  order_ids?: string[];
  /** Event types to receive (empty = all events) */
  event_types?: OrderEventType[];
  /** Transport mechanism for receiving events */
  transport: 'webhook' | 'sse' | 'polling';
  /** Whether the subscription is currently active */
  active: boolean;
  /** Subscription creation timestamp */
  created_at: string;
  /** Subscription expiration timestamp (if applicable) */
  expires_at?: string;
}

/** Order history timeline entry with event context */
export interface OrderHistoryEntry {
  /** The event that occurred */
  event: OrderEvent;
  /** Order status at the time of this event */
  status_at_event: string;
  /** Phase at the time of this event */
  phase_at_event: DetailedOrderPhase;
  /** Previous phase (if phase changed) */
  previous_phase?: DetailedOrderPhase;
}

/** Full order history response with timeline */
export interface OrderHistoryResponse {
  /** Order identifier */
  order_id: string;
  /** Chronological list of events */
  entries: OrderHistoryEntry[];
  /** Total event count */
  total: number;
  /** Whether more events are available via pagination */
  has_more: boolean;
  /** Cursor for fetching the next page */
  next_cursor?: string;
}

// ============================================================================
// ORDER STATUS DISCRIMINATED UNION & TYPE GUARDS (#729)
// ============================================================================

/**
 * Card details attached to an order once it reaches the ACTIVE status.
 * Mirrors {@link CardDetails} from `./client` but is kept local here so
 * `types.ts` has no dependency on `client.ts`.
 */
export interface OrderCard {
  /** 16-digit card number. */
  number: string;
  /** 3-digit CVV. */
  cvv: string;
  /** Expiry in MM/YY format. */
  expiry: string;
  /** Card brand (e.g. "Visa"), or null when not provided. */
  brand: string | null;
}

/**
 * Status literals used by the discriminated {@link Order} union.
 *
 * These match the runtime status strings the backend actually sends (see
 * `src/__tests__/order-polling.test.ts`): `'ACTIVE'` once a card has been
 * issued, `'FAILED'` (also covers `'EXPIRED'`-style terminal failures, which
 * the SDK normalizes to `'FAILED'` for guard purposes), and everything else
 * — e.g. `'pending_payment'`, `'processing'` — is `'PENDING'`.
 */
export type OrderStatusLiteral = 'ACTIVE' | 'PENDING' | 'FAILED';

/** Base fields shared by every branch of the {@link Order} union. */
interface BaseOrder {
  order_id: string;
  amount_usdc: string;
  payment_asset: PaymentAsset;
  created_at: string;
  updated_at: string;
}

/** An order whose card has been issued. `card` is required and non-null. */
export interface ActiveOrder extends BaseOrder {
  status: 'ACTIVE';
  /** Issued card details — always present once an order is ACTIVE. */
  card: OrderCard;
}

/** An order still awaiting payment or processing. Never has a `card`. */
export interface PendingOrder extends BaseOrder {
  status: 'PENDING';
  card?: never;
}

/** An order that failed, expired, was rejected, or was refunded. */
export interface FailedOrder extends BaseOrder {
  status: 'FAILED';
  card?: never;
  /** Human-readable failure reason, when available. */
  error?: string;
}

/** Discriminated union over an order's lifecycle, keyed on `status`. */
export type Order = ActiveOrder | PendingOrder | FailedOrder;

/**
 * Type guard — narrows `order` to {@link ActiveOrder}.
 *
 * After this guard returns `true`, `order.card` is accessible without any
 * further null check — `card` is a required, non-optional field on the
 * `ActiveOrder` branch of the {@link Order} union.
 */
export function isActiveOrder(order: Order): order is ActiveOrder {
  return order.status === 'ACTIVE';
}

/** Type guard — narrows `order` to {@link PendingOrder}. */
export function isPendingOrder(order: Order): order is PendingOrder {
  return order.status === 'PENDING';
}

/** Type guard — narrows `order` to {@link FailedOrder}. */
export function isFailedOrder(order: Order): order is FailedOrder {
  return order.status === 'FAILED';
}

// ============================================================================
// ORDER EVENT TYPE GUARDS
// ============================================================================

/** Type guard for OrderEventType */
export function isOrderEventType(value: unknown): value is OrderEventType {
  const types: OrderEventType[] = [
    'order_created',
    'payment_initiated',
    'payment_received',
    'payment_confirmed',
    'payment_failed',
    'trustline_added',
    'trustline_failed',
    'processing_started',
    'card_issued',
    'card_delivery_failed',
    'order_completed',
    'order_failed',
    'order_refunded',
    'order_cancelled',
    'order_expired',
  ];
  return typeof value === 'string' && types.includes(value as OrderEventType);
}

/** Type guard for OrderEvent */
export function isOrderEvent(value: unknown): value is OrderEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'event_id' in value &&
    'order_id' in value &&
    'event_type' in value &&
    'timestamp' in value &&
    'source' in value &&
    typeof (value as { event_id: unknown }).event_id === 'string' &&
    typeof (value as { order_id: unknown }).order_id === 'string' &&
    isOrderEventType((value as { event_type: unknown }).event_type) &&
    typeof (value as { timestamp: unknown }).timestamp === 'string'
  );
}

/** Type guard for WebhookDelivery */
export function isWebhookDelivery(value: unknown): value is WebhookDelivery {
  return (
    typeof value === 'object' &&
    value !== null &&
    'delivery_id' in value &&
    'event_id' in value &&
    'status' in value &&
    typeof (value as { delivery_id: unknown }).delivery_id === 'string' &&
    typeof (value as { event_id: unknown }).event_id === 'string' &&
    ['pending', 'delivered', 'failed', 'retrying'].includes(
      (value as { status: unknown }).status as string,
    )
  );
}

/** Type guard for OrderEventSubscription */
export function isOrderEventSubscription(value: unknown): value is OrderEventSubscription {
  return (
    typeof value === 'object' &&
    value !== null &&
    'subscription_id' in value &&
    'transport' in value &&
    'active' in value &&
    typeof (value as { subscription_id: unknown }).subscription_id === 'string' &&
    typeof (value as { active: unknown }).active === 'boolean' &&
    ['webhook', 'sse', 'polling'].includes((value as { transport: unknown }).transport as string)
  );
}
