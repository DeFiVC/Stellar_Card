/**
 * Hardware wallet (Ledger) signing support over WebUSB/HID (#743).
 *
 * Provides a `LedgerStellarSigner` abstraction for signing Stellar/Soroban
 * transactions with a Ledger hardware device, following the BIP-44
 * derivation path for Stellar (`m/44'/148'/0'`).
 *
 * ## Implementation approach — IMPORTANT, read before use
 *
 * This module is built against the **documented public API surface** of
 * `@ledgerhq/hw-transport-webusb` and `@ledgerhq/hw-app-str` (the official
 * Ledger Stellar app client), via the minimal local interfaces below
 * ({@link LedgerTransport}, {@link StellarLedgerApi}). It does **not** add
 * either package as a runtime dependency, for two reasons:
 *
 * 1. This environment cannot exercise a real Ledger device (no WebUSB/HID
 *    host, no physical hardware), so a real dependency would be pure dead
 *    weight that this PR could not actually validate end-to-end.
 * 2. Keeping the Ledger SDK surface behind a small local interface means a
 *    consumer who *does* have `@ledgerhq/hw-app-str` installed can pass its
 *    real client straight into {@link createLedgerStellarSigner} — the
 *    shapes match the real library's `getPublicKey` / `signTransaction`
 *    methods — without this package needing to depend on it.
 *
 * Every test in `src/__tests__/hardware-signer.test.ts` runs against a
 * **mocked** transport/app pair that simulates the real libraries' call
 * signatures and error conditions. None of this has been exercised against
 * real Ledger hardware — treat the device-interaction code paths
 * (connect/disconnect, on-device confirmation, rejection, timeout) as
 * protocol-shaped but hardware-unverified.
 */

import { Keypair, Transaction, FeeBumpTransaction } from '@stellar/stellar-sdk';

/** BIP-44 derivation path Stellar uses for Ledger accounts: `m/44'/148'/0'`. */
export const STELLAR_LEDGER_DERIVATION_PATH = "44'/148'/0'";

/**
 * Minimal shape of a Ledger transport (matches
 * `@ledgerhq/hw-transport-webusb`'s `TransportWebUSB` static/instance API).
 * A real `TransportWebUSB` instance satisfies this interface structurally.
 */
export interface LedgerTransport {
  /** Close the underlying USB/HID connection. */
  close(): Promise<void>;
  /** Optional: true once the transport has been closed. */
  readonly deviceModel?: unknown;
}

/**
 * Minimal shape of the Ledger Stellar app client (matches
 * `@ledgerhq/hw-app-str`'s `Str` class). A real `Str` instance satisfies
 * this interface structurally.
 */
export interface StellarLedgerApi {
  /**
   * Fetch the public key for a BIP-44 derivation path.
   * @param path - e.g. `"44'/148'/0'"`.
   * @param display - When true, also show (and require confirmation of) the address on-device.
   */
  getPublicKey(path: string, display?: boolean): Promise<{ publicKey: string; raw?: Buffer }>;

  /**
   * Request the device to sign a transaction's signature base. The device
   * must show transaction details to the user and wait for physical
   * confirmation before returning.
   * @param path - BIP-44 derivation path of the signing key.
   * @param transactionSignatureBase - Raw bytes to sign (the transaction's signature payload).
   */
  signTransaction(path: string, transactionSignatureBase: Buffer): Promise<{ signature: Buffer }>;
}

/** Discriminated error reasons surfaced by {@link LedgerSignerError}. */
export type LedgerErrorReason =
  | 'device_not_connected'
  | 'device_locked'
  | 'wrong_app'
  | 'user_rejected'
  | 'timeout'
  | 'transport_error'
  | 'unsupported_environment';

/**
 * Typed error for Ledger hardware signer failures. Catch by `reason` so
 * callers can distinguish "please plug in your Ledger" from "user declined
 * on-device" without parsing error message strings.
 *
 * @example
 * ```typescript
 * try {
 *   await signer.signTransaction(tx);
 * } catch (err) {
 *   if (err instanceof LedgerSignerError && err.reason === 'user_rejected') {
 *     console.log('Signing cancelled on device.');
 *   }
 * }
 * ```
 */
export class LedgerSignerError extends Error {
  constructor(
    public readonly reason: LedgerErrorReason,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LedgerSignerError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Options for {@link createLedgerStellarSigner}. */
export interface LedgerStellarSignerOptions {
  /** Already-opened Ledger transport (e.g. a `TransportWebUSB` instance). */
  transport: LedgerTransport;
  /** Stellar Ledger app client bound to `transport` (e.g. a `Str` instance). */
  app: StellarLedgerApi;
  /**
   * BIP-44 account index appended to {@link STELLAR_LEDGER_DERIVATION_PATH}'s
   * parent, i.e. the derivation path used is `m/44'/148'/<accountIndex>'`.
   * Defaults to `0`, matching `m/44'/148'/0'`.
   */
  accountIndex?: number;
  /** Max time to wait for the user to approve/reject on-device, in ms. Defaults to 30000. */
  timeoutMs?: number;
}

/**
 * Public interface for a hardware-backed Stellar signer. Implemented by
 * {@link createLedgerStellarSigner}; also useful as the type agents code
 * against so a future non-Ledger hardware signer (e.g. Trezor) can be
 * swapped in without changing call sites.
 */
export interface LedgerStellarSigner {
  /** The signer's Stellar G-address, fetched from the device. */
  getPublicKey(options?: { display?: boolean }): Promise<string>;
  /**
   * Sign a built, unsigned transaction with the Ledger device. Prompts the
   * user on-device to review and confirm the transaction before signing.
   * @throws {LedgerSignerError} On device-connection failure, user rejection, or timeout.
   */
  signTransaction(tx: Transaction | FeeBumpTransaction): Promise<Transaction | FeeBumpTransaction>;
  /** Release the underlying transport connection. */
  disconnect(): Promise<void>;
}

function derivationPathFor(accountIndex: number): string {
  return `44'/148'/${accountIndex}'`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new LedgerSignerError('timeout', `Ledger device did not respond within ${ms}ms.`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Classify a raw error thrown by the Ledger transport/app layer into a typed {@link LedgerSignerError}. */
function classifyLedgerError(err: unknown): LedgerSignerError {
  if (err instanceof LedgerSignerError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  // Ledger device/app errors surface as either a numeric statusCode on the
  // thrown object (matching @ledgerhq/errors TransportStatusError), or as a
  // message substring — handle both so this works whether a real Ledger
  // library or our mock throws.
  const statusCode = (err as { statusCode?: number })?.statusCode;

  if (statusCode === 0x6985 || lower.includes('rejected') || lower.includes('denied')) {
    return new LedgerSignerError(
      'user_rejected',
      'Transaction was rejected on the Ledger device.',
      err,
    );
  }
  if (
    statusCode === 0x6a80 ||
    statusCode === 0x6b00 ||
    lower.includes('wrong app') ||
    lower.includes('6d00')
  ) {
    return new LedgerSignerError(
      'wrong_app',
      'Ledger device is not on the Stellar app. Open the Stellar app on the device and retry.',
      err,
    );
  }
  if (statusCode === 0x5515 || lower.includes('locked')) {
    return new LedgerSignerError(
      'device_locked',
      'Ledger device is locked. Unlock it and retry.',
      err,
    );
  }
  if (lower.includes('disconnect') || lower.includes('not found') || lower.includes('no device')) {
    return new LedgerSignerError(
      'device_not_connected',
      'No Ledger device found. Connect it via USB and unlock it.',
      err,
    );
  }
  return new LedgerSignerError('transport_error', `Ledger transport error: ${message}`, err);
}

/**
 * Create a {@link LedgerStellarSigner} backed by a Ledger hardware wallet
 * over an already-opened WebUSB/HID transport.
 *
 * The device displays the transaction's treasury destination, amount, and
 * asset for the user to visually verify before approving the signature —
 * this is the Stellar Ledger app's built-in behavior, not something this
 * SDK renders; this signer only forwards the signature-base bytes and
 * surfaces the device's approve/reject outcome.
 *
 * @param options - Transport/app clients, account index, and timeout.
 * @returns A {@link LedgerStellarSigner}.
 *
 * @example
 * ```typescript
 * import TransportWebUSB from '@ledgerhq/hw-transport-webusb';
 * import Str from '@ledgerhq/hw-app-str';
 *
 * const transport = await TransportWebUSB.create();
 * const app = new Str(transport);
 * const signer = createLedgerStellarSigner({ transport, app });
 *
 * const address = await signer.getPublicKey({ display: true });
 * const signedTx = await signer.signTransaction(unsignedTx);
 * ```
 */
export function createLedgerStellarSigner(
  options: LedgerStellarSignerOptions,
): LedgerStellarSigner {
  const { transport, app, accountIndex = 0, timeoutMs = 30000 } = options;
  const path = derivationPathFor(accountIndex);

  return {
    async getPublicKey(opts) {
      try {
        const { publicKey } = await withTimeout(app.getPublicKey(path, opts?.display), timeoutMs);
        return publicKey;
      } catch (err) {
        throw classifyLedgerError(err);
      }
    },

    async signTransaction(tx) {
      let signatureBase: Buffer;
      try {
        signatureBase = tx.signatureBase();
      } catch (err) {
        throw new LedgerSignerError(
          'transport_error',
          'Failed to compute transaction signature base.',
          err,
        );
      }

      let publicKey: string;
      let signature: Buffer;
      try {
        publicKey = (await withTimeout(app.getPublicKey(path), timeoutMs)).publicKey;
        const result = await withTimeout(app.signTransaction(path, signatureBase), timeoutMs);
        signature = result.signature;
      } catch (err) {
        throw classifyLedgerError(err);
      }

      const keypair = Keypair.fromPublicKey(publicKey);
      const hint = keypair.signatureHint();
      tx.signatures.push(
        new (await import('@stellar/stellar-sdk')).xdr.DecoratedSignature({
          hint,
          signature,
        }),
      );
      return tx;
    },

    async disconnect() {
      try {
        await transport.close();
      } catch (err) {
        throw classifyLedgerError(err);
      }
    },
  };
}

/**
 * Browser-compatible WebUSB transport adapter factory. Thin wrapper around
 * a caller-supplied `TransportWebUSB.create()`-shaped factory, so this SDK
 * doesn't need to depend on `@ledgerhq/hw-transport-webusb` directly while
 * still giving consumers a single call that validates WebUSB is available
 * before attempting a connection.
 *
 * @param factory - A function matching `TransportWebUSB.create` (or a
 *   mock of it in tests) that opens and returns a {@link LedgerTransport}.
 * @throws {LedgerSignerError} with reason `'unsupported_environment'` when
 *   WebUSB is not available (e.g. Node.js, or a browser without WebUSB support).
 *
 * @example
 * ```typescript
 * import TransportWebUSB from '@ledgerhq/hw-transport-webusb';
 * const transport = await createWebUsbTransport(() => TransportWebUSB.create());
 * ```
 */
export async function createWebUsbTransport(
  factory: () => Promise<LedgerTransport>,
): Promise<LedgerTransport> {
  const nav = (globalThis as { navigator?: { usb?: unknown } }).navigator;
  if (!nav || !nav.usb) {
    throw new LedgerSignerError(
      'unsupported_environment',
      'WebUSB is not available in this environment. Ledger signing requires a browser with WebUSB support (e.g. Chrome/Edge over HTTPS).',
    );
  }
  try {
    return await factory();
  } catch (err) {
    throw classifyLedgerError(err);
  }
}
