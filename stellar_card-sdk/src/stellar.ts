// Helpers for agents using a raw Stellar keypair (S...) to pay the stellar_card
// receiver contract on Soroban. For OWS-wallet custody, see ./ows.ts.

import {
  Keypair,
  Networks,
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  StrKey,
  Memo,
  Claimant,
} from '@stellar/stellar-sdk';
import type { CardDetails, PaymentInstructions } from './client';
import {
  buildContractPaymentTx,
  submitSorobanTx,
  decimalToStroops,
  selectContractCall,
  InsufficientFeeError,
  validateBaseFee,
} from './soroban';
export {
  setDefaultBaseFee,
  getDefaultBaseFee,
  resetDefaultBaseFee,
  DEFAULT_BASE_FEE_STROOPS,
  MAX_BASE_FEE_STROOPS,
} from './soroban';
import type { ContractPaymentResult } from './types';
import type { Logger } from './logger';
import { InvalidMemoError, InvalidAmountError } from './errors';

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/**
 * Convert stroops (1 XLM = 10^7 stroops) to a human-readable decimal string.
 * Handles 7 decimal places and uses BigInt for precision.
 *
 * @param stroops - Stroops as a bigint, number, or numeric string
 * @returns Decimal amount as a string with up to 7 decimal places (trailing zeros removed)
 * @throws {InvalidAmountError} If stroops is negative or not a valid number
 *
 * @example
 * ```typescript
 * stroopsToDecimal(100_000_000n)  // "10.0"
 * stroopsToDecimal(1n)             // "0.0000001"
 * stroopsToDecimal(12_345_678n)   // "1.2345678"
 * stroopsToDecimal(50_000_000)     // "5.0"
 * ```
 */
export function stroopsToDecimal(stroops: bigint | number | string): string {
  let amount: bigint;
  try {
    amount = typeof stroops === 'bigint' ? stroops : BigInt(stroops);
  } catch {
    throw new InvalidAmountError(`Invalid stroops amount: ${stroops}`);
  }

  if (amount < 0n) {
    throw new InvalidAmountError(`Stroops amount must be non-negative: ${stroops}`);
  }

  const whole = amount / 10_000_000n;
  const frac = amount % 10_000_000n;

  if (frac === 0n) {
    return whole.toString();
  }

  const fracStr = frac.toString().padStart(7, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

/**
 * Parse a currency string with optional symbol to decimal amount.
 * Supports formats like "$10.50", "50 XLM", "100.00 USDC", and "42.5".
 *
 * @param input - Currency string with optional symbol or asset code
 * @param defaultAsset - Default asset name if none specified in input (e.g., "XLM" or "USDC")
 * @returns Parsed decimal amount as a string
 * @throws {InvalidAmountError} If input cannot be parsed
 *
 * @example
 * ```typescript
 * parseCurrencyAmount("$10.50")        // "10.50"
 * parseCurrencyAmount("100 XLM")       // "100"
 * parseCurrencyAmount("50.5 USDC")     // "50.5"
 * parseCurrencyAmount("42.5", "XLM")   // "42.5"
 * ```
 */
export function parseCurrencyAmount(input: string, defaultAsset?: string): string {
  if (typeof input !== 'string') {
    throw new InvalidAmountError(`Input must be a string: ${input}`);
  }

  const trimmed = input.trim();
  if (!trimmed) {
    throw new InvalidAmountError('Currency amount cannot be empty');
  }

  // Remove common currency symbols
  const withoutSymbol = trimmed.replace(/^[$€£¥₹₽₩₪₦]/, '').trim();

  // Extract numeric part and optional asset code
  const match = withoutSymbol.match(/^([\d.]+)\s*(XLM|USDC)?$/i);
  if (!match) {
    throw new InvalidAmountError(`Unable to parse currency amount: ${input}`);
  }

  const amountStr = match[1];
  const assetCode = match[2];

  // Validate numeric format
  if (!/^\d+(\.\d+)?$/.test(amountStr)) {
    throw new InvalidAmountError(`Invalid numeric format: ${amountStr}`);
  }

  // Check for negative
  if (amountStr === '0' || amountStr.startsWith('-')) {
    throw new InvalidAmountError(`Amount must be positive: ${amountStr}`);
  }

  return amountStr;
}
const HORIZON_TIMEOUT_MS = 15000;

function getHorizonUrl(networkPassphrase?: string): string {
  return networkPassphrase === Networks.TESTNET
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org';
}

function getServer(networkPassphrase?: string): Horizon.Server {
  return new Horizon.Server(getHorizonUrl(networkPassphrase));
}

function withTimeout<T>(promise: Promise<T>, ms = HORIZON_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Horizon request timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export interface EstimateXlmOptions {
  /** Slippage buffer percentage (e.g., 0.01 for 1%). Defaults to 0.01 (1%). */
  slippage?: number;
  /** Stellar network passphrase (defaults to Networks.PUBLIC). */
  networkPassphrase?: string;
  /** Custom Horizon REST URL override. */
  horizonUrl?: string;
  /** Quote validity window in milliseconds. Defaults to 60000 (60s). */
  quoteTtlMs?: number;
  /** Custom USDC issuer address */
  usdcIssuer?: string;
  /** Optional custom price quote fetcher or fallback function */
  fetchPriceQuote?: () => Promise<number>;
}

export interface XlmEstimateResult {
  /** Required XLM amount as a decimal string formatted to 7 decimal places */
  xlmAmount: string;
  /** Required XLM stroops (1 XLM = 10^7 stroops) as a numeric string */
  stroops: string;
  /** Effective exchange rate (XLM per 1 USDC) */
  effectiveRate: number;
  /** Quote expiration ISO-8601 timestamp */
  expiresAt: string;
  /** Slippage buffer applied (e.g. 0.01 for 1%) */
  slippageApplied: number;
}

/**
 * Estimate the required XLM stroops and effective exchange rate to pay for a given
 * USDC amount before submitting order payment.
 *
 * Queries the Stellar Horizon DEX orderbook for the USDC/XLM pair and applies a
 * configurable slippage buffer (default 1%). Falls back to a custom quote fetcher
 * or returns an informative error on network disconnects.
 *
 * @param usdcAmount - Amount of USDC required for the order
 * @param opts - Options including slippage buffer, network passphrase, and quote fallback
 * @returns Estimated XLM stroops, effective exchange rate, and quote expiration timestamp
 * @throws {Error} If usdcAmount is invalid or both orderbook and fallback quote fail
 */
export async function estimateXlmRequired(
  usdcAmount: string | number,
  opts: EstimateXlmOptions = {},
): Promise<XlmEstimateResult> {
  const numUsdc = typeof usdcAmount === 'string' ? parseFloat(usdcAmount) : Number(usdcAmount);
  if (isNaN(numUsdc) || numUsdc <= 0) {
    throw new Error(
      `Invalid USDC amount for estimation: ${usdcAmount}. Must be a positive number.`,
    );
  }

  const slippage = opts.slippage ?? 0.01;
  const issuer = opts.usdcIssuer ?? USDC_ISSUER;
  const usdcAsset = new Asset('USDC', issuer);
  const xlmAsset = Asset.native();

  let effectiveRate: number | undefined;
  let orderbookError: unknown;

  try {
    const server = opts.horizonUrl
      ? new Horizon.Server(opts.horizonUrl)
      : getServer(opts.networkPassphrase);
    const book = await withTimeout(server.orderbook(usdcAsset, xlmAsset).call());
    if (book.asks && book.asks.length > 0) {
      effectiveRate = parseFloat(book.asks[0].price);
    } else if (book.bids && book.bids.length > 0) {
      effectiveRate = parseFloat(book.bids[0].price);
    }
  } catch (err) {
    orderbookError = err;
  }

  if (effectiveRate === undefined || isNaN(effectiveRate) || effectiveRate <= 0) {
    if (opts.fetchPriceQuote) {
      try {
        effectiveRate = await opts.fetchPriceQuote();
      } catch (fallbackErr) {
        throw new Error(
          `Failed to estimate XLM required: unable to fetch price quote from fallback source: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
        );
      }
    }
  }

  if (effectiveRate === undefined || isNaN(effectiveRate) || effectiveRate <= 0) {
    const reason = orderbookError instanceof Error ? `: ${orderbookError.message}` : '';
    throw new Error(
      `Failed to estimate XLM required: unable to fetch USDC/XLM price quote from Horizon orderbook${reason}. Fallback price source unavailable.`,
    );
  }

  const rateWithSlippage = effectiveRate * (1 + slippage);
  const totalXlm = numUsdc * rateWithSlippage;
  const xlmAmount = totalXlm.toFixed(7);
  const stroops = decimalToStroops(xlmAmount).toString();
  const ttl = opts.quoteTtlMs ?? 60000;
  const expiresAt = new Date(Date.now() + ttl).toISOString();

  return {
    xlmAmount,
    stroops,
    effectiveRate,
    expiresAt,
    slippageApplied: slippage,
  };
}

export interface WalletInfo {
  publicKey: string;
  secret: string; // Keep safe — never share
}

/**
 * Create a new random Stellar wallet keypair.
 *
 * @returns An object containing the public key (G-address) and secret key (S-address)
 * @warning The secret key should be kept secure and never shared or logged
 *
 * @example
 * ```typescript
 * const wallet = createWallet();
 * console.log('Public key:', wallet.publicKey); // G...
 * // Store wallet.secret securely - never log or transmit it
 * ```
 */
export function createWallet(): WalletInfo {
  const keypair = Keypair.random();
  return { publicKey: keypair.publicKey(), secret: keypair.secret() };
}

/**
 * Get XLM and USDC balances for a Stellar account.
 *
 * @param publicKey - The Stellar public key (G-address) to query
 * @param networkPassphrase - Optional network passphrase (defaults to mainnet)
 * @returns Promise resolving to balance object with xlm and usdc as decimal strings
 * @throws {Error} When the account is not found or Horizon request fails
 *
 * @example
 * ```typescript
 * const balance = await getBalance('GXXXXXXX...', Networks.TESTNET);
 * console.log(`Available: ${balance.xlm} XLM, ${balance.usdc} USDC`);
 * ```
 */
/**
 * Get XLM and USDC balances for a Stellar account.
 *
 * @param publicKey - The Stellar public key (G-address) to query
 * @param networkPassphrase - Optional network passphrase (defaults to mainnet)
 * @returns Promise resolving to balance object with xlm and usdc as decimal strings
 * @throws {Error} When the account is not found or Horizon request fails
 *
 * @example
 * ```typescript
 * const balance = await getBalance('GXXXXXXX...', Networks.TESTNET);
 * console.log(`Available: ${balance.xlm} XLM, ${balance.usdc} USDC`);
 * ```
 */
export async function getBalance(
  publicKey: string,
  networkPassphrase?: string,
): Promise<{ xlm: string; usdc: string }> {
  const server = getServer(networkPassphrase);
  const account = await withTimeout(server.loadAccount(publicKey));
  let xlm = '0',
    usdc = '0';
  for (const b of account.balances) {
    if (b.asset_type === 'native') xlm = b.balance;
    if (
      b.asset_type === 'credit_alphanum4' &&
      b.asset_code === 'USDC' &&
      b.asset_issuer === USDC_ISSUER
    )
      usdc = b.balance;
  }
  return { xlm, usdc };
}

/** One balance line from a Stellar account. */
export interface AssetBalance {
  /** `"XLM"` for the native asset, otherwise the asset code. */
  code: string;
  /** Issuer G-address; `null` for native XLM. */
  issuer: string | null;
  /** Horizon asset type, e.g. `native`, `credit_alphanum4`. */
  assetType: string;
  /** Decimal balance string. */
  balance: string;
}

/** Result of {@link getAccountBalances}. */
export interface AccountBalances {
  xlm: string;
  usdc: string;
  balances: AssetBalance[];
  /** `false` when the account does not exist on-chain yet. */
  funded: boolean;
}

/** Account and optional memo returned by a SEP-0002 federation lookup. */
export interface FederationAddressResolution {
  accountId: string;
  memo?: string;
  memoType?: 'id' | 'text' | 'hash' | 'return';
}

/** Check whether a string is a valid Stellar account or Soroban contract address. */
export function isValidStellarAddress(address: string): boolean {
  return (
    typeof address === 'string' &&
    (StrKey.isValidEd25519PublicKey(address) || StrKey.isValidContract(address))
  );
}

/**
 * Resolve a SEP-0002 federation address such as `alice*stellarcard.com`.
 *
 * @throws {Error} If the address is malformed, lookup fails, or the federation
 * response does not contain a matching valid account and memo.
 */
export async function resolveFederationAddress(
  fedAddress: string,
): Promise<FederationAddressResolution> {
  const match = /^([^*\s]+)\*([A-Za-z0-9.-]+)$/.exec(fedAddress);
  if (
    !match ||
    match[2].split('.').some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))
  ) {
    throw new Error(`Invalid federation address: ${fedAddress}`);
  }

  const url = `https://${match[2]}/federation?type=name&q=${encodeURIComponent(fedAddress)}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Federation lookup failed with HTTP ${response.status}`);
  }

  const result: unknown = await response.json();
  if (typeof result !== 'object' || result === null) {
    throw new Error('Invalid federation response');
  }

  const body = result as Record<string, unknown>;
  if (
    body.stellar_address !== fedAddress ||
    typeof body.account_id !== 'string' ||
    !StrKey.isValidEd25519PublicKey(body.account_id)
  ) {
    throw new Error('Federation response contains an invalid address or account ID');
  }

  const resolution: FederationAddressResolution = { accountId: body.account_id };
  if (body.memo !== undefined || body.memo_type !== undefined) {
    const validMemoTypes = ['id', 'text', 'hash', 'return'];
    if (
      typeof body.memo !== 'string' ||
      typeof body.memo_type !== 'string' ||
      !validMemoTypes.includes(body.memo_type)
    ) {
      throw new Error('Federation response contains invalid memo details');
    }
    resolution.memo = body.memo;
    resolution.memoType = body.memo_type as FederationAddressResolution['memoType'];
  }

  return resolution;
}

/** How long balance lookups are cached, in ms. */
export const BALANCE_CACHE_TTL_MS = 3000;
const balanceCache = new Map<string, { expires: number; value: Promise<AccountBalances> }>();

/** Clear the {@link getAccountBalances} cache (mainly for tests). */
export function clearBalanceCache(): void {
  balanceCache.clear();
}

function isNotFound(err: unknown): boolean {
  const e = err as { response?: { status?: number }; name?: string };
  return e?.response?.status === 404 || e?.name === 'NotFoundError';
}

/**
 * Fetch XLM, USDC and every trustline balance in one Horizon call.
 *
 * Unfunded accounts (Horizon 404) resolve to zero balances instead of
 * throwing. Results are cached per network + account for
 * {@link BALANCE_CACHE_TTL_MS} so tight polling loops don't spam Horizon.
 *
 * @param publicKey - Stellar G-address to inspect
 * @param networkPassphrase - Optional network passphrase (defaults to mainnet)
 */
export function getAccountBalances(
  publicKey: string,
  networkPassphrase?: string,
): Promise<AccountBalances> {
  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    return Promise.reject(new Error(`Invalid Stellar public key: ${publicKey}`));
  }
  const key = `${getHorizonUrl(networkPassphrase)}|${publicKey}`;
  const now = Date.now();
  const cached = balanceCache.get(key);
  if (cached && cached.expires > now) return cached.value;

  const value = (async (): Promise<AccountBalances> => {
    try {
      const account = await withTimeout(getServer(networkPassphrase).loadAccount(publicKey));
      const balances: AssetBalance[] = account.balances.map((b) => {
        const line = b as {
          asset_type: string;
          balance: string;
          asset_code?: string;
          asset_issuer?: string;
        };
        return line.asset_type === 'native'
          ? { code: 'XLM', issuer: null, assetType: 'native', balance: line.balance }
          : {
              code: line.asset_code ?? line.asset_type,
              issuer: line.asset_issuer ?? null,
              assetType: line.asset_type,
              balance: line.balance,
            };
      });
      const xlm = balances.find((b) => b.assetType === 'native')?.balance ?? '0';
      const usdc =
        balances.find((b) => b.code === 'USDC' && b.issuer === USDC_ISSUER)?.balance ?? '0';
      return { xlm, usdc, balances, funded: true };
    } catch (err) {
      if (isNotFound(err)) return { xlm: '0', usdc: '0', balances: [], funded: false };
      balanceCache.delete(key); // never cache failures
      throw err;
    }
  })();
  balanceCache.set(key, { expires: now + BALANCE_CACHE_TTL_MS, value });
  return value;
}

/**
 * Add a USDC trustline to a Stellar account.
 *
 * This allows the account to hold USDC tokens from the recognized issuer.
 * The operation costs ~0.00001 XLM in network fees.
 *
 * @param secret - The Stellar secret key (S-address) for the account
 * @param networkPassphrase - The Stellar network to operate on (defaults to mainnet)
 * @returns Promise resolving to the transaction hash
 * @throws {Error} When the account is not found, has insufficient XLM, or the transaction fails
 *
 * @example
 * ```typescript
 * const txHash = await addUsdcTrustline('SXXXXXXX...', Networks.TESTNET);
 * console.log('Trustline added in transaction:', txHash);
 * ```
 */
export async function addUsdcTrustline(
  secret: string,
  networkPassphrase = Networks.PUBLIC,
): Promise<string> {
  const server = getServer(networkPassphrase);
  const keypair = Keypair.fromSecret(secret);
  const account = await withTimeout(server.loadAccount(keypair.publicKey()));
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(Operation.changeTrust({ asset: new Asset('USDC', USDC_ISSUER) }))
    .setTimeout(300)
    .build();
  tx.sign(keypair);
  const result = await server.submitTransaction(tx);
  return result.hash;
}

// ── Contract payment ──────────────────────────────────────────────────────────

/**
 * Options for {@link payViaContract}.
 */
export interface PayOpts {
  /** Stellar secret key (S-address) for the signing account. */
  walletSecret: string;
  /** Payment instructions returned by {@link Stellar_CardClient.createOrder}. */
  payment: PaymentInstructions;
  /** Asset to pay with. Defaults to `'usdc'`. */
  paymentAsset?: 'usdc' | 'xlm';
  /** Stellar network passphrase. Defaults to `Networks.PUBLIC` (mainnet). */
  networkPassphrase?: string;
  /** Custom Soroban RPC URL. Defaults to the public endpoint for the selected network. */
  sorobanRpcUrl?: string;
  /** Fallback Soroban RPC URL used when the primary endpoint fails. */
  fallbackRpcUrl?: string;
  /** Override the Horizon REST API URL. Defaults to the public endpoint for the selected network. */
  horizonUrl?: string;
  /** Optional logger instance */
  logger?: Logger;
  /**
   * Per-call base fee override, in stroops per operation (#732). Takes
   * precedence over the client-level default set via
   * {@link setDefaultBaseFee} for this one call. Must be a positive
   * integer no greater than {@link MAX_BASE_FEE_STROOPS} (100,000
   * stroops) — larger values throw {@link ValidationError} before any
   * network call is made. Defaults to {@link DEFAULT_BASE_FEE_STROOPS}
   * (100 stroops) when neither this nor a client-level default is set.
   */
  baseFee?: number;
}

/**
 * Pay the stellar_card receiver contract using a raw Stellar secret key.
 *
 * Invokes `pay_usdc` or `pay_xlm` on the Soroban receiver contract with the
 * agent's G-address, the quoted amount converted to 7-decimal stroops, and
 * the `order_id` from the create-order response. Includes a single automatic
 * fee-bump retry when the network rejects the initial fee.
 *
 * @param opts - Payment options including the wallet secret, payment instructions,
 *   and optional network / RPC overrides.
 * @returns Promise resolving to a {@link ContractPaymentResult} with the
 *   transaction hash and Soroban fee refund metrics (`feeCharged`, `feeRefunded`, `maxFee`).
 * @throws {Error} When `payment.contract_id` is not a valid Soroban contract address.
 * @throws {InsufficientFeeError} When the fee is still insufficient after the retry.
 * @throws {Error} When the Soroban transaction fails on-chain or times out.
 *
 * @example
 * ```typescript
 * const result = await payViaContract({
 *   walletSecret: process.env.STELLAR_SECRET!,
 *   payment: order.payment,
 *   paymentAsset: 'usdc',
 * });
 * console.log(result.hash, result.feeRefunded);
 * ```
 */
export async function payViaContract(opts: PayOpts): Promise<ContractPaymentResult> {
  const {
    walletSecret,
    payment,
    paymentAsset = 'usdc',
    networkPassphrase = Networks.PUBLIC,
    sorobanRpcUrl,
    fallbackRpcUrl,
    horizonUrl,
    logger,
    baseFee,
  } = opts;

  if (!StrKey.isValidContract(payment.contract_id)) {
    throw new Error(`Invalid contract_id in order response: ${payment.contract_id}`);
  }

  // Validate the per-call override up front — before any network call —
  // so a bad baseFee fails fast with a clear error instead of surfacing
  // as a confusing Soroban rejection later.
  if (baseFee !== undefined) {
    validateBaseFee(baseFee);
  }

  const keypair = Keypair.fromSecret(walletSecret);
  const { fn, amountDecimal } = selectContractCall(payment, paymentAsset);
  const amountStroops = decimalToStroops(amountDecimal);
  const resolvedHorizonUrl = horizonUrl ?? getHorizonUrl(networkPassphrase);

  logger?.info?.(
    `Submitting Soroban contract payment for order ${payment.order_id} (${fn}: ${amountDecimal} ${paymentAsset.toUpperCase()})`,
    { orderId: payment.order_id, contractId: payment.contract_id, fn, amountDecimal },
  );

  // RPC failover: try the primary endpoint first, then the fallback when it
  // is configured. Each endpoint gets its own fee-retry pass. When neither
  // custom URL is given, a single `undefined` entry is used so
  // `buildContractPaymentTx` resolves the network default.
  const rpcEndpoints =
    sorobanRpcUrl || fallbackRpcUrl
      ? [sorobanRpcUrl, fallbackRpcUrl].filter((url): url is string => Boolean(url))
      : [undefined];
  let lastError: unknown;
  for (const rpcUrl of rpcEndpoints) {
    let fee: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { tx, server } = await buildContractPaymentTx({
        contractId: payment.contract_id,
        fn,
        fromPublicKey: keypair.publicKey(),
        amountStroops,
        orderId: payment.order_id,
        networkPassphrase,
        rpcUrl,
        fee,
        baseFee,
      });
      tx.sign(keypair);
      try {
        logger?.debug?.(`Submitting Soroban transaction (attempt ${attempt + 1}) to RPC`);
        const result = await submitSorobanTx(tx, server, resolvedHorizonUrl, logger);
        logger?.info?.(`Soroban transaction submitted successfully: ${result.hash}`);
        return {
          hash: result.hash,
          feeCharged: result.feeCharged ?? result.maxFee ?? tx.fee,
          feeRefunded: result.feeRefunded ?? '0',
          maxFee: result.maxFee ?? tx.fee,
        };
      } catch (err) {
        if (err instanceof InsufficientFeeError && attempt === 0) {
          fee = err.requiredFee;
          logger?.info?.(`Soroban transaction fee insufficient, bumping fee to ${fee} and retrying`);
          continue;
        }
        lastError = err;
        logger?.warn?.(`RPC endpoint ${String(rpcUrl) ?? 'default'} failed: ${String(err)}`);
        break;
      }
    }
  }
  throw lastError ?? new Error('payViaContract: all RPC endpoints failed');
}

/**
 * Full purchase flow with a raw Stellar keypair.
 *
 * Orchestrates the complete card acquisition sequence:
 * 1. Creates a new order via the stellar_card API (or resumes an existing one).
 * 2. Pays the Soroban receiver contract using the supplied secret key.
 * 3. Waits for the card to be ready and returns its details.
 *
 * Pass `resume: { orderId, payment }` to re-enter a partially completed flow
 * without creating a new order, avoiding duplicate charges when a previous
 * attempt timed out or lost connectivity after payment was submitted.
 *
 * @param opts.apiKey - stellar_card API key.
 * @param opts.walletSecret - Stellar secret key (S-address) used to sign the payment transaction.
 * @param opts.amountUsdc - Card amount as a decimal string, e.g. `"10.00"`.
 * @param opts.paymentAsset - Asset to pay with (`'usdc'` or `'xlm'`). Defaults to `'usdc'`.
 * @param opts.baseUrl - Override the API base URL.
 * @param opts.networkPassphrase - Stellar network passphrase. Defaults to mainnet.
 * @param opts.sorobanRpcUrl - Custom Soroban RPC endpoint.
 * @param opts.horizonUrl - Custom Horizon REST API endpoint.
 * @param opts.resume - Resume an existing order instead of creating a new one.
 * @param opts.waitForCardOpts - Timeout and polling interval for the card-ready wait.
 * @returns Promise resolving to card details plus the `order_id`.
 * @throws {InvalidAmountError} When `amountUsdc` is outside `[0.01, 10000]`.
 * @throws {SpendLimitError} When the API key's spend limit is exhausted.
 * @throws {OrderFailedError} When the order fails during fulfillment.
 * @throws {WaitTimeoutError} When card delivery times out.
 */
export async function purchaseCard(opts: {
  apiKey: string;
  walletSecret: string;
  amountUsdc: string;
  paymentAsset?: 'usdc' | 'xlm';
  baseUrl?: string;
  networkPassphrase?: string;
  sorobanRpcUrl?: string;
  /** Fallback Soroban RPC URL used when the primary endpoint fails. */
  fallbackRpcUrl?: string;
  /** Override the Horizon REST API URL used during contract submission. */
  horizonUrl?: string;
  resume?: { orderId: string; payment: PaymentInstructions };
  waitForCardOpts?: { timeoutMs?: number; intervalMs?: number };
}): Promise<CardDetails & { order_id: string }> {
  const { Stellar_CardClient } = await import('./client');
  const client = new Stellar_CardClient({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  const paymentAsset = opts.paymentAsset ?? 'usdc';

  let orderId: string;
  let payment: PaymentInstructions;

  if (opts.resume) {
    orderId = opts.resume.orderId;
    payment = opts.resume.payment;
    const status = await client.getOrder(orderId);
    if (status.phase !== 'awaiting_payment') {
      const card = await client.waitForCard(orderId, opts.waitForCardOpts);
      return { ...card, order_id: orderId };
    }
  } else {
    const order = await client.createOrder({ amount_usdc: opts.amountUsdc });
    orderId = order.order_id;
    payment = order.payment;
  }

  await payViaContract({
    walletSecret: opts.walletSecret,
    payment,
    paymentAsset,
    networkPassphrase: opts.networkPassphrase,
    sorobanRpcUrl: opts.sorobanRpcUrl,
    fallbackRpcUrl: opts.fallbackRpcUrl,
    horizonUrl: opts.horizonUrl,
  });

  const card = await client.waitForCard(orderId, opts.waitForCardOpts);
  return { ...card, order_id: orderId };
}

/**
 * Sign an arbitrary message with a Stellar secret key using Ed25519.
 *
 * The message is prefixed with the standard separator (`stellar:message:`)
 * to prevent confusion with Stellar transactions. Returns a base64-encoded signature.
 *
 * @param message - The message to sign (string or binary)
 * @param secretKey - The Stellar secret key (S-address)
 * @returns Base64-encoded signature
 * @throws {Error} If the secret key is invalid
 *
 * @example
 * ```typescript
 * const signature = signMessage('hello world', 'SXXXXXXX...');
 * console.log('Signature:', signature); // base64-encoded string
 * ```
 */
export function signMessage(message: string | Uint8Array, secretKey: string): string {
  const keypair = Keypair.fromSecret(secretKey);
  const prefix = 'stellar:message:';
  const messageBuffer =
    typeof message === 'string' ? Buffer.from(message, 'utf-8') : Buffer.from(message);
  const prefixedMessage = Buffer.concat([Buffer.from(prefix, 'utf-8'), messageBuffer]);
  const signature = keypair.sign(prefixedMessage);
  return signature.toString('base64');
}

/**
 * Verify a message signature against a Stellar public key using Ed25519.
 *
 * The message is prefixed with the standard separator (`stellar:message:`)
 * to match the signing process. Returns true if the signature is valid, false otherwise.
 *
 * @param message - The original message that was signed (string or binary)
 * @param signature - The base64-encoded signature to verify
 * @param publicKey - The Stellar public key (G-address)
 * @returns true if the signature is valid, false otherwise
 * @throws {Error} If the public key is invalid or signature is not valid base64
 *
 * @example
 * ```typescript
 * const isValid = verifyMessage('hello world', 'Aqd8...', 'GXXXXXXX...');
 * if (isValid) console.log('Signature is valid');
 * ```
 */
export function verifyMessage(
  message: string | Uint8Array,
  signature: string,
  publicKey: string,
): boolean {
  try {
    const keypair = Keypair.fromPublicKey(publicKey);
    const prefix = 'stellar:message:';
    const messageBuffer =
      typeof message === 'string' ? Buffer.from(message, 'utf-8') : Buffer.from(message);
    const prefixedMessage = Buffer.concat([Buffer.from(prefix, 'utf-8'), messageBuffer]);
    const sigBuffer = Buffer.from(signature, 'base64');
    return keypair.verify(prefixedMessage, sigBuffer);
  } catch {
    return false;
  }
}

// ── Offline transaction signing for cold storage wallets ──────────────────────

export interface UnsignedTransactionEnvelope {
  /** XDR transaction envelope (unsigned). */
  xdr: string;
  /** Network passphrase for this transaction. */
  networkPassphrase: string;
  /** Fee allocated to the transaction (stroops). */
  fee: string;
  /** Sequence number of the signing account. */
  sequence: string;
}

/**
 * Build an unsigned Soroban transaction envelope for offline signing by a cold storage wallet.
 *
 * Returns a {@link UnsignedTransactionEnvelope} containing the XDR serialization,
 * network context, and metadata needed to sign offline. The envelope can be exported,
 * signed with a hardware wallet or air-gapped signing tool, and then resubmitted
 * using {@link submitSignedTransaction}.
 *
 * @param opts - Transaction build options (same as {@link buildContractPaymentTx})
 * @returns An unsigned transaction envelope ready for offline signing
 * @throws {Error} If Soroban RPC simulation fails
 *
 * @example
 * ```typescript
 * // Build envelope on an online computer
 * const envelope = await buildUnsignedTransactionEnvelope({
 *   contractId: 'CXXXX...',
 *   fn: 'pay_usdc',
 *   fromPublicKey: coldStoragePublicKey,
 *   amountStroops: decimalToStroops('10.00'),
 *   orderId: 'ord_abc123',
 *   networkPassphrase: Networks.TESTNET,
 * });
 *
 * // Export and sign offline...
 * // const signedXdr = signWithHardwareWallet(envelope.xdr);
 *
 * // Submit signed transaction from any online computer
 * // const result = await submitSignedTransaction(signedXdr, envelope.networkPassphrase);
 * ```
 */
export async function buildUnsignedTransactionEnvelope(
  opts: Omit<Parameters<typeof buildContractPaymentTx>[0], 'fee'> & {
    fee?: string;
  },
): Promise<UnsignedTransactionEnvelope> {
  const { tx } = await buildContractPaymentTx(opts as Parameters<typeof buildContractPaymentTx>[0]);
  return {
    xdr: tx.toXDR(),
    networkPassphrase: opts.networkPassphrase,
    fee: String(tx.fee ?? BASE_FEE),
    sequence: tx.sequence,
  };
}

/**
 * Submit a previously signed transaction that was built offline.
 *
 * Takes a signed transaction XDR (from offline signing) and submits it to the
 * Soroban RPC endpoint. Polls until the transaction reaches a terminal status
 * and returns the result with fee refund metrics.
 *
 * @param signedXdr - The signed transaction XDR string from offline signing
 * @param networkPassphrase - Network this transaction was built for
 * @param sorobanRpcUrl - Optional Soroban RPC URL override
 * @param horizonUrl - Optional Horizon URL override for fallback confirmation
 * @returns Transaction result with hash and fee metrics
 * @throws {Error} If the transaction fails on-chain or parsing fails
 *
 * @example
 * ```typescript
 * const result = await submitSignedTransaction(
 *   signedXdr,
 *   Networks.TESTNET,
 *   undefined, // use default Soroban RPC for TESTNET
 *   'https://horizon-testnet.stellar.org'
 * );
 * console.log('Submitted:', result.hash);
 * ```
 */
export async function submitSignedTransaction(
  signedXdr: string,
  networkPassphrase: string,
  sorobanRpcUrl?: string,
  horizonUrl?: string,
): Promise<ContractPaymentResult> {
  const { submitSorobanTx, getSorobanRpcUrl, getHorizonUrl } = await import('./soroban');
  const { rpc } = await import('@stellar/stellar-sdk');

  const resolvedRpcUrl = sorobanRpcUrl ?? getSorobanRpcUrl(networkPassphrase);
  const resolvedHorizonUrl = horizonUrl ?? getHorizonUrl(networkPassphrase);
  const server = new rpc.Server(resolvedRpcUrl);
  const tx = rpc.Api.Transaction.fromXDR(signedXdr, networkPassphrase) as any;

  const result = await submitSorobanTx(tx, server, resolvedHorizonUrl);
  return {
    hash: result.hash,
    feeCharged: result.feeCharged ?? result.maxFee ?? String(tx.fee ?? BASE_FEE),
    feeRefunded: result.feeRefunded ?? '0',
    maxFee: result.maxFee ?? String(tx.fee ?? BASE_FEE),
  };
}

// ── Transaction memo builder (#739) ──────────────────────────────────────────

/** Supported {@link buildTransactionMemo} memo types. */
export type MemoType = 'text' | 'id' | 'hash' | 'return';

/** Maximum byte length of a Stellar `MEMO_TEXT` value, per the protocol. */
export const MEMO_TEXT_MAX_BYTES = 28;

/** Byte length required for `MEMO_HASH` / `MEMO_RETURN` values. */
export const MEMO_HASH_BYTES = 32;

/** Inclusive range for a `MEMO_ID` value (an unsigned 64-bit integer). */
export const MEMO_ID_MAX = 18446744073709551615n;

/**
 * Build a type-safe Stellar transaction {@link Memo} from a `memoType` and
 * raw `value`, validating the value against the constraints the Stellar
 * protocol enforces for that memo type before handing it to the SDK's
 * `Memo` factory.
 *
 * - `'text'` — a UTF-8 string, validated against its actual **byte**
 *   length (not character count), since multi-byte characters (emoji,
 *   non-Latin scripts, etc.) count for more than one byte each. Max
 *   {@link MEMO_TEXT_MAX_BYTES} bytes.
 * - `'id'` — an unsigned 64-bit integer, accepted as a `string`, `number`,
 *   or `bigint`. Must be a non-negative integer that fits in a uint64.
 * - `'hash'` / `'return'` — exactly {@link MEMO_HASH_BYTES} raw bytes,
 *   accepted as a `Buffer`, `Uint8Array`, or a 64-character hex string.
 *
 * @param memoType - Which memo variant to build.
 * @param value - The raw value to encode; its accepted shape depends on `memoType` (see above).
 * @returns A Stellar SDK {@link Memo} ready to attach via `TransactionBuilder.addMemo`.
 * @throws {InvalidMemoError} When `value` violates the length/format constraints for `memoType`,
 *   or when `memoType` is not one of `'text' | 'id' | 'hash' | 'return'`.
 *
 * @example
 * ```typescript
 * const memo = buildTransactionMemo('text', 'order-4821');
 * const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
 *   .addMemo(memo)
 *   .addOperation(...)
 *   .setTimeout(300)
 *   .build();
 * ```
 */
export function buildTransactionMemo(
  memoType: MemoType,
  value: string | number | bigint | Buffer | Uint8Array,
): Memo {
  switch (memoType) {
    case 'text': {
      if (typeof value !== 'string') {
        throw new InvalidMemoError(memoType, 'Expected a string value for MEMO_TEXT.');
      }
      const byteLength = Buffer.byteLength(value, 'utf-8');
      if (byteLength > MEMO_TEXT_MAX_BYTES) {
        throw new InvalidMemoError(
          memoType,
          `Text memo exceeds ${MEMO_TEXT_MAX_BYTES} bytes when UTF-8 encoded (got ${byteLength} bytes). ` +
            'Note: multi-byte characters (emoji, non-Latin scripts) count as more than one byte each.',
        );
      }
      return Memo.text(value);
    }
    case 'id': {
      let idStr: string;
      if (typeof value === 'bigint') {
        idStr = value.toString();
      } else if (typeof value === 'number') {
        if (!Number.isInteger(value) || value < 0) {
          throw new InvalidMemoError(memoType, `Expected a non-negative integer, got ${value}.`);
        }
        idStr = value.toString();
      } else if (typeof value === 'string' && /^\d+$/.test(value)) {
        idStr = value;
      } else {
        throw new InvalidMemoError(
          memoType,
          'Expected a non-negative integer as a string, number, or bigint for MEMO_ID.',
        );
      }
      let idBig: bigint;
      try {
        idBig = BigInt(idStr);
      } catch {
        throw new InvalidMemoError(memoType, `"${String(value)}" is not a valid integer.`);
      }
      if (idBig < 0n || idBig > MEMO_ID_MAX) {
        throw new InvalidMemoError(
          memoType,
          `ID memo must fit in an unsigned 64-bit integer (0 to ${MEMO_ID_MAX}), got ${idBig}.`,
        );
      }
      return Memo.id(idBig.toString());
    }
    case 'hash':
    case 'return': {
      const bytes = normalizeMemoHashInput(memoType, value);
      const hex = bytes.toString('hex');
      return memoType === 'hash' ? Memo.hash(hex) : Memo.return(hex);
    }
    default:
      throw new InvalidMemoError(
        String(memoType),
        `Unsupported memo type. Expected 'text', 'id', 'hash', or 'return'.`,
      );
  }
}

/** Coerce a hash/return memo input into exactly {@link MEMO_HASH_BYTES} raw bytes, or throw. */
function normalizeMemoHashInput(
  memoType: 'hash' | 'return',
  value: string | number | bigint | Buffer | Uint8Array,
): Buffer {
  let bytes: Buffer;
  if (Buffer.isBuffer(value)) {
    bytes = value;
  } else if (value instanceof Uint8Array) {
    bytes = Buffer.from(value);
  } else if (typeof value === 'string') {
    if (!/^[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
      throw new InvalidMemoError(
        memoType,
        'Expected a hex-encoded string (even length, hex characters only) for MEMO_HASH/MEMO_RETURN.',
      );
    }
    bytes = Buffer.from(value, 'hex');
  } else {
    throw new InvalidMemoError(
      memoType,
      'Expected a Buffer, Uint8Array, or hex string for MEMO_HASH/MEMO_RETURN.',
    );
  }
  if (bytes.length !== MEMO_HASH_BYTES) {
    throw new InvalidMemoError(
      memoType,
      `Expected exactly ${MEMO_HASH_BYTES} bytes, got ${bytes.length}.`,
    );
  }
  return bytes;
}

// ── Claimable balances (#736) ────────────────────────────────────────────────

/** A timelock predicate for a {@link createClaimableBalance} claimant. */
export interface ClaimPredicate {
  /** Claimant may claim at any time (no predicate). */
  unconditional?: true;
  /** Claimant may claim only before this absolute time. */
  beforeAbsoluteTime?: Date | string | number;
  /** Claimant may claim only after this absolute time (expressed as "not before" via a negated predicate). */
  afterAbsoluteTime?: Date | string | number;
}

/** One claimant + predicate pair for {@link createClaimableBalance}. */
export interface ClaimableBalanceClaimant {
  /** Stellar G-address allowed to claim under `predicate`. */
  destination: string;
  /** When this claimant may claim the balance. Defaults to unconditional. */
  predicate?: ClaimPredicate;
}

/** Options for {@link createClaimableBalance}. */
export interface CreateClaimableBalanceOpts {
  /** Stellar secret key (S-address) of the account funding the balance. */
  sourceSecret: string;
  /** Asset to escrow. Defaults to native XLM. */
  asset?: Asset;
  /** Decimal amount of `asset` to escrow, e.g. `"10.0000000"`. */
  amount: string;
  /** One or more claimants, each with its own predicate. */
  claimants: ClaimableBalanceClaimant[];
  /** Stellar network passphrase. Defaults to `Networks.PUBLIC`. */
  networkPassphrase?: string;
  /** Override the Horizon REST API URL. */
  horizonUrl?: string;
}

function toUnixSeconds(value: Date | string | number): string {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid claim predicate timestamp: ${String(value)}`);
  }
  return Math.floor(ms / 1000).toString();
}

function buildClaimPredicate(predicate?: ClaimPredicate) {
  if (!predicate || predicate.unconditional) {
    return Claimant.predicateUnconditional();
  }
  const predicates = [];
  if (predicate.beforeAbsoluteTime !== undefined) {
    predicates.push(
      Claimant.predicateBeforeAbsoluteTime(toUnixSeconds(predicate.beforeAbsoluteTime)),
    );
  }
  if (predicate.afterAbsoluteTime !== undefined) {
    // Stellar has no native "after" predicate — express it as the negation
    // of "before", so the claimant can only claim once that time has passed.
    predicates.push(
      Claimant.predicateNot(
        Claimant.predicateBeforeAbsoluteTime(toUnixSeconds(predicate.afterAbsoluteTime)),
      ),
    );
  }
  if (predicates.length === 0) {
    return Claimant.predicateUnconditional();
  }
  if (predicates.length === 1) {
    const [only] = predicates;
    if (!only) {
      return Claimant.predicateUnconditional();
    }
    return only;
  }
  const [first, second] = predicates;
  if (!first || !second) {
    // Unreachable given the length check above, but keeps this type-safe.
    return Claimant.predicateUnconditional();
  }
  return Claimant.predicateAnd(first, second);
}

/**
 * Escrow an amount of an asset on-chain via a `CreateClaimableBalance`
 * operation, releasable by one or more claimants under optional
 * before/after timelock predicates.
 *
 * @param opts - Source account, asset/amount, and the list of claimants with their predicates.
 * @returns Promise resolving to the submitted transaction hash.
 * @throws {Error} When the source secret is invalid or the transaction is rejected by Horizon.
 *
 * @example
 * ```typescript
 * const hash = await createClaimableBalance({
 *   sourceSecret: process.env.STELLAR_SECRET!,
 *   amount: '10.0000000',
 *   claimants: [
 *     { destination: 'GRECEIVER...', predicate: { beforeAbsoluteTime: '2027-01-01T00:00:00Z' } },
 *   ],
 * });
 * ```
 */
export async function createClaimableBalance(opts: CreateClaimableBalanceOpts): Promise<string> {
  const {
    sourceSecret,
    asset = Asset.native(),
    amount,
    claimants,
    networkPassphrase = Networks.PUBLIC,
    horizonUrl,
  } = opts;

  if (!claimants || claimants.length === 0) {
    throw new Error('createClaimableBalance requires at least one claimant.');
  }

  const keypair = Keypair.fromSecret(sourceSecret);
  const server = horizonUrl ? new Horizon.Server(horizonUrl) : getServer(networkPassphrase);
  const account = await withTimeout(server.loadAccount(keypair.publicKey()));

  const sdkClaimants = claimants.map(
    (c) => new Claimant(c.destination, buildClaimPredicate(c.predicate)),
  );

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(
      Operation.createClaimableBalance({
        asset,
        amount,
        claimants: sdkClaimants,
      }),
    )
    .setTimeout(300)
    .build();
  tx.sign(keypair);
  const result = await withTimeout(server.submitTransaction(tx));
  return result.hash;
}

/**
 * Claim a previously created claimable balance.
 *
 * @param balanceId - The claimable balance ID (as returned by Horizon or
 *   {@link createClaimableBalance}'s transaction result).
 * @param claimantKeypair - Keypair (or secret key string) of the claimant account.
 * @param opts - Optional network passphrase / Horizon URL overrides.
 * @returns Promise resolving to the submitted transaction hash.
 * @throws {Error} When the balance has already been claimed, the predicate
 *   has not yet been satisfied, or Horizon rejects the transaction.
 *
 * @example
 * ```typescript
 * const hash = await claimBalance(balanceId, claimantSecret);
 * ```
 */
export async function claimBalance(
  balanceId: string,
  claimantKeypair: Keypair | string,
  opts: { networkPassphrase?: string; horizonUrl?: string } = {},
): Promise<string> {
  const keypair =
    typeof claimantKeypair === 'string' ? Keypair.fromSecret(claimantKeypair) : claimantKeypair;
  const networkPassphrase = opts.networkPassphrase ?? Networks.PUBLIC;
  const server = opts.horizonUrl
    ? new Horizon.Server(opts.horizonUrl)
    : getServer(networkPassphrase);
  const account = await withTimeout(server.loadAccount(keypair.publicKey()));

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(Operation.claimClaimableBalance({ balanceId }))
    .setTimeout(300)
    .build();
  tx.sign(keypair);
  const result = await withTimeout(server.submitTransaction(tx));
  return result.hash;
}

/** One claimable balance entry as returned by {@link getClaimableBalances}. */
export interface ClaimableBalanceEntry {
  /** The claimable balance ID, used with {@link claimBalance}. */
  id: string;
  /** Asset held in escrow, e.g. `"native"` or `"USDC:GISSUER..."`. */
  asset: string;
  /** Decimal amount held in escrow. */
  amount: string;
  /** The account that funded (created) the balance. */
  sponsor?: string;
  /** Claimants and their raw predicate XDR, as returned by Horizon. */
  claimants: Array<{ destination: string; predicate: unknown }>;
  /** Ledger sequence at which the balance was last modified. */
  lastModifiedLedger: number;
}

/**
 * Query every claimable balance a given account is a claimant on, from Horizon.
 *
 * @param publicKey - Stellar G-address of the claimant to query for.
 * @param opts - Optional network passphrase / Horizon URL overrides, and a result `limit`.
 * @returns Promise resolving to the list of claimable balance entries.
 * @throws {Error} When the Horizon request fails.
 *
 * @example
 * ```typescript
 * const balances = await getClaimableBalances('GCLAIMANT...');
 * for (const b of balances) console.log(b.id, b.amount, b.asset);
 * ```
 */
export async function getClaimableBalances(
  publicKey: string,
  opts: { networkPassphrase?: string; horizonUrl?: string; limit?: number } = {},
): Promise<ClaimableBalanceEntry[]> {
  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    throw new Error(`Invalid Stellar public key: ${publicKey}`);
  }
  const networkPassphrase = opts.networkPassphrase ?? Networks.PUBLIC;
  const server = opts.horizonUrl
    ? new Horizon.Server(opts.horizonUrl)
    : getServer(networkPassphrase);

  const page = await withTimeout(
    server
      .claimableBalances()
      .claimant(publicKey)
      .limit(opts.limit ?? 50)
      .call(),
  );

  return page.records.map((record) => {
    const r = record as unknown as {
      id: string;
      asset: string;
      amount: string;
      sponsor?: string;
      claimants: Array<{ destination: string; predicate: unknown }>;
      last_modified_ledger: number;
    };
    return {
      id: r.id,
      asset: r.asset,
      amount: r.amount,
      sponsor: r.sponsor,
      claimants: r.claimants,
      lastModifiedLedger: r.last_modified_ledger,
    };
  });
}

// ── SEP-0007 deep-link helpers (#772) ────────────────────────────────────────
// Re-exported here so consumers can `import { buildSep7PayUri } from 'stellar_card'`
// without reaching into the utils/ path.
export {
  buildSep7PayUri,
  buildSep7TxUri,
  parseSep7Uri,
  type Sep7PayParams,
  type Sep7TxParams,
  type Sep7ParsedUri,
} from './utils/sep7';

// Back-compat aliases — the pre-V3 SDK exposed these names. Keep them around
// as deprecated exports so existing imports don't break on upgrade.

/** @deprecated Use `payViaContract` — this is the Soroban contract call, not a direct Stellar payment. */
export const payVCC = payViaContract;
