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
} from '@stellar/stellar-sdk';
import type { CardDetails, PaymentInstructions } from './client';
import {
  buildContractPaymentTx,
  submitSorobanTx,
  decimalToStroops,
  selectContractCall,
  InsufficientFeeError,
} from './soroban';
import type { ContractPaymentResult } from './types';
import type { Logger } from './logger';

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
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
    throw new Error(`Invalid USDC amount for estimation: ${usdcAmount}. Must be a positive number.`);
  }

  const slippage = opts.slippage ?? 0.01;
  const issuer = opts.usdcIssuer ?? USDC_ISSUER;
  const usdcAsset = new Asset('USDC', issuer);
  const xlmAsset = Asset.native();

  let effectiveRate: number | undefined;
  let orderbookError: unknown;

  try {
    const server = opts.horizonUrl ? new Horizon.Server(opts.horizonUrl) : getServer(opts.networkPassphrase);
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
  /** Override the Horizon REST API URL. Defaults to the public endpoint for the selected network. */
  horizonUrl?: string;
  /** Optional logger instance */
  logger?: Logger;
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
    horizonUrl,
    logger,
  } = opts;

  if (!StrKey.isValidContract(payment.contract_id)) {
    throw new Error(`Invalid contract_id in order response: ${payment.contract_id}`);
  }

  const keypair = Keypair.fromSecret(walletSecret);
  const { fn, amountDecimal } = selectContractCall(payment, paymentAsset);
  const amountStroops = decimalToStroops(amountDecimal);
  const resolvedHorizonUrl = horizonUrl ?? getHorizonUrl(networkPassphrase);

  logger?.info?.(
    `Submitting Soroban contract payment for order ${payment.order_id} (${fn}: ${amountDecimal} ${paymentAsset.toUpperCase()})`,
    { orderId: payment.order_id, contractId: payment.contract_id, fn, amountDecimal },
  );

  // Fee retry: if the network rejects the fee, rebuild with the
  // required fee as the floor. At most one retry — the network's
  // suggested fee should be sufficient on the second attempt.
  let fee: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { tx, server } = await buildContractPaymentTx({
      contractId: payment.contract_id,
      fn,
      fromPublicKey: keypair.publicKey(),
      amountStroops,
      orderId: payment.order_id,
      networkPassphrase,
      rpcUrl: sorobanRpcUrl,
      fee,
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
      logger?.error?.(`Soroban transaction submission failed: ${String(err)}`, { error: err });
      throw err;
    }
  }
  throw new Error('payViaContract: fee retry exhausted');
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
