// Unit tests for the Ledger hardware signer abstraction (#743).
//
// IMPORTANT: everything here runs against a MOCKED Ledger transport and a
// mocked Stellar Ledger app client (shaped like @ledgerhq/hw-transport-webusb
// and @ledgerhq/hw-app-str's documented public API). None of this has been
// exercised against real Ledger hardware — see src/hardware.ts's module
// doc comment for the full disclosure of this testing limitation.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Account,
  Asset,
} from '@stellar/stellar-sdk';
import {
  createLedgerStellarSigner,
  createWebUsbTransport,
  LedgerSignerError,
  STELLAR_LEDGER_DERIVATION_PATH,
  type LedgerTransport,
  type StellarLedgerApi,
} from '../hardware';

function buildUnsignedTx(sourceKeypair: Keypair) {
  const account = new Account(sourceKeypair.publicKey(), '1');
  return new TransactionBuilder(account, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '10',
      }),
    )
    .setTimeout(300)
    .build();
}

function mockTransport(): LedgerTransport & { close: ReturnType<typeof vi.fn> } {
  return { close: vi.fn().mockResolvedValue(undefined) };
}

function mockApp(overrides?: Partial<StellarLedgerApi>): StellarLedgerApi {
  return {
    getPublicKey: vi.fn(),
    signTransaction: vi.fn(),
    ...overrides,
  };
}

describe('createLedgerStellarSigner — derivation path', () => {
  it('uses the Stellar BIP-44 derivation path for account 0', async () => {
    const signerKeypair = Keypair.random();
    const transport = mockTransport();
    const app = mockApp({
      getPublicKey: vi.fn().mockResolvedValue({ publicKey: signerKeypair.publicKey() }),
    });
    const signer = createLedgerStellarSigner({ transport, app });
    await signer.getPublicKey();
    expect(app.getPublicKey).toHaveBeenCalledWith(STELLAR_LEDGER_DERIVATION_PATH, undefined);
  });

  it('derives a per-account path when accountIndex is passed', async () => {
    const signerKeypair = Keypair.random();
    const transport = mockTransport();
    const app = mockApp({
      getPublicKey: vi.fn().mockResolvedValue({ publicKey: signerKeypair.publicKey() }),
    });
    const signer = createLedgerStellarSigner({ transport, app, accountIndex: 3 });
    await signer.getPublicKey();
    expect(app.getPublicKey).toHaveBeenCalledWith("44'/148'/3'", undefined);
  });
});

describe('createLedgerStellarSigner — getPublicKey', () => {
  it('returns the G-address from the device', async () => {
    const signerKeypair = Keypair.random();
    const transport = mockTransport();
    const app = mockApp({
      getPublicKey: vi.fn().mockResolvedValue({ publicKey: signerKeypair.publicKey() }),
    });
    const signer = createLedgerStellarSigner({ transport, app });
    const address = await signer.getPublicKey();
    expect(address).toBe(signerKeypair.publicKey());
  });

  it('forwards the display flag so the device shows the address for confirmation', async () => {
    const signerKeypair = Keypair.random();
    const transport = mockTransport();
    const app = mockApp({
      getPublicKey: vi.fn().mockResolvedValue({ publicKey: signerKeypair.publicKey() }),
    });
    const signer = createLedgerStellarSigner({ transport, app });
    await signer.getPublicKey({ display: true });
    expect(app.getPublicKey).toHaveBeenCalledWith(STELLAR_LEDGER_DERIVATION_PATH, true);
  });
});

describe('createLedgerStellarSigner — signTransaction', () => {
  let signerKeypair: Keypair;

  beforeEach(() => {
    signerKeypair = Keypair.random();
  });

  it('signs the transaction and appends a decorated signature', async () => {
    const tx = buildUnsignedTx(signerKeypair);
    const transport = mockTransport();
    const rawSig = signerKeypair.sign(tx.signatureBase());
    const app = mockApp({
      getPublicKey: vi.fn().mockResolvedValue({ publicKey: signerKeypair.publicKey() }),
      signTransaction: vi.fn().mockResolvedValue({ signature: rawSig }),
    });
    const signer = createLedgerStellarSigner({ transport, app });

    expect(tx.signatures).toHaveLength(0);
    const signed = await signer.signTransaction(tx);
    expect(signed.signatures).toHaveLength(1);
    expect(app.signTransaction).toHaveBeenCalledWith(
      STELLAR_LEDGER_DERIVATION_PATH,
      tx.signatureBase(),
    );
  });

  it('produces a signature that verifies against the signer public key', async () => {
    const tx = buildUnsignedTx(signerKeypair);
    const transport = mockTransport();
    const rawSig = signerKeypair.sign(tx.signatureBase());
    const app = mockApp({
      getPublicKey: vi.fn().mockResolvedValue({ publicKey: signerKeypair.publicKey() }),
      signTransaction: vi.fn().mockResolvedValue({ signature: rawSig }),
    });
    const signer = createLedgerStellarSigner({ transport, app });
    const signed = await signer.signTransaction(tx);

    const decorated = signed.signatures[0]!;
    const valid = signerKeypair.verify(tx.signatureBase(), decorated.signature());
    expect(valid).toBe(true);
  });

  it('throws a typed user_rejected error when the device declines', async () => {
    const tx = buildUnsignedTx(signerKeypair);
    const transport = mockTransport();
    const app = mockApp({
      getPublicKey: vi.fn().mockResolvedValue({ publicKey: signerKeypair.publicKey() }),
      signTransaction: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('Condition of use not satisfied'), { statusCode: 0x6985 }),
        ),
    });
    const signer = createLedgerStellarSigner({ transport, app });

    await expect(signer.signTransaction(tx)).rejects.toMatchObject({
      name: 'LedgerSignerError',
      reason: 'user_rejected',
    });
  });

  it('throws a typed device_locked error when the device is locked', async () => {
    const tx = buildUnsignedTx(signerKeypair);
    const transport = mockTransport();
    const app = mockApp({
      getPublicKey: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('Device is locked'), { statusCode: 0x5515 })),
    });
    const signer = createLedgerStellarSigner({ transport, app });

    await expect(signer.signTransaction(tx)).rejects.toMatchObject({
      name: 'LedgerSignerError',
      reason: 'device_locked',
    });
  });

  it('throws a typed wrong_app error when the Stellar app is not open', async () => {
    const tx = buildUnsignedTx(signerKeypair);
    const transport = mockTransport();
    const app = mockApp({
      getPublicKey: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('wrong app'), { statusCode: 0x6a80 })),
    });
    const signer = createLedgerStellarSigner({ transport, app });

    await expect(signer.signTransaction(tx)).rejects.toMatchObject({
      name: 'LedgerSignerError',
      reason: 'wrong_app',
    });
  });

  it('throws a typed device_not_connected error when no device is found', async () => {
    const tx = buildUnsignedTx(signerKeypair);
    const transport = mockTransport();
    const app = mockApp({
      getPublicKey: vi.fn().mockRejectedValue(new Error('No device found')),
    });
    const signer = createLedgerStellarSigner({ transport, app });

    await expect(signer.signTransaction(tx)).rejects.toMatchObject({
      name: 'LedgerSignerError',
      reason: 'device_not_connected',
    });
  });

  it('times out distinctly from other error cases when the device never responds', async () => {
    const tx = buildUnsignedTx(signerKeypair);
    const transport = mockTransport();
    const app = mockApp({
      // Never resolves — simulates a user who walked away from the device.
      getPublicKey: vi.fn(() => new Promise(() => {})),
    });
    const signer = createLedgerStellarSigner({ transport, app, timeoutMs: 20 });

    await expect(signer.signTransaction(tx)).rejects.toMatchObject({
      name: 'LedgerSignerError',
      reason: 'timeout',
    });
  });

  it('falls back to a generic transport_error for unrecognized failures', async () => {
    const tx = buildUnsignedTx(signerKeypair);
    const transport = mockTransport();
    const app = mockApp({
      getPublicKey: vi.fn().mockRejectedValue(new Error('something unexpected happened')),
    });
    const signer = createLedgerStellarSigner({ transport, app });

    await expect(signer.signTransaction(tx)).rejects.toMatchObject({
      name: 'LedgerSignerError',
      reason: 'transport_error',
    });
  });
});

describe('createLedgerStellarSigner — disconnect', () => {
  it('closes the underlying transport', async () => {
    const transport = mockTransport();
    const app = mockApp();
    const signer = createLedgerStellarSigner({ transport, app });
    await signer.disconnect();
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it('wraps a transport close failure as a typed LedgerSignerError', async () => {
    const transport = mockTransport();
    transport.close.mockRejectedValue(new Error('usb disconnect failed'));
    const app = mockApp();
    const signer = createLedgerStellarSigner({ transport, app });
    await expect(signer.disconnect()).rejects.toBeInstanceOf(LedgerSignerError);
  });
});

describe('createWebUsbTransport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws unsupported_environment when navigator.usb is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const factory = vi.fn();
    await expect(createWebUsbTransport(factory)).rejects.toMatchObject({
      name: 'LedgerSignerError',
      reason: 'unsupported_environment',
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it('opens the transport via the factory when WebUSB is available', async () => {
    vi.stubGlobal('navigator', { usb: {} });
    const transport = mockTransport();
    const factory = vi.fn().mockResolvedValue(transport);
    const result = await createWebUsbTransport(factory);
    expect(result).toBe(transport);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('wraps a factory rejection as a typed LedgerSignerError', async () => {
    vi.stubGlobal('navigator', { usb: {} });
    const factory = vi.fn().mockRejectedValue(new Error('no device found'));
    await expect(createWebUsbTransport(factory)).rejects.toMatchObject({
      name: 'LedgerSignerError',
      reason: 'device_not_connected',
    });
  });
});
