// Soroban contract payment helpers — shared by raw-keypair (stellar.ts) and
// OWS-wallet (ows.ts) payment paths. The receiver contract's pay_usdc/pay_xlm
// functions take (from: Address, amount: i128, order_id: Bytes) and emit a
// payment event that the stellar_card backend watcher indexes.

import {
  Account,
  Address,
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { ContractExecutionError, ValidationError } from './errors';
import type { Logger } from './logger';
import type { ContractPaymentResult, TransactionResult } from './types';

export type { ContractPaymentResult, TransactionResult };

export { ContractExecutionError };

/**
 * Mapping of Soroban custom contract error codes to descriptive human-readable messages.
 * Matches `stellar_card-contract/src/lib.rs` Error enum.
 */
export const CONTRACT_ERROR_MESSAGES: Record<number, string> = {
  1: 'Invalid amount: amount must be positive',
  2: 'Transfer failed: token transfer operation failed',
  3: 'Contract paused: no new payments accepted until unpaused',
  4: 'Withdraw limit exceeded',
  5: 'Daily withdraw limit exceeded',
  6: 'Invalid recipient',
};

export const CONTRACT_ERROR_MAP = CONTRACT_ERROR_MESSAGES;

/**
 * Attempt to extract a numeric contract error code from an XDR result, simulation response,
 * diagnostic events, or error object/string.
 */
export function extractContractErrorCode(xdrResult: unknown): number | null {
  if (typeof xdrResult === 'number' && Number.isInteger(xdrResult)) {
    return xdrResult;
  }

  if (typeof xdrResult === 'string') {
    // Check if it's a plain numeric string
    if (/^\d+$/.test(xdrResult.trim())) {
      return parseInt(xdrResult.trim(), 10);
    }

    // Match Soroban HostError string patterns, e.g.:
    // Error(Contract, #1) or Error(Contract, 1) or HostError: Error(Contract, #1)
    const hostErrMatch = xdrResult.match(/Error\s*\(\s*Contract\s*,\s*#?(\d+)\s*\)/i);
    if (hostErrMatch && hostErrMatch[1]) {
      return parseInt(hostErrMatch[1], 10);
    }

    // Match patterns like ContractError(1) or contract_error: 1 or error code 1
    const genericCodeMatch = xdrResult.match(
      /(?:contract\s*error|error\s*code|custom\s*error)[^\d]*(\d+)/i,
    );
    if (genericCodeMatch && genericCodeMatch[1]) {
      return parseInt(genericCodeMatch[1], 10);
    }

    // Try decoding base64 XDR as ScVal or DiagnosticEvent
    try {
      const val = xdr.ScVal.fromXDR(xdrResult, 'base64') as any;
      if (val?.arm?.() === 'error') {
        const scErr = val.value?.();
        if (scErr && (scErr.arm?.() === 'contractCode' || scErr.arm?.() === 'sceContract')) {
          return scErr.value?.() ?? null;
        }
      }
    } catch {
      // Not an ScVal base64 string
    }

    try {
      const diag = xdr.DiagnosticEvent.fromXDR(xdrResult, 'base64') as any;
      const body = diag?.event?.()?.body?.();
      if (body) {
        const val = body.value?.() ?? body.data?.();
        if (val) {
          const code = extractContractErrorCode(val);
          if (code !== null) return code;
        }
      }
    } catch {
      // Not a DiagnosticEvent base64 string
    }

    return null;
  }

  if (xdrResult && typeof xdrResult === 'object') {
    if (xdrResult instanceof ContractExecutionError) {
      return xdrResult.contractCode;
    }

    const obj = xdrResult as Record<string, unknown>;

    if (typeof obj.contractCode === 'number') return obj.contractCode;
    if (typeof obj.code === 'number') return obj.code;
    if (typeof obj.errorCode === 'number') return obj.errorCode;

    if (obj.error) {
      const fromErr = extractContractErrorCode(obj.error);
      if (fromErr !== null) return fromErr;
    }

    if (typeof obj.message === 'string') {
      const fromMsg = extractContractErrorCode(obj.message);
      if (fromMsg !== null) return fromMsg;
    }

    const events = (obj.diagnosticEvents ?? obj.events ?? obj.diagnosticEventsXdr) as unknown[];
    if (Array.isArray(events)) {
      for (const event of events) {
        const fromEvent = extractContractErrorCode(event);
        if (fromEvent !== null) return fromEvent;
      }
    }

    if (Array.isArray(obj.results)) {
      for (const res of obj.results) {
        if (res && typeof res === 'object') {
          const fromRes = extractContractErrorCode((res as any).xdr ?? res);
          if (fromRes !== null) return fromRes;
        }
      }
    }

    if (obj.resultXdr) {
      const fromXdr = extractContractErrorCode(obj.resultXdr);
      if (fromXdr !== null) return fromXdr;
    }
    if (obj.errorResult) {
      const fromErrRes = extractContractErrorCode(obj.errorResult);
      if (fromErrRes !== null) return fromErrRes;
    }

    if (typeof (xdrResult as any).arm === 'function') {
      try {
        const scVal = xdrResult as any;
        if (scVal?.arm?.() === 'error') {
          const scErr = scVal.value?.();
          if (scErr && (scErr.arm?.() === 'contractCode' || scErr.arm?.() === 'sceContract')) {
            return scErr.value?.() ?? null;
          }
        }
      } catch {
        // Ignore
      }
    }
  }

  return null;
}

/**
 * Decode Soroban contract error codes into a human-readable ContractExecutionError.
 *
 * Maps numeric error codes (e.g. Error::InvalidAmount = 1, Error::TransferFailed = 2,
 * Error::ContractPaused = 3) to descriptive error messages, and handles unknown custom
 * error codes with a fallback string.
 *
 * @param xdrResult - Error code, error object, diagnostic event, simulation result, or XDR string.
 * @returns ContractExecutionError wrapping the code and explanation.
 */
export function parseContractError(xdrResult: unknown): ContractExecutionError {
  const code = extractContractErrorCode(xdrResult);
  const context = xdrResult instanceof Error ? { cause: xdrResult } : undefined;

  if (code !== null) {
    const explanation = CONTRACT_ERROR_MESSAGES[code] ?? `Unknown custom contract error: ${code}`;
    const wrapped = new ContractExecutionError(code, explanation, xdrResult, context);
    if (Error.captureStackTrace) Error.captureStackTrace(wrapped, parseContractError);
    return wrapped;
  }

  const fallbackExplanation =
    typeof xdrResult === 'string'
      ? `Unknown contract error: ${xdrResult}`
      : 'Unknown contract error';
  const wrapped = new ContractExecutionError(0, fallbackExplanation, xdrResult, context);
  if (Error.captureStackTrace) Error.captureStackTrace(wrapped, parseContractError);
  return wrapped;
}

// ── Custom base fee overrides (#732) ────────────────────────────────────────

/**
 * Default base fee, in stroops per operation, used when no client-level
 * default or per-call override is supplied. Matches Stellar's own
 * `BASE_FEE` constant (100 stroops).
 */
export const DEFAULT_BASE_FEE_STROOPS = 100;

/**
 * Upper bound on a caller-supplied base fee, in stroops. Callers passing
 * a `baseFee` above this value get a {@link ValidationError} instead of
 * silently overpaying — this guards against a typo (e.g. passing the fee
 * in XLM, or an extra zero) draining an agent's wallet on every transaction.
 */
export const MAX_BASE_FEE_STROOPS = 100_000;

let clientDefaultBaseFee: number = DEFAULT_BASE_FEE_STROOPS;

/**
 * Validate a caller-supplied base fee (stroops). Throws a {@link
 * ValidationError} when the value is not a positive integer, or exceeds
 * {@link MAX_BASE_FEE_STROOPS}.
 */
export function validateBaseFee(baseFee: number): void {
  if (!Number.isFinite(baseFee) || !Number.isInteger(baseFee)) {
    throw new ValidationError('baseFee', `must be an integer number of stroops, got ${baseFee}`);
  }
  if (baseFee <= 0) {
    throw new ValidationError('baseFee', `must be a positive number of stroops, got ${baseFee}`);
  }
  if (baseFee > MAX_BASE_FEE_STROOPS) {
    throw new ValidationError(
      'baseFee',
      `must not exceed ${MAX_BASE_FEE_STROOPS} stroops (got ${baseFee}). ` +
        'This upper bound guards against accidentally overpaying network fees.',
    );
  }
}

/**
 * Set the client-level default base fee (stroops per operation) used by
 * {@link buildContractPaymentTx} and {@link payViaContract} when no
 * per-call `baseFee` override is supplied.
 *
 * @throws {ValidationError} When `baseFee` is invalid or exceeds {@link MAX_BASE_FEE_STROOPS}.
 */
export function setDefaultBaseFee(baseFee: number): void {
  validateBaseFee(baseFee);
  clientDefaultBaseFee = baseFee;
}

/** Get the current client-level default base fee (stroops). */
export function getDefaultBaseFee(): number {
  return clientDefaultBaseFee;
}

/** Reset the client-level default base fee back to {@link DEFAULT_BASE_FEE_STROOPS} (mainly for tests). */
export function resetDefaultBaseFee(): void {
  clientDefaultBaseFee = DEFAULT_BASE_FEE_STROOPS;
}

const MAINNET_RPC = 'https://mainnet.sorobanrpc.com';
const TESTNET_RPC = 'https://soroban-testnet.stellar.org';
const MAINNET_HORIZON = 'https://horizon.stellar.org';
const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';

/**
 * Resolve the Soroban RPC endpoint URL for the given network.
 *
 * @param networkPassphrase - Stellar network passphrase (e.g. `Networks.TESTNET` or `Networks.PUBLIC`)
 * @returns The Soroban RPC base URL for that network
 *
 * @example
 * ```typescript
 * const rpcUrl = getSorobanRpcUrl(Networks.TESTNET);
 * // 'https://soroban-testnet.stellar.org'
 * ```
 */
export function getSorobanRpcUrl(networkPassphrase: string): string {
  return networkPassphrase === Networks.TESTNET ? TESTNET_RPC : MAINNET_RPC;
}

/**
 * Resolve the Horizon REST API base URL for the given network.
 *
 * Used as the fallback confirmation endpoint in `submitSorobanTx` when
 * the Soroban RPC returns an XDR-version mismatch or becomes unreachable.
 * Defaults to mainnet so callers that omit the passphrase get the same
 * behaviour as before the F3-soroban network-awareness fix.
 *
 * @param networkPassphrase - Optional Stellar network passphrase. Omit for mainnet.
 * @returns The Horizon base URL for that network
 *
 * @example
 * ```typescript
 * const horizonUrl = getHorizonUrl(Networks.TESTNET);
 * // 'https://horizon-testnet.stellar.org'
 *
 * const mainnetUrl = getHorizonUrl(); // defaults to mainnet
 * // 'https://horizon.stellar.org'
 * ```
 */
// F3-soroban (2026-04-16): network-aware Horizon URL. Pre-fix, every
// Horizon fallback in submitSorobanTx was hardcoded to mainnet.
// Testnet agents got 404s from mainnet Horizon for their testnet txs,
// which the SDK interpreted as "tx never applied" with `dropped: true`
// — triggering the retry loop and risking a double-payment.
export function getHorizonUrl(networkPassphrase?: string): string {
  return networkPassphrase === Networks.TESTNET ? TESTNET_HORIZON : MAINNET_HORIZON;
}

/**
 * Convert a decimal string like "10.00" or "1.2345678" to a 7-decimal i128
 * bigint (stroops / micro-USDC). Rejects inputs with >7 fractional digits.
 *
 * @param decimal - A non-negative decimal string with at most 7 fractional digits
 * @returns The amount expressed as an i128 bigint in stroops (1 unit = 10,000,000 stroops)
 * @throws {Error} If the string is not a valid non-negative decimal
 * @throws {Error} If the fractional part has more than 7 digits
 * @throws {Error} If the resulting amount is zero or negative
 *
 * @example
 * ```typescript
 * decimalToStroops('10.00')      // 100_000_000n
 * decimalToStroops('0.0000001')  // 1n (minimum representable amount)
 * decimalToStroops('1.2345678')  // 12_345_678n
 * ```
 */
export function decimalToStroops(decimal: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(decimal)) {
    throw new Error(`Invalid decimal amount: ${decimal}`);
  }
  const parts = decimal.split('.');
  const whole = parts[0] ?? '0';
  const frac = parts[1] ?? '';
  if (frac.length > 7) {
    throw new Error(`Amount has more than 7 decimal places: ${decimal}`);
  }
  const padded = frac.padEnd(7, '0');
  const stroops = BigInt(whole) * 10_000_000n + BigInt(padded || '0');
  // F1-soroban (2026-04-16): reject zero amounts early. A pay_usdc(0)
  // or pay_xlm(0) invocation costs gas, clutters the ledger with a
  // zero-value event, and the backend watcher dead-letters it (the
  // F4-stellar audit rejects non-positive i128 at parse time). Catching
  // it here saves the agent gas and avoids a confusing dead-letter row.
  if (stroops <= 0n) {
    throw new Error(`Amount must be positive: ${decimal}`);
  }
  return stroops;
}

/**
 * Thrown when Soroban rejects a transaction because the offered fee was
 * too low. `requiredFee` is the minimum the network demanded (in stroops),
 * taken directly from the error response — callers should use it as the
 * floor when rebuilding the transaction.
 *
 * @example
 * ```typescript
 * try {
 *   await submitSorobanTx(tx, server);
 * } catch (err) {
 *   if (err instanceof InsufficientFeeError) {
 *     // Rebuild the tx using err.requiredFee as the minimum fee
 *     const { tx: retryTx } = await buildContractPaymentTx({ ...opts, fee: err.requiredFee });
 *   }
 * }
 * ```
 */
export class InsufficientFeeError extends Error {
  /** Minimum fee (in stroops) that the network demanded for this transaction. */
  requiredFee: string;
  constructor(requiredFee: string) {
    super(`Soroban transaction rejected: fee too low (network requires ${requiredFee} stroops)`);
    this.requiredFee = requiredFee;
  }
}

/**
 * Calculate the fee refunded by the network after a Soroban transaction
 * completes (`maxFee − feeCharged`). Negative results (should never happen
 * on a well-formed ledger) are clamped to `"0"`.
 *
 * @param maxFee - Fee allocated on the transaction envelope (stroops)
 * @param feeCharged - Fee actually consumed (stroops)
 */
export function computeFeeRefund(
  maxFee: string | number | bigint,
  feeCharged: string | number | bigint,
): { maxFee: string; feeCharged: string; feeRefunded: string } {
  const max = BigInt(maxFee);
  const charged = BigInt(feeCharged);
  const refunded = max - charged;
  return {
    maxFee: max.toString(),
    feeCharged: charged.toString(),
    feeRefunded: (refunded < 0n ? 0n : refunded).toString(),
  };
}

/**
 * Extract fee_charged / max_fee from a Horizon transaction JSON body and
 * compute the refund. Falls back to `fallbackMaxFee` when Horizon omits
 * `max_fee` (some older responses).
 */
export function extractFeeMetricsFromHorizon(
  horizonTx: { fee_charged?: string | number; max_fee?: string | number },
  fallbackMaxFee: string,
): { maxFee: string; feeCharged: string; feeRefunded: string } {
  const feeCharged = String(horizonTx.fee_charged ?? fallbackMaxFee);
  const maxFee = String(horizonTx.max_fee ?? fallbackMaxFee);
  return computeFeeRefund(maxFee, feeCharged);
}

function logGasEfficiency(
  logger: Logger | undefined,
  metrics: { maxFee: string; feeCharged: string; feeRefunded: string },
  txHash: string,
): void {
  const max = Number(metrics.maxFee);
  const efficiency = max > 0 ? ((1 - Number(metrics.feeCharged) / max) * 100).toFixed(1) : '0.0';
  logger?.debug?.(
    `Soroban gas refund for ${txHash}: charged=${metrics.feeCharged} max=${metrics.maxFee} refunded=${metrics.feeRefunded} (${efficiency}% unused)`,
    metrics,
  );
}

async function resolveFeeMetrics(
  txHash: string,
  maxFee: string,
  horizonUrl: string,
  logger?: Logger,
  feeChargedHint?: string,
): Promise<{ maxFee: string; feeCharged: string; feeRefunded: string }> {
  // Prefer an authoritative Horizon reading when available.
  try {
    const horizonResp = await fetch(`${horizonUrl}/transactions/${txHash}`);
    if (horizonResp.ok) {
      const data = (await horizonResp.json()) as {
        fee_charged?: string | number;
        max_fee?: string | number;
      };
      const metrics = extractFeeMetricsFromHorizon(data, maxFee);
      logGasEfficiency(logger, metrics, txHash);
      return metrics;
    }
  } catch {
    /* Horizon unreachable — fall through to hint / allocated fee */
  }

  const metrics = computeFeeRefund(maxFee, feeChargedHint ?? maxFee);
  logGasEfficiency(logger, metrics, txHash);
  return metrics;
}

export type PaymentFn = 'pay_usdc' | 'pay_xlm';

export interface BuildContractTxOpts {
  contractId: string;
  fn: PaymentFn;
  fromPublicKey: string;
  amountStroops: bigint;
  orderId: string;
  networkPassphrase: string;
  rpcUrl?: string;
  /**
   * Force the built tx to use this exact sequence number instead of
   * whatever Soroban RPC reports as the account's current sequence.
   *
   * Used by payViaContractOWS's retry loop to guarantee mutual
   * exclusion with a prior failed submit. If the original tx ends
   * up landing (e.g. it was accepted by the network despite the
   * client-side 120s deadline expiring), the retry — which shares
   * the same sequence — will fail with `tx_bad_seq` rather than
   * landing as a second payment. That gives us a free double-pay
   * safety property: at most one of the two attempts can ever
   * credit the order.
   *
   * Pass the sequence number that should appear in the built tx
   * (i.e. the post-bump value captured from a prior Transaction's
   * `.sequence` field). The builder internally converts that into
   * a pre-bump Account so the TransactionBuilder's
   * incrementSequenceNumber() call lands on exactly this value.
   */
  preservedSequence?: string;
  /**
   * Override the fee (stroops) directly, bypassing {@link baseFee}
   * validation entirely. Used internally by the fee-bump retry in
   * {@link payViaContract}: set this to the `requiredFee` from an
   * {@link InsufficientFeeError} to retry with the exact floor the
   * network demanded. Not validated against {@link MAX_BASE_FEE_STROOPS}
   * because it originates from the network, not caller input.
   */
  fee?: string;
  /**
   * Caller-supplied base fee override, in stroops per operation (#732).
   * Takes precedence over the client-level default set via
   * {@link setDefaultBaseFee} for this one call. Validated against
   * {@link MAX_BASE_FEE_STROOPS} — throws {@link ValidationError} if
   * invalid or over the bound. Ignored when `fee` is also set (the
   * fee-bump retry path always wins, since it reflects a network
   * requirement rather than a preference).
   */
  baseFee?: number;
}

/**
 * Build a Soroban transaction that invokes the receiver contract's pay_usdc
 * or pay_xlm function. Returns an unsigned, simulation-prepared Transaction
 * ready for the caller to sign (either via keypair or OWS) and submit.
 *
 * @param opts - Transaction build options
 * @param opts.contractId - Soroban contract address (C-address)
 * @param opts.fn - Contract function to invoke: `'pay_usdc'` or `'pay_xlm'`
 * @param opts.fromPublicKey - Signer's Stellar public key (G-address)
 * @param opts.amountStroops - Payment amount as a 7-decimal i128 bigint (see `decimalToStroops`)
 * @param opts.orderId - stellar_card order ID encoded into the contract call for backend indexing
 * @param opts.networkPassphrase - Stellar network passphrase (e.g. `Networks.TESTNET`)
 * @param opts.rpcUrl - Optional Soroban RPC URL override. Defaults to the network-appropriate endpoint.
 * @param opts.preservedSequence - Optional sequence number to reuse for retry mutual-exclusion (see `BuildContractTxOpts`)
 * @param opts.fee - Optional fee override in stroops. Defaults to `BASE_FEE`. Pass `InsufficientFeeError.requiredFee` on retry.
 * @returns The simulation-prepared transaction and the RPC server instance used to build it
 * @throws {Error} If Soroban simulation fails
 *
 * @example
 * ```typescript
 * const { tx, server } = await buildContractPaymentTx({
 *   contractId: 'CXXXX...',
 *   fn: 'pay_usdc',
 *   fromPublicKey: keypair.publicKey(),
 *   amountStroops: decimalToStroops('10.00'),
 *   orderId: 'ord_abc123',
 *   networkPassphrase: Networks.TESTNET,
 * });
 * tx.sign(keypair);
 * const txHash = await submitSorobanTx(tx, server);
 * ```
 */
export async function buildContractPaymentTx(
  opts: BuildContractTxOpts,
): Promise<{ tx: Transaction; server: rpc.Server }> {
  const server = new rpc.Server(opts.rpcUrl ?? getSorobanRpcUrl(opts.networkPassphrase));
  // When preservedSequence is set, build the Account manually from
  // the pre-bump value (N-1) so TransactionBuilder's implicit
  // incrementSequenceNumber() call lands exactly on the requested N.
  // Otherwise, load the current on-chain state.
  const account = opts.preservedSequence
    ? new Account(opts.fromPublicKey, (BigInt(opts.preservedSequence) - 1n).toString())
    : await server.getAccount(opts.fromPublicKey);

  const contract = new Contract(opts.contractId);
  const orderIdBytes = Buffer.from(opts.orderId, 'utf-8');
  const op = contract.call(
    opts.fn,
    new Address(opts.fromPublicKey).toScVal(),
    nativeToScVal(opts.amountStroops, { type: 'i128' }),
    nativeToScVal(orderIdBytes, { type: 'bytes' }),
  );

  let resolvedFee: string;
  if (opts.fee !== undefined) {
    resolvedFee = opts.fee;
  } else {
    const baseFee = opts.baseFee ?? getDefaultBaseFee();
    validateBaseFee(baseFee);
    resolvedFee = String(baseFee);
  }

  const raw = new TransactionBuilder(account, {
    fee: resolvedFee,
    networkPassphrase: opts.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(180)
    .build();

  const sim = await server.simulateTransaction(raw);
  if (rpc.Api.isSimulationError(sim)) {
    const contractCode = extractContractErrorCode(sim);
    if (contractCode !== null) {
      throw parseContractError(sim);
    }
    throw new Error(`Soroban simulation failed: ${sim.error}`);
  }

  const prepared = rpc.assembleTransaction(raw, sim).build();
  return { tx: prepared, server };
}

/**
 * Submit a signed Soroban transaction and poll until it reaches a terminal
 * status. Returns the transaction hash on success.
 *
 * Important: a successful return only guarantees the tx has been accepted
 * onto the ledger. The stellar_card backend's contract watcher is the source
 * of truth for "the order has been credited" — the SDK's purchaseCardOWS
 * always follows up with waitForCard against the order id, so even if
 * this function gives up before finalization, the watcher still has a
 * chance to credit the order if the tx eventually lands.
 *
 * @param tx - The signed Soroban transaction to submit
 * @param server - Soroban RPC server instance (returned by `buildContractPaymentTx`)
 * @param horizonUrl - Horizon base URL used as a fallback when Soroban RPC returns
 *   an XDR mismatch or becomes unreachable. Defaults to mainnet for backward compatibility.
 * @returns A {@link TransactionResult} including the hash and fee refund metrics
 * @throws {InsufficientFeeError} When the network rejects the tx due to an insufficient fee
 * @throws {Error} When the transaction fails on-chain (no recovery possible)
 * @throws {Error & \{ txHash: string; dropped: true \}} When the tx was accepted by the RPC
 *   but never applied on the ledger — callers may retry with the same sequence number
 * @throws {Error & \{ txHash: string \}} When the polling deadline is reached and Horizon
 *   is unreachable — the tx may still land; callers should wait on the order ID
 *
 * @example
 * ```typescript
 * const result = await submitSorobanTx(tx, server, getHorizonUrl(networkPassphrase));
 * console.log('Transaction confirmed:', result.hash, 'refunded:', result.feeRefunded);
 * ```
 */
export async function submitSorobanTx(
  tx: Transaction,
  server: rpc.Server,
  // F3-soroban (2026-04-16): callers pass the network-aware Horizon URL
  // so the fallback checks hit the correct network. Pre-fix, all three
  // fetch sites below were hardcoded to mainnet. Default to mainnet for
  // backward compat — callers that don't pass this parameter get the
  // same behaviour as before.
  horizonUrl: string = MAINNET_HORIZON,
  logger?: Logger,
): Promise<TransactionResult> {
  const maxFee = String(tx.fee ?? BASE_FEE);
  logger?.debug?.(`Submitting transaction to Soroban RPC`);
  // sendTransaction is idempotent for the same envelope. Three cases we
  // retry explicitly:
  //   - TRY_AGAIN_LATER: RPC is congested, re-send after a short wait
  //   - thrown network error (fetch/DNS/TCP): the request never reached
  //     the RPC, safe to retry
  //   - DUPLICATE is treated as "already in flight" — fall through to
  //     the polling loop below instead of looping forever
  // Up to 5 total attempts with 1.5s spacing covers typical RPC drops.
  const MAX_SEND_ATTEMPTS = 5;
  let send: Awaited<ReturnType<typeof server.sendTransaction>> | undefined;
  let sendErr: unknown;
  for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt++) {
    try {
      send = await server.sendTransaction(tx);
      if (send.status === 'TRY_AGAIN_LATER') {
        if (attempt < MAX_SEND_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        throw new Error(
          `Soroban network congested — sendTransaction returned TRY_AGAIN_LATER after ${MAX_SEND_ATTEMPTS} attempts. Retry the purchase in a minute.`,
        );
      }
      if (send.status === 'ERROR') {
        const contractCode = extractContractErrorCode(send.errorResult ?? send);
        if (contractCode !== null) {
          throw parseContractError(send.errorResult ?? send);
        }
        // txInsufficientFee — the network tells us what fee it needed.
        // Surface it as InsufficientFeeError so callers can rebuild
        // with the required fee as the floor and retry immediately.
        try {
          if (send.errorResult?.result().switch().name === 'txInsufficientFee') {
            throw new InsufficientFeeError(send.errorResult.feeCharged().toString());
          }
        } catch (feeErr) {
          if (feeErr instanceof InsufficientFeeError) throw feeErr;
          // XDR parsing failed — fall through to the generic error.
        }
        throw new Error(
          `Soroban sendTransaction error: ${JSON.stringify(send.errorResult ?? send)}`,
        );
      }
      // PENDING or DUPLICATE — envelope is now known to the network. Break
      // out of the retry loop and poll for finalization.
      break;
    } catch (err) {
      sendErr = err;
      // If the thrown error is structured (TRY_AGAIN_LATER, ERROR) let it
      // propagate directly. Otherwise assume it was a transient network
      // failure and retry.
      if (
        err instanceof InsufficientFeeError ||
        err instanceof ContractExecutionError ||
        (err instanceof Error &&
          (err.message.startsWith('Soroban network congested') ||
            err.message.startsWith('Soroban sendTransaction error')))
      ) {
        throw err;
      }
      if (attempt >= MAX_SEND_ATTEMPTS - 1) {
        throw new Error(
          `Soroban sendTransaction failed after ${MAX_SEND_ATTEMPTS} attempts: ${(err as Error)?.message ?? String(err)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!send) {
    throw new Error(
      `Soroban sendTransaction produced no result: ${(sendErr as Error)?.message ?? 'unknown error'}`,
    );
  }

  const buildResult = async (
    hash: string,
    ledger: number,
    feeChargedHint?: string,
  ): Promise<TransactionResult> => {
    const fees = await resolveFeeMetrics(hash, maxFee, horizonUrl, logger, feeChargedHint);
    return {
      hash,
      ledger,
      successful: true,
      ...fees,
    };
  };

  // Poll for finalization. 120s deadline (was 60s) so we don't bail on
  // mainnet RPC under modest backpressure. Each poll is cheap; the cost
  // of a longer wait is much less than the cost of a stranded order.
  // Some stellar-sdk versions can't parse newer Soroban RPC response XDR
  // ("Bad union switch: 4"); when that happens, fall back to Horizon.
  //
  // Error-handling contract — changed 2026-04-14 after we shipped a
  // stranded-order bug where FAILED statuses from getTransaction were
  // silently caught by the inner try/catch and the loop kept polling
  // until the deadline, at which point a txHash-attached error was
  // thrown and purchaseCardOWS fell through to waitForCard on a tx
  // that had actually failed on-chain. The new rules are:
  //
  //   - Any throw whose message starts with "Soroban transaction " is
  //     one of OUR OWN terminal throws; the catch re-raises it out of
  //     the while loop unchanged.
  //   - A `txHash` is only attached to the final timeout error when we
  //     genuinely believe the tx MAY still land on the ledger later
  //     (Horizon unreachable). In every other terminal state — tx
  //     applied and failed, or Horizon confirms the tx never made a
  //     ledger — we throw a plain Error, which purchaseCardOWS will
  //     propagate to the caller instead of entering waitForCard.
  const POLL_DEADLINE_MS = 120_000;
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      const status = await server.getTransaction(send.hash);
      if (status.status === 'SUCCESS') {
        const hint =
          typeof (status as { feeCharged?: unknown }).feeCharged === 'string' ||
          typeof (status as { feeCharged?: unknown }).feeCharged === 'number'
            ? String((status as { feeCharged: string | number }).feeCharged)
            : undefined;
        return await buildResult(send.hash, status.ledger ?? 0, hint);
      }
      if (status.status === 'FAILED') {
        const contractCode = extractContractErrorCode(status);
        if (contractCode !== null) {
          throw parseContractError(status);
        }
        throw new Error(`Soroban transaction ${send.hash} failed on-chain`);
      }
      // NOT_FOUND (or any transient non-terminal status): keep polling.
    } catch (pollErr: unknown) {
      if (pollErr instanceof ContractExecutionError) {
        throw pollErr;
      }
      // Re-raise our own terminal throws so they escape the loop.
      if (
        pollErr instanceof Error &&
        pollErr.message.startsWith(`Soroban transaction ${send.hash}`)
      ) {
        throw pollErr;
      }
      // "Bad union switch" = XDR version mismatch between SDK and RPC.
      // The TX was accepted by sendTransaction; confirm via Horizon instead.
      if (String((pollErr as Error)?.message || '').includes('Bad union switch')) {
        try {
          const horizonResp = await fetch(`${horizonUrl}/transactions/${send.hash}`);
          if (horizonResp.ok) {
            const horizonData = (await horizonResp.json()) as {
              successful: boolean;
              ledger?: number;
              fee_charged?: string | number;
              max_fee?: string | number;
            };
            if (horizonData.successful) {
              const fees = extractFeeMetricsFromHorizon(horizonData, maxFee);
              logGasEfficiency(logger, fees, send.hash);
              return {
                hash: send.hash,
                ledger: horizonData.ledger ?? 0,
                successful: true,
                ...fees,
              };
            }
            // Horizon can see it and it failed — terminal, no recovery.
            throw new Error(`Soroban transaction ${send.hash} failed on-chain (Horizon)`);
          }
        } catch (horizonErr) {
          // Re-raise our own terminal Horizon throws
          if (
            horizonErr instanceof Error &&
            horizonErr.message.startsWith(`Soroban transaction ${send.hash}`)
          ) {
            throw horizonErr;
          }
          /* Horizon unreachable — keep polling Soroban RPC */
        }
      }
      // Any other poll-layer error: treat as transient, keep polling.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Deadline reached without a terminal status. Before giving up, ask
  // Horizon what actually happened to the tx — it's the authoritative
  // record of what hit a ledger, independent of Soroban RPC's state.
  try {
    const horizonResp = await fetch(`${horizonUrl}/transactions/${send.hash}`);
    if (horizonResp.ok) {
      const horizonData = (await horizonResp.json()) as {
        successful: boolean;
        ledger?: number;
        fee_charged?: string | number;
        max_fee?: string | number;
      };
      if (horizonData.successful) {
        const fees = extractFeeMetricsFromHorizon(horizonData, maxFee);
        logGasEfficiency(logger, fees, send.hash);
        return {
          hash: send.hash,
          ledger: horizonData.ledger ?? 0,
          successful: true,
          ...fees,
        };
      }
      // Tx landed and failed. No recovery path — throw without txHash
      // so the caller propagates the error instead of waiting on a card
      // that will never come.
      throw new Error(
        `Soroban transaction ${send.hash} applied on-chain but failed — no card will be credited. Retry the purchase.`,
      );
    }
    if (horizonResp.status === 404) {
      // Tx was accepted by Soroban RPC (we have a hash) but it never
      // made it into a ledger on Horizon. This is the "network rejected
      // at apply time" case — e.g., source account sequence drifted,
      // host function errored before any effects landed. It is NOT
      // going to "eventually land".
      //
      // Attach both txHash and a structured `dropped: true` marker.
      // payViaContractOWS's retry loop uses the marker to decide whether
      // to resubmit with the same sequence (guaranteeing mutual
      // exclusion). Without the marker, the retry layer can't
      // distinguish this case from "on-chain failure" (where retrying
      // would be incorrect because the sequence was consumed by the
      // failed tx).
      const droppedErr = new Error(
        `Soroban transaction ${send.hash} was accepted by the RPC but never applied on the ledger within ${POLL_DEADLINE_MS / 1000}s — the network rejected it pre-apply. Retry the purchase.`,
      ) as Error & { txHash: string; dropped: true };
      droppedErr.txHash = send.hash;
      droppedErr.dropped = true;
      throw droppedErr;
    }
  } catch (horizonErr) {
    // Re-raise our own terminal Horizon throws; swallow network errors.
    if (
      horizonErr instanceof Error &&
      horizonErr.message.startsWith(`Soroban transaction ${send.hash}`)
    ) {
      throw horizonErr;
    }
    /* Horizon itself is unreachable — fall through to the timeout
       error below, where we attach txHash as a last-resort safety net.
       The watcher may still credit the order if the tx eventually
       lands and Horizon comes back up. */
  }

  // Soroban RPC never saw a terminal state AND Horizon is unreachable
  // (or the response was neither 2xx nor 404). We genuinely don't know
  // whether the tx landed, so attach txHash and let purchaseCardOWS
  // give the stellar_card backend watcher a chance to credit the order.
  const err = new Error(
    `Soroban transaction ${send.hash} did not finalize within ${POLL_DEADLINE_MS / 1000}s and Horizon is unreachable`,
  );
  (err as Error & { txHash?: string }).txHash = send.hash;
  throw err;
}

/**
 * Automatically simulate a Soroban contract invocation to estimate gas costs and
 * populate resource fees and authorization entries before submission.
 *
 * This helper wraps the simulation logic from buildContractPaymentTx so callers
 * can estimate gas costs for a transaction without building the full payment flow.
 * Useful for calculating fees, validating contracts, or dry-running contract calls.
 *
 * @param tx - The unsigned Soroban transaction to simulate
 * @param server - Soroban RPC server instance
 * @returns The simulation result with populated resource fees and auth entries
 * @throws {Error} If Soroban simulation fails (e.g. contract revert)
 *
 * @example
 * ```typescript
 * const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
 *   .addOperation(contract.call(...))
 *   .setTimeout(180)
 *   .build();
 *
 * const sim = await simulateContractTransaction(tx, server);
 * const prepared = rpc.assembleTransaction(tx, sim).build();
 * prepared.sign(keypair);
 * const result = await submitSorobanTx(prepared, server, horizonUrl);
 * ```
 */
export async function simulateContractTransaction(
  tx: Transaction,
  server: rpc.Server,
): Promise<rpc.Api.SimulateTransactionResponse> {
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    const contractCode = extractContractErrorCode(sim);
    if (contractCode !== null) {
      throw parseContractError(sim);
    }
    throw new Error(`Soroban simulation failed: ${sim.error}`);
  }
  return sim;
}

/**
 * Decide which contract function + asset amount to use based on the
 * PaymentInstructions returned from POST /v1/orders.
 *
 * @param payment - Payment instruction object containing USDC and optional XLM quotes
 * @param payment.usdc - USDC quote with the `amount` decimal string
 * @param payment.xlm - Optional XLM quote with the `amount` decimal string
 * @param paymentAsset - Asset to pay with: `'usdc'` or `'xlm'`
 * @returns The matching contract function name and the decimal amount string to use
 * @throws {Error} When `paymentAsset` is `'xlm'` but no XLM quote is present in `payment`
 *
 * @example
 * ```typescript
 * const { fn, amountDecimal } = selectContractCall(paymentInstructions, 'usdc');
 * const amountStroops = decimalToStroops(amountDecimal);
 * ```
 */
export function selectContractCall(
  payment: { usdc: { amount: string }; xlm?: { amount: string } },
  paymentAsset: 'usdc' | 'xlm',
): { fn: PaymentFn; amountDecimal: string } {
  if (paymentAsset === 'xlm') {
    if (!payment.xlm?.amount) {
      throw new Error('Order response does not include an XLM quote');
    }
    return { fn: 'pay_xlm', amountDecimal: payment.xlm.amount };
  }
  return { fn: 'pay_usdc', amountDecimal: payment.usdc.amount };
}

/**
 * Decoded view of `ContractConfig` returned by the receiver contract's
 * `get_config` entrypoint (issue #651). Field names match the Soroban struct.
 */
export interface ContractConfig {
  admin: string;
  treasury: string;
  usdc_contract: string;
  xlm_contract: string;
  is_paused: boolean;
}

/**
 * Read the receiver contract's full configuration in a single view call
 * (issue #651).
 *
 * Builds a Soroban transaction invoking `get_config`, simulates it against
 * the RPC (no signing, no submission, no state write), and decodes the
 * returned `ContractConfig` struct. Requires no authorization.
 *
 * @param opts.contractId - Receiver contract address (`C...`)
 * @param opts.networkPassphrase - Defaults to {@link Networks.PUBLIC}
 * @param opts.sorobanRpcUrl - Defaults to the public endpoint for the network
 * @returns The decoded {@link ContractConfig}
 * @throws {Error} When the contract is unreachable or `get_config` reverts
 *   (e.g. called before `init`)
 *
 * @example
 * ```typescript
 * const cfg = await fetchContractConfig({ contractId: payment.contract_id });
 * if (cfg.is_paused) throw new Error('contract is paused');
 * ```
 */
export async function fetchContractConfig(opts: {
  contractId: string;
  networkPassphrase?: string;
  sorobanRpcUrl?: string;
}): Promise<ContractConfig> {
  const networkPassphrase = opts.networkPassphrase ?? Networks.PUBLIC;
  const server = new rpc.Server(opts.sorobanRpcUrl ?? getSorobanRpcUrl(networkPassphrase));

  // Simulation only needs a well-formed source account; sequence `0` is never
  // submitted, so any valid keypair-shaped account works for a read-only call.
  const source = new Account(opts.contractId, '0');
  const contract = new Contract(opts.contractId);
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call('get_config'))
    .setTimeout(60)
    .build();

  const sim = await simulateContractTransaction(tx, server);
  const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!retval) {
    throw new Error('get_config simulation returned no result value');
  }

  const raw = scValToNative(retval) as Record<string, unknown>;
  return {
    admin: String(raw.admin),
    treasury: String(raw.treasury),
    usdc_contract: String(raw.usdc_contract),
    xlm_contract: String(raw.xlm_contract),
    is_paused: Boolean(raw.is_paused),
  };
}

// Re-export xdr so callers in sibling modules can construct DecoratedSignature
// without importing the whole stellar-sdk surface.
export { xdr };
