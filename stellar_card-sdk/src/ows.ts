// OWS (Open Wallet Standard) wallet integration for stellar_card.
//
// Agents use an OWS wallet instead of a raw STELLAR_WALLET_SECRET:
//   - Keys are encrypted at rest in the OWS vault file
//   - BIP-44 derivation (m/44'/148'/0') for Stellar
//   - Same wallet works across EVM, Solana, Stellar (multi-chain portability)
//   - Supports passphrase protection and API key scoping
//
// Signing bridge: stellar-sdk computes the correct network-passphrase-prefixed
// hash; OWS ed25519-signs that hash; we attach the result as a DecoratedSignature.

import {
  createWallet as owsCreate,
  getWallet as owsGet,
  importWalletPrivateKey,
  signTransaction as owsSign,
  type WalletInfo,
} from '@ctx.com/stellar-ows-core';

import {
  Keypair,
  Networks,
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  StrKey,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';

import type { CardDetails, PaymentInstructions } from './client';
import { ResumableError, OrderFailedError, Stellar_CardError } from './errors';
import {
  buildContractPaymentTx,
  submitSorobanTx,
  decimalToStroops,
  selectContractCall,
  getHorizonUrl,
  InsufficientFeeError,
} from './soroban';
import type { ContractPaymentResult } from './types';

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const STELLAR_CHAIN = 'stellar';

function withTimeout<T>(promise: Promise<T>, ms = 15000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Horizon request timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ── Wallet helpers ────────────────────────────────────────────────────────────

/**
 * Extract the Stellar G-address from an OWS WalletInfo.
 *
 * @param wallet - The OWS wallet information object
 * @returns The Stellar public key (G-address) for the wallet
 * @throws {Error} When the wallet has no Stellar account configured
 */
function getStellarAddress(wallet: WalletInfo): string {
  const account = wallet.accounts.find((a) => a.chainId.includes('stellar'));
  if (!account) throw new Error(`OWS wallet "${wallet.name}" has no Stellar account`);
  return account.address;
}

/**
 * Create an OWS wallet, or return the existing one if a wallet with this
 * name already exists in the vault. Idempotent by design — calling it
 * twice with the same name is safe and returns the same keys, so skill.md
 * flows and agent retries don't duplicate state.
 *
 * Wallets are stored encrypted at `~/.ows/wallets/<name>.vault` by
 * default. If the vault file is lost, the funds it controls become
 * unreachable — stellar_card never sees private keys and can't recover
 * them. Agents running on ephemeral filesystems (Lambda, Cloud Run,
 * scratch containers) should pass a `vaultPath` pointing at a
 * persistent volume, or set the `OWS_VAULT_PATH` environment variable.
 * @param name - The name of the wallet to create or fetch.
 * @param passphrase - Optional passphrase to encrypt the wallet at rest.
 * @param vaultPath - Optional custom path for the OWS vault directory.
 * @returns Object containing the generated `walletId` and Stellar `publicKey`.
 */
export function createOWSWallet(
  name: string,
  passphrase?: string,
  vaultPath?: string,
): { walletId: string; publicKey: string } {
  // Fast path: existing wallet. Returns immediately if one is already in
  // the vault under this name.
  try {
    const existing = owsGet(name, vaultPath ?? null);
    return { walletId: existing.id, publicKey: getStellarAddress(existing) };
  } catch {
    /* not found — fall through to create */
  }
  const wallet = owsCreate(name, passphrase ?? null, undefined, vaultPath ?? null);
  return { walletId: wallet.id, publicKey: getStellarAddress(wallet) };
}

/**
 * Import an existing Stellar secret key (S...) into an OWS wallet.
 * Useful for migrating from a raw STELLAR_WALLET_SECRET to OWS custody.
 * @param name - The name of the wallet to store the key under.
 * @param stellarSecret - The raw Stellar secret key (S-address) to import.
 * @param passphrase - Optional passphrase to encrypt the wallet at rest.
 * @param vaultPath - Optional custom path for the OWS vault directory.
 * @returns Object containing the `walletId` and Stellar `publicKey`.
 */
export function importStellarKey(
  name: string,
  stellarSecret: string,
  passphrase?: string,
  vaultPath?: string,
): { walletId: string; publicKey: string } {
  const keypair = Keypair.fromSecret(stellarSecret);
  const secretBuffer = Buffer.from(keypair.rawSecretKey());
  const ed25519KeyHex = secretBuffer.toString('hex');
  // Wipe the raw secret key material from memory now that it has been
  // copied into the hex form handed to OWS vault storage.
  zeroizeSecret(secretBuffer);
  const wallet = importWalletPrivateKey(
    name,
    '', // secp256k1 key (EVM) — not used for Stellar
    passphrase ?? null,
    vaultPath ?? null,
    STELLAR_CHAIN,
    null, // secp256K1Key — not used
    ed25519KeyHex,
  );
  return { walletId: wallet.id, publicKey: getStellarAddress(wallet) };
}

// ── Secure in-memory zeroization of secret keys ───────────────────────────

/**
 * Securely zero out secret key material held in a `Uint8Array`/`Buffer` in
 * place.
 *
 * Fills every byte with `0` so the plaintext secret no longer resides in
 * memory after it has been copied into a derived form (e.g. the hex form
 * handed to OWS vault storage). JavaScript `string`s are immutable and
 * cannot be overwritten in place — pass secrets as `Buffer`/`Uint8Array`
 * when you need true in-memory zeroization, and reassign any `string`
 * copies to `''` once they are no longer needed.
 *
 * @param buf - Buffer holding secret key material to be destroyed.
 * @example
 * const secret = Buffer.from(keypair.rawSecretKey());
 * const hex = secret.toString('hex');
 * zeroizeSecret(secret); // secret bytes wiped from memory
 */
export function zeroizeSecret(buf: Uint8Array): void {
  buf.fill(0);
}

/**
 * Get the Stellar public key (G-address) for a named OWS wallet.
 *
 * @param walletName - The name of the OWS wallet to query
 * @param vaultPath - Optional custom path to the OWS vault directory
 * @returns The Stellar public key (G-address) for the wallet
 * @throws {Error} When the wallet is not found or has no Stellar account
 *
 * @example
 * ```typescript
 * const publicKey = getOWSPublicKey('my-agent-wallet');
 * console.log('Wallet address:', publicKey); // G...
 * ```
 */
export function getOWSPublicKey(walletName: string, vaultPath?: string): string {
  const wallet = owsGet(walletName, vaultPath ?? null);
  return getStellarAddress(wallet);
}

/**
 * Check XLM and USDC balances for an OWS wallet.
 *
 * @param walletName - The name of the OWS wallet to check
 * @param vaultPath - Optional custom path to the OWS vault directory
 * @param networkPassphrase - Optional Stellar network passphrase (defaults to mainnet)
 * @returns Promise resolving to an object containing XLM and USDC balances as decimal strings
 * @throws {Error} When the wallet is not found or Horizon request fails
 *
 * @example
 * ```typescript
 * const balance = await getOWSBalance('my-agent-wallet');
 * console.log(`XLM: ${balance.xlm}, USDC: ${balance.usdc}`);
 * ```
 */
export async function getOWSBalance(
  walletName: string,
  vaultPath?: string,
  networkPassphrase?: string,
): Promise<{ xlm: string; usdc: string }> {
  const publicKey = getOWSPublicKey(walletName, vaultPath);
  const server = new Horizon.Server(getHorizonUrl(networkPassphrase));
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

// ── Onboarding helper ─────────────────────────────────────────────────────────

export interface OnboardAgentOpts {
  /** stellar_card API key (stellar_card_…) */
  apiKey: string;
  /** Local name for the wallet in the OWS vault, e.g. 'my-agent' */
  walletName: string;
  /** Override the default https://api.stellar_card.com/v1 */
  baseUrl?: string;
  /** Optional passphrase for extra at-rest encryption */
  passphrase?: string;
  /** Override the default ~/.ows/wallets vault path — use a persistent
   *  volume if you're running on ephemeral storage (Lambda, Cloud Run,
   *  scratch containers). Lost vault = lost funds. */
  vaultPath?: string;
}

export interface OnboardAgentResult {
  publicKey: string;
  balance: { xlm: string; usdc: string };
}

/**
 * One-shot agent setup: reports `initializing` to stellar_card, creates or
 * fetches the OWS wallet, reports `awaiting_funding` with the wallet
 * address, and returns the public key + current balance. Idempotent —
 * safe to call on every agent startup.
 *
 * The backend broadcasts these transitions over the live SSE dashboard
 * feed, so operators see the agent moving through states in real time.
 * @param opts - Onboarding options including API key and wallet configuration.
 * @returns Object containing the new `publicKey` and current `balance`.
 */
export async function onboardAgent(opts: OnboardAgentOpts): Promise<OnboardAgentResult> {
  const { Stellar_CardClient } = await import('./client');
  const client = new Stellar_CardClient({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });

  // 1. Signal "spinning up" before we touch the filesystem. Best-effort:
  //    reportStatus swallows errors so a backend hiccup can't block setup.
  await client.reportStatus('initializing', { detail: 'creating wallet' });

  // 2. Create or fetch the wallet. Idempotent via createOWSWallet's
  //    getWallet-first path.
  const { publicKey } = createOWSWallet(opts.walletName, opts.passphrase, opts.vaultPath);

  // 3. Fetch balance. On a fresh wallet this hits Horizon and may 404
  //    if the account isn't activated yet (< 1 XLM on-chain). Swallow
  //    that case and return 0/0; the dashboard will show "Awaiting
  //    deposit" and the next getOWSBalance call will see the funds.
  let balance = { xlm: '0', usdc: '0' };
  try {
    balance = await getOWSBalance(opts.walletName, opts.vaultPath);
  } catch {
    /* unactivated account — normal on first run */
  }

  // 4. Report the wallet address so the dashboard can show it and
  //    start polling Horizon for the balance.
  await client.reportStatus('awaiting_funding', {
    wallet_public_key: publicKey,
    detail: `xlm=${balance.xlm} usdc=${balance.usdc}`,
  });

  return { publicKey, balance };
}

// ── Signing bridge ────────────────────────────────────────────────────────────

/**
 * Sign a stellar-sdk Transaction using an OWS wallet.
 *
 * stellar-sdk computes tx.hash() = sha256(network_passphrase_prefix || tx_xdr),
 * which is the exact 32-byte payload that must be ed25519-signed. We pass this
 * hash to OWS rather than the raw envelope so that network passphrase is handled
 * correctly regardless of OWS internals.
 */
interface SignableTx {
  hash(): Buffer;
  signatures: xdr.DecoratedSignature[];
}

function owsSignTx<T extends SignableTx>(
  tx: T,
  walletName: string,
  publicKey: string,
  passphrase?: string,
  vaultPath?: string,
): T {
  // The oceans404 Stellar fork's signTransaction expects the full transaction
  // envelope XDR, NOT just the hash. It internally:
  //   1. Parses the XDR envelope
  //   2. Builds the network-passphrase-prefixed signature payload
  //   3. Ed25519-signs the sha256 of that payload
  //   4. Returns the raw 64-byte signature
  const envelopeXdr = (tx as unknown as { toEnvelope(): { toXDR(fmt: string): string } })
    .toEnvelope()
    .toXDR('hex');
  const { signature: sigHex } = owsSign(
    walletName,
    STELLAR_CHAIN,
    envelopeXdr,
    passphrase ?? null,
    null,
    vaultPath ?? null,
  );

  const pubKeyBytes = StrKey.decodeEd25519PublicKey(publicKey);
  const hint = pubKeyBytes.slice(-4);
  tx.signatures.push(
    new xdr.DecoratedSignature({
      hint,
      signature: Buffer.from(sigHex, 'hex'),
    }),
  );
  return tx;
}

// ── Soroban tx landed-check ──────────────────────────────────────────────────

/**
 * Check whether a Soroban tx hash has materialized on the Stellar
 * ledger. Returns:
 *   - 'landed'  — Horizon returned a successful tx record
 *   - 'dropped' — Horizon 404s and the caller has already exhausted
 *                 the inclusion window client-side, so the tx is
 *                 almost certainly gone
 *   - 'pending' — Horizon is down or the tx is still in the
 *                 mempool; caller should wait rather than resubmit
 *
 * Used by purchaseCardOWS's resume branch to decide whether a
 * dropped-pre-apply Soroban tx should be re-submitted or whether we
 * should wait for a still-in-flight one to finalize.
 * @param txHash - The Soroban transaction hash to check.
 * @param opts - Options including the optional network passphrase.
 * @returns 'landed' if successful, 'dropped' if 404/failed, or 'pending' if unknown.
 */
export async function checkSorobanTxLanded(
  txHash: string,
  opts: { networkPassphrase?: string } = {},
): Promise<'landed' | 'dropped' | 'pending'> {
  const horizonUrl = getHorizonUrl(opts.networkPassphrase);
  try {
    const res = await fetch(`${horizonUrl}/transactions/${txHash}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { successful?: boolean };
      return body.successful === false ? 'dropped' : 'landed';
    }
    if (res.status === 404) {
      // Horizon doesn't know about this tx. The caller reached us
      // only after an in-process submit already timed out past the
      // 120s Soroban inclusion window, so a 404 now is as good a
      // signal as we'll get that the tx was dropped pre-apply.
      return 'dropped';
    }
    // Horizon returned an unexpected status — don't make a
    // resubmit decision based on a flaky response.
    return 'pending';
  } catch {
    // Network error hitting Horizon. Treat as pending — we'd
    // rather wait than risk a double-pay on an unreliable signal.
    return 'pending';
  }
}

// ── Trustline ─────────────────────────────────────────────────────────────────

export interface TrustlineOpts {
  walletName: string;
  passphrase?: string;
  vaultPath?: string;
  networkPassphrase?: string;
}

/**
 * Add a USDC trustline to the OWS wallet's Stellar account.
 *
 * Idempotent: if the trustline already exists, returns `null` without
 * submitting a tx (Stellar accepts redundant `changeTrust` ops and
 * silently no-ops them, but charges the base fee each time — so
 * pre-checking saves ~0.00001 XLM per accidental re-run). Returns the
 * new tx hash when a trustline is actually opened.
 * @param opts - Trustline options including wallet name and network.
 * @returns The transaction hash if a trustline was created, or `null` if one already exists.
 */
export async function addUsdcTrustlineOWS(opts: TrustlineOpts): Promise<string | null> {
  const { walletName, passphrase, vaultPath, networkPassphrase = Networks.PUBLIC } = opts;
  const publicKey = getOWSPublicKey(walletName, vaultPath);
  const horizonUrl = getHorizonUrl(networkPassphrase);

  const server = new Horizon.Server(horizonUrl);
  const account = await withTimeout(server.loadAccount(publicKey));
  // Pre-check: already have a USDC trustline to the stellar_card-recognised
  // issuer? Return null without spending a fee.
  const balances = (account as unknown as { balances: Array<Record<string, unknown>> }).balances;
  const hasTrustline = balances.some(
    (b) =>
      b.asset_type === 'credit_alphanum4' &&
      b.asset_code === 'USDC' &&
      b.asset_issuer === USDC_ISSUER,
  );
  if (hasTrustline) return null;

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(Operation.changeTrust({ asset: new Asset('USDC', USDC_ISSUER) }))
    .setTimeout(300)
    .build();

  owsSignTx(tx, walletName, publicKey, passphrase, vaultPath);
  const result = await server.submitTransaction(tx);
  return (result as { hash: string }).hash;
}

// ── Soroban contract payment ──────────────────────────────────────────────────

export interface PayViaContractOwsOpts {
  walletName: string;
  payment: PaymentInstructions;
  paymentAsset?: 'usdc' | 'xlm';
  passphrase?: string;
  vaultPath?: string;
  networkPassphrase?: string;
  sorobanRpcUrl?: string;
  /** Override the Horizon REST API URL used during contract submission. */
  horizonUrl?: string;
}

/**
 * Pay the stellar_card receiver contract using an OWS-custody wallet. Builds a
 * Soroban `pay_usdc` or `pay_xlm` invocation, signs the transaction hash via
 * OWS, and submits it to the Soroban RPC. Returns the transaction hash.
 */
/**
 * Injectable dependency bundle for payViaContractOWS. Production
 * callers omit this entirely — the defaults point at the real
 * build / submit / sign / pubkey helpers. Tests inject stubs to
 * exercise the retry state machine without touching real Soroban
 * or a real wallet vault.
 */
export interface PayViaContractOwsDeps {
  buildContractPaymentTx?: typeof buildContractPaymentTx;
  /**
   * Injectable submit. Production uses {@link submitSorobanTx}.
   * Tests may return a bare hash string for convenience — payViaContractOWS
   * normalises both shapes into {@link ContractPaymentResult}.
   */
  submitSorobanTx?: (
    ...args: Parameters<typeof submitSorobanTx>
  ) => Promise<Awaited<ReturnType<typeof submitSorobanTx>> | string>;
  owsSignTx?: (
    tx: Transaction,
    walletName: string,
    publicKey: string,
    passphrase?: string,
    vaultPath?: string,
  ) => void;
  getOWSPublicKey?: (walletName: string, vaultPath?: string) => string;
}

/**
 * Max total submit attempts made by payViaContractOWS before giving up
 * and surfacing the last error to the caller. Retries are ONLY triggered
 * by the `dropped: true` marker on the submit error — any other error
 * (on-chain failure, validation, network, timeout without dropped
 * signal) propagates immediately. 3 attempts is a comfortable upper
 * bound: flaky mainnet RPC usually recovers within one retry, and
 * retrying forever past a real incident just burns wallet fees.
 */
const PAY_VIA_CONTRACT_MAX_ATTEMPTS = 3;

/**
 * Milliseconds to wait between retry attempts. Lets any in-flight
 * original tx have one more ledger-close window to materialize before
 * we build the retry. Stellar ledger close is ~5s, so 6s covers
 * "one more ledger" plus a small buffer.
 */
const PAY_VIA_CONTRACT_RETRY_DELAY_MS = 6_000;

/**
 * Pay the stellar_card receiver contract using an OWS-custody wallet. Builds a
 * Soroban `pay_usdc` or `pay_xlm` invocation, signs the transaction hash via
 * OWS, and submits it to the Soroban RPC.
 *
 * @param opts - Options including the wallet name, payment instructions, and network config.
 * @param deps - Optional injectable dependencies for testing (defaults to real implementations).
 * @returns A {@link ContractPaymentResult} with the transaction hash and fee refund metrics.
 */
export async function payViaContractOWS(
  opts: PayViaContractOwsOpts,
  deps: PayViaContractOwsDeps = {},
): Promise<ContractPaymentResult> {
  const {
    walletName,
    payment,
    paymentAsset = 'usdc',
    passphrase,
    vaultPath,
    networkPassphrase = Networks.PUBLIC,
    sorobanRpcUrl,
    horizonUrl,
  } = opts;

  // Resolve injectable deps — each defaults to the module-level
  // real implementation, so production callers never notice the
  // parameter exists. Tests inject stubs to exercise the retry
  // state machine without touching real Soroban / OWS vault.
  const buildTx = deps.buildContractPaymentTx ?? buildContractPaymentTx;
  const submitTx = deps.submitSorobanTx ?? submitSorobanTx;
  const signTx = deps.owsSignTx ?? owsSignTx;
  const pubKeyOf = deps.getOWSPublicKey ?? getOWSPublicKey;

  if (!StrKey.isValidContract(payment.contract_id)) {
    throw new Error(`Invalid contract_id in order response: ${payment.contract_id}`);
  }

  const publicKey = pubKeyOf(walletName, vaultPath);
  const { fn, amountDecimal } = selectContractCall(payment, paymentAsset);
  const amountStroops = decimalToStroops(amountDecimal);

  // Retry loop. First attempt uses the current on-chain sequence; any
  // retry reuses the sequence from the previous attempt via the
  // preservedSequence plumbing in buildContractPaymentTx. This gives
  // us mutual exclusion with the prior (possibly still in-mempool)
  // tx — at most one can land regardless of which the network picks.
  //
  // Retries only trigger on the `dropped: true` marker from
  // submitSorobanTx, which is only set when Horizon explicitly reports
  // 404 after the 120s client-side inclusion deadline. Any other error
  // — on-chain failure, validation, submit-level error, txHash-
  // attached-but-not-dropped — propagates out unchanged so
  // purchaseCardOWS's caller-side handling stays correct.
  let preservedSequence: string | undefined;
  let suggestedFee: string | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < PAY_VIA_CONTRACT_MAX_ATTEMPTS; attempt++) {
    const { tx, server } = await buildTx({
      contractId: payment.contract_id,
      fn,
      fromPublicKey: publicKey,
      amountStroops,
      orderId: payment.order_id,
      networkPassphrase,
      rpcUrl: sorobanRpcUrl,
      preservedSequence,
      fee: suggestedFee,
    });
    // Capture the sequence this tx uses BEFORE signing / submitting.
    // On retry we'll feed this back in as preservedSequence so the
    // next build lands on the same number.
    const thisSeq = tx.sequence;

    signTx(tx, walletName, publicKey, passphrase, vaultPath);

    const resolvedHorizonUrl = horizonUrl ?? getHorizonUrl(networkPassphrase);
    try {
      const submitted = await submitTx(tx, server, resolvedHorizonUrl);
      // Tests historically mocked submitSorobanTx to return a bare hash
      // string — accept both shapes so existing stubs keep working.
      const fallbackFee = String(tx.fee ?? '100');
      if (typeof submitted === 'string') {
        return {
          hash: submitted,
          feeCharged: fallbackFee,
          feeRefunded: '0',
          maxFee: fallbackFee,
        };
      }
      return {
        hash: submitted.hash,
        feeCharged: submitted.feeCharged ?? fallbackFee,
        feeRefunded: submitted.feeRefunded ?? '0',
        maxFee: submitted.maxFee ?? fallbackFee,
      };
    } catch (err) {
      lastErr = err;
      // Fee too low — retry with the network's required fee as floor.
      // The tx was rejected pre-apply so no sequence was consumed;
      // grab a fresh one on the next build (don't set preservedSequence).
      if (err instanceof InsufficientFeeError) {
        if (attempt >= PAY_VIA_CONTRACT_MAX_ATTEMPTS - 1) throw err;
        suggestedFee = err.requiredFee;
        continue;
      }
      const dropped = (err as Error & { dropped?: boolean })?.dropped === true;
      // Not dropped → propagate. This covers on-chain failures
      // (sequence already consumed, retry would fail tx_bad_seq),
      // validation errors (same error on retry), and the
      // "txHash-attached-but-Horizon-unreachable" case (where we
      // DON'T know whether the tx is still pending — a retry with
      // the same sequence might race, a retry with a fresh sequence
      // might double-pay).
      if (!dropped) throw err;
      // Dropped pre-apply. Reuse this sequence for the next build
      // so the retry is mutually exclusive with the prior tx.
      preservedSequence = thisSeq;
      // No more attempts budgeted → surface the last error.
      if (attempt >= PAY_VIA_CONTRACT_MAX_ATTEMPTS - 1) throw err;
      // Small delay before retry so any in-flight original gets one
      // more ledger-close window to materialize. If it lands during
      // the wait, our retry's matching sequence will be consumed and
      // the retry submit will fail with tx_bad_seq — which is
      // exactly the safety property we wanted.
      await new Promise((r) => setTimeout(r, PAY_VIA_CONTRACT_RETRY_DELAY_MS));
    }
  }
  // Unreachable — the loop either returns on success or throws on
  // failure inside the catch. Fall-through exists only to satisfy the
  // TS return-type checker.
  throw lastErr ?? new Error('payViaContractOWS: retry loop exited without result');
}

// Back-compat aliases for the old exported names.

/** @deprecated Use `payViaContractOWS` — the old direct-Stellar path no longer matches the backend. */
export const payVCCOWS = payViaContractOWS;
/** @deprecated Kept for one migration cycle. */
export type PayVCCOwsOpts = PayViaContractOwsOpts;

// ── All-in-one ────────────────────────────────────────────────────────────────

export interface PurchaseCardOwsOpts {
  apiKey: string;
  walletName: string;
  amountUsdc: string;
  paymentAsset?: 'usdc' | 'xlm';
  passphrase?: string;
  vaultPath?: string;
  baseUrl?: string;
  networkPassphrase?: string;
  /**
   * Resume an existing order instead of creating a new one. Three shapes:
   *
   *   - bare string              — wait for the backend to finish an
   *                                in-flight payment. Conservative
   *                                default when we have no context.
   *
   *   - { orderId, payment }     — caller has rebuilt the payment
   *                                instructions (e.g. from a cached
   *                                order response) and wants to
   *                                resubmit.
   *
   *   - { orderId, txHash,       — caller has the txHash from a prior
   *       phase }                  ResumableError. purchaseCardOWS
   *                                checks whether that tx landed on
   *                                the ledger and, if not, re-fetches
   *                                the order's payment instructions
   *                                from the backend and resubmits.
   *                                This is the shape saved to
   *                                ~/.stellar_card/last-order so the CLI
   *                                --resume flow recovers cleanly
   *                                from a dropped Soroban submit.
   */
  resume?:
    | string
    | {
        orderId: string;
        payment?: PaymentInstructions;
        txHash?: string;
        phase?: 'unpaid' | 'paid';
      };
  /** Override the Soroban RPC URL used during contract submission. */
  sorobanRpcUrl?: string;
  /** Override the Horizon REST API URL used during contract submission. */
  horizonUrl?: string;
  /** Tune the card-ready poll. Default: { timeoutMs: 300_000, intervalMs: 3_000 }. */
  waitForCardOpts?: { timeoutMs?: number; intervalMs?: number };
}

/**
 * Full purchase flow using an OWS wallet: create order → pay the receiver
 * contract on Stellar → wait for card. Any failure after the order exists
 * is wrapped as a ResumableError so the caller can retry via `--resume`
 * without minting a new order.
 *
 * Soroban RPC backpressure is tolerated: if submitSorobanTx throws with a
 * txHash attached (deadline reached but tx may still land), we proceed to
 * waitForCard — the stellar_card backend watcher is the source of truth and
 * will credit the order when the tx finalizes.
 * @param opts - Options including API key, wallet name, payment amounts, and resumption state.
 * @returns Object containing the issued `CardDetails` and the `order_id`.
 */
export async function purchaseCardOWS(
  opts: PurchaseCardOwsOpts,
): Promise<CardDetails & { order_id: string }> {
  const { Stellar_CardClient } = await import('./client');
  const client = new Stellar_CardClient({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  const paymentAsset = opts.paymentAsset ?? 'usdc';

  let orderId: string;
  let payment: PaymentInstructions | undefined;
  let skipPayment = false;

  if (opts.resume) {
    let priorTxHash: string | undefined;
    let priorPhase: 'unpaid' | 'paid' | undefined;
    if (typeof opts.resume === 'string') {
      orderId = opts.resume;
    } else {
      orderId = opts.resume.orderId;
      payment = opts.resume.payment;
      priorTxHash = opts.resume.txHash;
      priorPhase = opts.resume.phase;
    }
    // Check where the order is — if the payment already landed (or is
    // landing), we can skip straight to waitForCard.
    const status = await client.getOrder(orderId);
    if (status.phase === 'ready' && status.card) {
      return { ...status.card, order_id: orderId };
    }
    if (
      status.phase === 'failed' ||
      status.phase === 'refunded' ||
      status.phase === 'rejected' ||
      status.phase === 'expired'
    ) {
      throw new OrderFailedError(orderId, status.error ?? status.phase, status.refund);
    }
    if (status.phase !== 'awaiting_payment') {
      // processing / awaiting_approval — backend is working, just wait.
      skipPayment = true;
    } else if (payment) {
      // Caller handed in a fresh payment object — resubmit.
      // skipPayment stays false; fall through.
    } else if (priorTxHash && priorPhase === 'unpaid') {
      // F1-resume fix: we have a captured tx hash from a prior
      // ResumableError where the client never saw the tx land. Check
      // Horizon ONE MORE TIME to see if it's materialized since the
      // error fired — Soroban RPCs occasionally report NOT_FOUND
      // briefly past the 120s inclusion window before the tx shows
      // up. If Horizon still doesn't know about it, call it dropped
      // and rebuild the payment from the order's persisted
      // instructions (the backend returns `payment` on the order
      // response for pending_payment orders) so we can resubmit
      // instead of defaulting to a 5-minute waitForCard hang.
      const landed = await checkSorobanTxLanded(priorTxHash);
      if (landed === 'landed') {
        // Tx is on the ledger — backend will see the Soroban event
        // any second. Wait.
        skipPayment = true;
      } else if (landed === 'dropped' && status.payment) {
        // Dropped pre-apply. Rebuild payment from the backend's
        // view of the order (which includes the original Soroban
        // contract invocation parameters) and re-submit.
        payment = status.payment;
        // skipPayment stays false — fall through to the submit path.
      } else {
        // Still pending, or we couldn't tell. Be conservative and
        // wait — resubmitting a tx that's actually still in the
        // mempool would double-pay if both eventually land.
        skipPayment = true;
      }
    } else {
      // No prior tx context (either bare-string resume, or the
      // saved state had no txHash). Conservative wait.
      skipPayment = true;
    }
  } else {
    const order = await client.createOrder({ amount_usdc: opts.amountUsdc });
    orderId = order.order_id;
    payment = order.payment;
  }

  if (!skipPayment) {
    if (!payment) {
      // Unreachable: the resume branch sets skipPayment when payment is
      // missing, and the create branch always sets payment.
      throw new ResumableError(
        orderId,
        'internal: payment instructions missing for an unpaid order',
        'unpaid',
      );
    }

    // USDC payments need a trustline on the wallet's Stellar account. If the
    // agent is paying in USDC and never added one, add it now so the
    // purchase doesn't silently fail on the payment step.
    if (paymentAsset === 'usdc') {
      try {
        const bal = await getOWSBalance(opts.walletName, opts.vaultPath);
        if (bal.usdc === '0') {
          const publicKey = getOWSPublicKey(opts.walletName, opts.vaultPath);
          const server = new Horizon.Server(getHorizonUrl(opts.networkPassphrase));
          const account = await withTimeout(server.loadAccount(publicKey));
          const hasTrustline = account.balances.some(
            (b) =>
              b.asset_type === 'credit_alphanum4' &&
              b.asset_code === 'USDC' &&
              b.asset_issuer === USDC_ISSUER,
          );
          if (!hasTrustline) {
            await addUsdcTrustlineOWS({
              walletName: opts.walletName,
              passphrase: opts.passphrase,
              vaultPath: opts.vaultPath,
              networkPassphrase: opts.networkPassphrase,
            });
          }
        }
      } catch (err) {
        throw new ResumableError(
          orderId,
          `failed to ensure USDC trustline: ${err instanceof Error ? err.message : String(err)}. The wallet needs at least 2 XLM (1 for the account reserve, 1 for the trustline)`,
          'unpaid',
          undefined,
          err,
        );
      }
    }

    try {
      await payViaContractOWS({
        walletName: opts.walletName,
        payment,
        paymentAsset,
        passphrase: opts.passphrase,
        vaultPath: opts.vaultPath,
        networkPassphrase: opts.networkPassphrase,
        sorobanRpcUrl: opts.sorobanRpcUrl,
        horizonUrl: opts.horizonUrl,
      });
    } catch (err) {
      // submitSorobanTx attaches `txHash` to its error when the envelope
      // has been accepted onto the network but we gave up waiting for
      // finalization. The DISPOSITION of that hash matters:
      //
      //   - dropped: true    → payViaContractOWS exhausted its retry
      //                        budget on a provably-dropped tx. There
      //                        is no in-mempool tx to wait for, and
      //                        waitForCard would hang the full timeout.
      //                        Surface as ResumableError('unpaid') so
      //                        the CLI can save the saved state and
      //                        the next --resume run can try again.
      //
      //   - dropped: false / — envelope may still land (e.g. Horizon
      //     absent          unreachable, couldn't confirm either way).
      //                        Fall through to waitForCard so the
      //                        backend watcher has a chance to credit
      //                        the order if the tx finalizes.
      //
      //   - no txHash        → submit never reached a known hash (pre-
      //                        simulation failure, trustline add error,
      //                        etc.). Resumable as 'unpaid'.
      const errWithHash = err as Error & { txHash?: string; dropped?: boolean };
      const hasHash = typeof errWithHash.txHash === 'string';
      const dropped = errWithHash.dropped === true;
      if (!hasHash || dropped) {
        throw new ResumableError(
          orderId,
          err instanceof Error ? err.message : String(err),
          'unpaid',
          errWithHash.txHash,
          err,
        );
      }
      // hasHash && !dropped — envelope may still land. Fall through.
    }
  }

  try {
    const card = await client.waitForCard(orderId, opts.waitForCardOpts);
    return { ...card, order_id: orderId };
  } catch (err) {
    // OrderFailedError is terminal — propagate unchanged so the CLI
    // surfaces the real reason instead of a misleading resume hint.
    if (err instanceof OrderFailedError) throw err;
    // Auth / budget / validation errors from the client are also terminal.
    if (err instanceof Stellar_CardError && err.code !== 'wait_timeout') throw err;
    // Everything else (network blip, SSE disconnect, wait_timeout) — wrap
    // as resumable. The order is paid at this point; resuming will just
    // re-attach to the stream.
    throw new ResumableError(
      orderId,
      err instanceof Error ? err.message : String(err),
      'paid',
      undefined,
      err,
    );
  }
}

// ── Secure Keystore Integration (#705) ──────────────────────────────────────

export { createKeystore, NodeFileSystemKeystore, BrowserKeystore } from './keystore';
export type { EncryptedKeystore } from './keystore';

/**
 * Persist an encrypted Stellar wallet secret using a cross-platform keystore adapter.
 *
 * @param walletName - Wallet identifier
 * @param stellarSecret - Secret key (S...) to store
 * @param passphrase - User passphrase to encrypt the secret
 * @param keystore - Optional keystore adapter (defaults to auto-detected environment keystore)
 */
export async function saveWalletToKeystore(
  walletName: string,
  stellarSecret: string,
  passphrase: string,
  keystore?: import('./keystore').EncryptedKeystore,
): Promise<void> {
  const { createKeystore } = await import('./keystore');
  const store = keystore ?? createKeystore();
  await store.set(walletName, stellarSecret, passphrase);
}

/**
 * Load and decrypt a Stellar wallet secret from a keystore adapter.
 *
 * @param walletName - Wallet identifier
 * @param passphrase - User passphrase to decrypt the secret
 * @param keystore - Optional keystore adapter (defaults to auto-detected environment keystore)
 * @returns Decrypted Stellar secret key or null if not found
 */
export async function loadWalletFromKeystore(
  walletName: string,
  passphrase: string,
  keystore?: import('./keystore').EncryptedKeystore,
): Promise<string | null> {
  const { createKeystore } = await import('./keystore');
  const store = keystore ?? createKeystore();
  return store.get(walletName, passphrase);
}

