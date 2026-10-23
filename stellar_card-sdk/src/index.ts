export { Stellar_CardClient } from './client';
export { ReconnectingStreamClient } from './streaming';
export type { StreamingClientOptions, StreamMessage, ConnectionState } from './streaming';
export type {
  OrderOptions,
  CreateOrderOptions,
  OrderResponse,
  OrderStatus,
  OrderListItem,
  OrderPhase,
  CardDetails,
  PaymentInstructions,
  Budget,
  UsageSummary,
  RetryOptions,
  WaitForCardOptions,
  WaitForOrderFulfillmentOptions,
  ListOrdersOptions,
  ListOrdersPage,
  IterateOrdersOptions,
  ReportStatusOptions,
  StellarCardClientOptions,
  AuditLogEntry,
  ListAuditLogsOptions,
} from './client';

export {
  calculateExponentialBackoffDelay,
  parseRetryAfterMs,
  sleep,
  withRetry,
  withAdvancedRetry,
  isRetryableHttpStatus,
  isTransientError,
} from './retry';
export type {
  ExponentialBackoffDelayOptions,
  WithRetryOptions,
  AdvancedRetryStrategy,
} from './retry';

export {
  createWallet,
  getBalance,
  addUsdcTrustline,
  payViaContract,
  purchaseCard,
  estimateXlmRequired,
  isValidStellarAddress,
  resolveFederationAddress,
  signMessage,
  verifyMessage,
  // Re-export from this barrel to keep external imports stable even if
  // internal module boundaries change later.
  // Back-compat alias for payViaContract.
  payVCC,
  // SEP-0007 deep-link helpers (#772)
  buildSep7PayUri,
  buildSep7TxUri,
  parseSep7Uri,
  // Claimable balances (#736)
  createClaimableBalance,
  claimBalance,
  getClaimableBalances,
  // Transaction memo builder (#739)
  buildTransactionMemo,
  MEMO_TEXT_MAX_BYTES,
  MEMO_HASH_BYTES,
  MEMO_ID_MAX,
} from './stellar';
export type {
  WalletInfo,
  PayOpts,
  EstimateXlmOptions,
  XlmEstimateResult,
  FederationAddressResolution,
  Sep7PayParams,
  Sep7TxParams,
  Sep7ParsedUri,
  ClaimPredicate,
  ClaimableBalanceClaimant,
  CreateClaimableBalanceOpts,
  ClaimableBalanceEntry,
  MemoType,
} from './stellar';

export { getAccountBalances, clearBalanceCache, BALANCE_CACHE_TTL_MS } from './stellar';
export type { WalletInfo, PayOpts, AccountBalances, AssetBalance } from './stellar';

export {
  createOWSWallet,
  importStellarKey,
  getOWSPublicKey,
  getOWSBalance,
  addUsdcTrustlineOWS,
  checkSorobanTxLanded,
  payViaContractOWS,
  purchaseCardOWS,
  onboardAgent,
  // Back-compat alias.
  payVCCOWS,
  saveWalletToKeystore,
  loadWalletFromKeystore,
  zeroizeSecret,
  createKeystore,
  NodeFileSystemKeystore,
  BrowserKeystore,
} from './ows';
export type { EncryptedKeystore } from './ows';

export type {
  TrustlineOpts,
  PayViaContractOwsOpts,
  PayVCCOwsOpts,
  PurchaseCardOwsOpts,
  OnboardAgentOpts,
  OnboardAgentResult,
} from './ows';

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
  NetworkError,
  TimeoutError,
  AbortError,
  ConfigurationError,
  ValidationError,
  SorobanRpcError,
  HorizonError,
  WalletError,
  InvalidMemoError,
  parseApiError,
  wrapError,
  wrapValidationError,
  buildErrorChain,
  isRetryableByDefault,
  wrapNetworkError,
  wrapTimeoutError,
  wrapSorobanError,
  wrapHorizonError,
  wrapWalletError,
  ContractExecutionError,
  type ErrorContext,
  type ConfigurationIssue,
} from './errors';

export {
  InsufficientFeeError,
  parseContractError,
  extractContractErrorCode,
  computeFeeRefund,
  extractFeeMetricsFromHorizon,
  fetchContractConfig,
  CONTRACT_ERROR_MESSAGES,
  CONTRACT_ERROR_MAP,
} from './soroban';
export type { ContractPaymentResult } from './types';
export type { ContractConfig } from './soroban';

export {
  createLogger,
  SilentLogger,
  ConsoleLogger,
  type Logger,
  type LogLevel,
  type LoggerOptions,
} from './logger';

export {
  encrypt,
  decrypt,
  encryptStellarKey,
  decryptStellarKey,
  reEncrypt,
  verifyPassphrase,
} from './encryption';
export type { EncryptedPayload, EncryptOptions, DecryptOptions } from './encryption';

export {
  mppCharge,
  generateMppChallenge,
  serializeMppChallenge,
  signMppChallenge,
  verifyMppChallengeSignature,
  formatMppCredentialHeader,
} from './mpp';
export type {
  MppChargeOpts,
  MppChargeResult,
  MppChallenge,
  MppChallengeSignatureVerificationOptions,
  MppCredentialHeaderOptions,
} from './mpp';

export {
  loadStellar_CardConfig,
  saveStellar_CardConfig,
  resolveCredentials,
  saveEncryptedConfigKey,
  loadEncryptedConfigKey,
  detectNetworkFromPassphrase,
  MAINNET_PASSPHRASE,
  TESTNET_PASSPHRASE,
  MAINNET_USDC_SAC,
  TESTNET_USDC_SAC,
} from './config';
export type { Stellar_CardConfig, NetworkDetectionOptions, DetectedNetworkConfig } from './config';

export {
  paginate,
  iteratePages,
  collectAllPages,
  mapPaginated,
  createOrderPaginator,
} from './pagination';
export type {
  PaginationCursor,
  PaginatedResult,
  PaginateOptions,
  IteratePagesOptions,
  MapPaginatedOptions,
  OrderPaginatorOptions,
  OrderPaginator,
} from './pagination';

export {
  resolveNetworkConfig,
  resolveNetworkConfigFromEnv,
  resolveNetworkConfigWithRetry,
  getDefaultSorobanRpcUrl,
  getDefaultHorizonUrl,
  createCustomNetworkConfig,
  createExtendedNetworkConfig,
  validateRpcEndpoint,
  validateNetworkConfig,
  NETWORK_ENV_VARS,
  withRequestTimeout,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from './network';
export type {
  NetworkConfig,
  RpcEndpointConfig,
  RpcProxyConfig,
  ExtendedRpcEndpointConfig,
  ResolvedRpcEndpoint,
  ResolvedNetworkConfig,
  RequestOptions,
} from './network';

export {
  clientOptionsSchema,
  createOrderSchema,
  validateClientOptions,
  validateCreateOrderInput,
} from './validation';

// Export comprehensive type definitions
export type {
  NetworkType,
  RpcEndpoint,
  ExtendedNetworkConfig,
  HttpMethod,
  HttpHeaders,
  HttpRequestOptions,
  HttpResponse,
  WalletKeypair,
  OWSWalletMetadata,
  TransactionSimulation,
  TransactionResult,
  PaymentAsset,
  OrderCreationParams,
  PaymentQuote,
  ExtendedPaymentInstructions,
  DetailedOrderPhase,
  OrderStatusHistory,
  OrderHistoryEventType,
  OrderHistoryEvent,
  ExtendedOrderStatus,
  DetailedBudget,
  OrderStatistics,
  ExtendedUsageSummary,
  ErrorSeverity,
  ExtendedErrorContext,
  RetryStrategy,
  SortDirection,
  SortOptions,
  FilterOperator,
  FilterCondition,
  AdvancedListOptions,
  DeepRequired,
  DeepPartial,
  KeysOfType,
  AsyncFunction,
  Callback,
  EventEmitter,
  // Additional typings (#150)
  OrderSummary,
  CardIssuanceResult,
  BudgetGuard,
  StellarCardSDKVersion,
  // Order event typings (#486)
  OrderEventType,
  OrderEventSource,
  OrderEvent,
  WebhookDeliveryStatus,
  OrderWebhookConfig,
  WebhookDelivery,
  OrderEventSubscription,
  OrderHistoryEntry,
  OrderHistoryResponse,
  // Order status discriminated union (#729)
  OrderCard,
  OrderStatusLiteral,
  ActiveOrder,
  PendingOrder,
  FailedOrder,
  Order,
} from './types';

export {
  isPaymentAsset,
  isOrderPhase,
  isNetworkType,
  hasErrorCode,
  isRetryableError,
  isOrderSummary,
  isCardIssuanceResult,
  // Order event type guards (#486)
  isOrderEventType,
  isOrderEvent,
  isWebhookDelivery,
  isOrderEventSubscription,
  // Order status type guards (#729)
  isActiveOrder,
  isPendingOrder,
  isFailedOrder,
} from './types';

// Webhook signature verification helper (#717)
export {
  verifyWebhookSignature,
  WebhookVerificationError,
  type VerifyWebhookOptions,
  type WebhookVerificationFailureReason,
} from './webhook';
