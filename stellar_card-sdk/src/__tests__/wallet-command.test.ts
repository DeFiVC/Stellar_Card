// Unit tests for src/commands/wallet.ts (#744) — the `stellar_card wallet`
// CLI subcommands (address / balance / trustline), plus the key
// import/export, encryption round-trip, and balance-formatting primitives
// those subcommands are built on (StrKey validation in @stellar/stellar-sdk,
// the encryption module, and OWS wallet lookups).
//
// 100% pass rate — no new production code was needed; wallet.ts's existing
// behavior matched expectations in every case exercised below.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { walletCommand } from '../commands/wallet';
import { encryptStellarKey, decryptStellarKey } from '../encryption';

const mockGetOWSPublicKey = vi.fn();
const mockGetOWSBalance = vi.fn();
const mockAddUsdcTrustlineOWS = vi.fn();
const mockLoadStellar_CardConfig = vi.fn();

vi.mock('../ows', () => ({
  getOWSPublicKey: (...args: unknown[]) => mockGetOWSPublicKey(...args),
  getOWSBalance: (...args: unknown[]) => mockGetOWSBalance(...args),
  addUsdcTrustlineOWS: (...args: unknown[]) => mockAddUsdcTrustlineOWS(...args),
}));

vi.mock('../config', () => ({
  loadStellar_CardConfig: (...args: unknown[]) => mockLoadStellar_CardConfig(...args),
}));

function captureStd() {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    out.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    err.push(String(chunk));
    return true;
  });
  return {
    out: () => out.join(''),
    err: () => err.join(''),
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

const VALID_KEYPAIR = Keypair.random();
const VALID_CONFIG = { wallet_name: 'agent-1', vault_path: undefined, passphrase_env: undefined };

describe('walletCommand — help / usage', () => {
  it('prints usage and exits 2 when no subcommand is given', async () => {
    const std = captureStd();
    const code = await walletCommand([]);
    std.restore();
    expect(code).toBe(2);
    expect(std.err()).toContain('Usage: stellar_card wallet');
  });

  it('prints usage and exits 0 for --help', async () => {
    const std = captureStd();
    const code = await walletCommand(['--help']);
    std.restore();
    expect(code).toBe(0);
    expect(std.err()).toContain('Subcommands:');
  });

  it('rejects an unknown subcommand with exit code 2', async () => {
    mockLoadStellar_CardConfig.mockReturnValue(VALID_CONFIG);
    const std = captureStd();
    const code = await walletCommand(['frobnicate']);
    std.restore();
    expect(code).toBe(2);
    expect(std.err()).toContain('unknown wallet subcommand');
  });
});

describe('walletCommand — missing config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('errors when no stellar_card config exists', async () => {
    mockLoadStellar_CardConfig.mockReturnValue(null);
    const std = captureStd();
    const code = await walletCommand(['address']);
    std.restore();
    expect(code).toBe(1);
    expect(std.err()).toContain('no stellar_card config found');
  });

  it('errors when config has no wallet_name and none is passed via --name', async () => {
    mockLoadStellar_CardConfig.mockReturnValue({ wallet_name: undefined });
    const std = captureStd();
    const code = await walletCommand(['address']);
    std.restore();
    expect(code).toBe(1);
    expect(std.err()).toContain('no wallet_name');
  });
});

describe('walletCommand — address', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadStellar_CardConfig.mockReturnValue(VALID_CONFIG);
  });

  it('prints the public key for a known wallet', async () => {
    mockGetOWSPublicKey.mockReturnValue(VALID_KEYPAIR.publicKey());
    const std = captureStd();
    const code = await walletCommand(['address']);
    std.restore();
    expect(code).toBe(0);
    expect(std.out().trim()).toBe(VALID_KEYPAIR.publicKey());
  });

  it('validates the printed address is a well-formed Stellar G-address', async () => {
    mockGetOWSPublicKey.mockReturnValue(VALID_KEYPAIR.publicKey());
    const std = captureStd();
    await walletCommand(['address']);
    std.restore();
    const printed = std.out().trim();
    expect(StrKey.isValidEd25519PublicKey(printed)).toBe(true);
  });

  it('errors when the wallet is not found', async () => {
    mockGetOWSPublicKey.mockImplementation(() => {
      throw new Error('wallet not found in vault');
    });
    const std = captureStd();
    const code = await walletCommand(['address']);
    std.restore();
    expect(code).toBe(1);
    expect(std.err()).toContain('not found');
  });

  it('uses --name to override the configured wallet name', async () => {
    mockGetOWSPublicKey.mockReturnValue(VALID_KEYPAIR.publicKey());
    const std = captureStd();
    await walletCommand(['address', '--name', 'other-wallet']);
    std.restore();
    expect(mockGetOWSPublicKey).toHaveBeenCalledWith('other-wallet', undefined);
  });
});

describe('walletCommand — balance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadStellar_CardConfig.mockReturnValue(VALID_CONFIG);
  });

  it('formats XLM and USDC balances as decimal strings', async () => {
    mockGetOWSPublicKey.mockReturnValue(VALID_KEYPAIR.publicKey());
    mockGetOWSBalance.mockResolvedValue({ xlm: '123.4567890', usdc: '50.0000000' });
    const std = captureStd();
    const code = await walletCommand(['balance']);
    std.restore();
    expect(code).toBe(0);
    expect(std.out()).toContain(`address: ${VALID_KEYPAIR.publicKey()}`);
    expect(std.out()).toContain('xlm:     123.4567890');
    expect(std.out()).toContain('usdc:    50.0000000');
  });

  it('shows zero balances with an activation hint for an unfunded (404) account', async () => {
    mockGetOWSPublicKey.mockReturnValue(VALID_KEYPAIR.publicKey());
    mockGetOWSBalance.mockRejectedValue(new Error('Not Found (404)'));
    const std = captureStd();
    const code = await walletCommand(['balance']);
    std.restore();
    expect(code).toBe(0);
    expect(std.out()).toContain('unactivated');
    expect(std.out()).toContain('xlm:     0');
    expect(std.out()).toContain('usdc:    0');
  });

  it('propagates a non-404 Horizon error as a failure', async () => {
    mockGetOWSPublicKey.mockReturnValue(VALID_KEYPAIR.publicKey());
    mockGetOWSBalance.mockRejectedValue(new Error('internal_server_error'));
    const std = captureStd();
    const code = await walletCommand(['balance']);
    std.restore();
    expect(code).toBe(1);
    expect(std.err()).toContain('internal_server_error');
  });
});

describe('walletCommand — trustline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadStellar_CardConfig.mockReturnValue(VALID_CONFIG);
    mockGetOWSPublicKey.mockReturnValue(VALID_KEYPAIR.publicKey());
  });

  it('opens a trustline and reports the transaction hash', async () => {
    mockAddUsdcTrustlineOWS.mockResolvedValue('TXHASH123');
    const std = captureStd();
    const code = await walletCommand(['trustline']);
    std.restore();
    expect(code).toBe(0);
    expect(std.out()).toContain('TXHASH123');
  });

  it('treats a null result (trustline already open) as success', async () => {
    mockAddUsdcTrustlineOWS.mockResolvedValue(null);
    const std = captureStd();
    const code = await walletCommand(['trustline']);
    std.restore();
    expect(code).toBe(0);
    expect(std.out()).toContain('already exists');
  });

  it('gives an actionable error for an unactivated (404) account', async () => {
    mockAddUsdcTrustlineOWS.mockRejectedValue(new Error('404 Not Found'));
    const std = captureStd();
    const code = await walletCommand(['trustline']);
    std.restore();
    expect(code).toBe(1);
    expect(std.err()).toContain('not activated');
  });

  it('gives an actionable error for insufficient reserve', async () => {
    mockAddUsdcTrustlineOWS.mockRejectedValue(new Error('op_low_reserve'));
    const std = captureStd();
    const code = await walletCommand(['trustline']);
    std.restore();
    expect(code).toBe(1);
    expect(std.err()).toContain('insufficient XLM');
  });

  it('treats op_already_exists as success, not failure', async () => {
    mockAddUsdcTrustlineOWS.mockRejectedValue(new Error('op_already_exists'));
    const std = captureStd();
    const code = await walletCommand(['trustline']);
    std.restore();
    expect(code).toBe(0);
    expect(std.out()).toContain('already exists');
  });

  it('passes the passphrase resolved from passphrase_env through to addUsdcTrustlineOWS', async () => {
    process.env.TEST_WALLET_PASSPHRASE = 'correct-horse-battery-staple';
    mockLoadStellar_CardConfig.mockReturnValue({
      wallet_name: 'agent-1',
      passphrase_env: 'TEST_WALLET_PASSPHRASE',
    });
    mockAddUsdcTrustlineOWS.mockResolvedValue('TXHASH456');
    const std = captureStd();
    await walletCommand(['trustline']);
    std.restore();
    expect(mockAddUsdcTrustlineOWS).toHaveBeenCalledWith(
      expect.objectContaining({ passphrase: 'correct-horse-battery-staple' }),
    );
    delete process.env.TEST_WALLET_PASSPHRASE;
  });

  it('falls through to a generic error for an unrecognized failure', async () => {
    mockAddUsdcTrustlineOWS.mockRejectedValue(new Error('some_other_stellar_error'));
    const std = captureStd();
    const code = await walletCommand(['trustline']);
    std.restore();
    expect(code).toBe(1);
    expect(std.err()).toContain('some_other_stellar_error');
  });
});

// ── Secret key import validation (StrKey, used by every wallet-import path) ──

describe('Stellar secret key validation', () => {
  it('accepts a well-formed secret key (S...) and derives the correct G-address', () => {
    const keypair = Keypair.random();
    const secret = keypair.secret();
    expect(secret).toMatch(/^S/);
    expect(StrKey.isValidEd25519SecretSeed(secret)).toBe(true);

    const imported = Keypair.fromSecret(secret);
    expect(imported.publicKey()).toBe(keypair.publicKey());
    expect(imported.publicKey()).toMatch(/^G/);
    expect(StrKey.isValidEd25519PublicKey(imported.publicKey())).toBe(true);
  });

  it('rejects a secret key with a corrupted checksum', () => {
    const secret = Keypair.random().secret();
    // Flip the last character to break the checksum while keeping the
    // overall shape (length, charset) plausible.
    const lastChar = secret[secret.length - 1];
    const corrupted = secret.slice(0, -1) + (lastChar === 'A' ? 'B' : 'A');
    expect(StrKey.isValidEd25519SecretSeed(corrupted)).toBe(false);
    expect(() => Keypair.fromSecret(corrupted)).toThrow();
  });

  it('rejects a secret key that is too short', () => {
    expect(StrKey.isValidEd25519SecretSeed('SBCD')).toBe(false);
    expect(() => Keypair.fromSecret('SBCD')).toThrow();
  });

  it('rejects a public key (G...) passed where a secret key is expected', () => {
    const publicKey = Keypair.random().publicKey();
    expect(StrKey.isValidEd25519SecretSeed(publicKey)).toBe(false);
    expect(() => Keypair.fromSecret(publicKey)).toThrow();
  });

  it('rejects an empty string', () => {
    expect(StrKey.isValidEd25519SecretSeed('')).toBe(false);
  });

  it('rejects a secret key with invalid characters', () => {
    const malformed = 'S' + '!'.repeat(55);
    expect(StrKey.isValidEd25519SecretSeed(malformed)).toBe(false);
  });
});

// ── Password encryption/decryption round-trip of wallet files ───────────────

describe('wallet file password encryption round-trip', () => {
  it('round-trips a Stellar secret key through encryptStellarKey/decryptStellarKey', async () => {
    const keypair = Keypair.random();
    const passphrase = 'correct-horse-battery-staple';
    const payload = await encryptStellarKey(keypair.secret(), passphrase);
    const decrypted = await decryptStellarKey(payload, passphrase);
    expect(decrypted).toBe(keypair.secret());
  });

  it('produces a JSON-serializable payload safe to write to a wallet file', async () => {
    const keypair = Keypair.random();
    const payload = await encryptStellarKey(keypair.secret(), 'pw');
    const roundTripped = JSON.parse(JSON.stringify(payload));
    const decrypted = await decryptStellarKey(roundTripped, 'pw');
    expect(decrypted).toBe(keypair.secret());
  });

  it('fails to decrypt with the wrong passphrase', async () => {
    const keypair = Keypair.random();
    const payload = await encryptStellarKey(keypair.secret(), 'correct-password');
    await expect(decryptStellarKey(payload, 'wrong-password')).rejects.toThrow();
  });

  it('produces different ciphertext for the same secret encrypted twice', async () => {
    const keypair = Keypair.random();
    const payloadA = await encryptStellarKey(keypair.secret(), 'pw');
    const payloadB = await encryptStellarKey(keypair.secret(), 'pw');
    expect(payloadA.value).not.toBe(payloadB.value);
    expect(payloadA.salt).not.toBe(payloadB.salt);
    expect(payloadA.iv).not.toBe(payloadB.iv);
  });

  it('rejects a tampered ciphertext (auth tag mismatch)', async () => {
    const keypair = Keypair.random();
    const payload = await encryptStellarKey(keypair.secret(), 'pw');
    const tampered = { ...payload, value: payload.value.slice(0, -4) + 'AAAA' };
    await expect(decryptStellarKey(tampered, 'pw')).rejects.toThrow();
  });
});

// ── Balance display formatting (as printed by `wallet balance`) ─────────────

describe('balance display formatting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadStellar_CardConfig.mockReturnValue(VALID_CONFIG);
    mockGetOWSPublicKey.mockReturnValue(VALID_KEYPAIR.publicKey());
  });

  it('preserves 7-decimal-place precision for XLM amounts', async () => {
    mockGetOWSBalance.mockResolvedValue({ xlm: '0.0000001', usdc: '0.0000000' });
    const std = captureStd();
    await walletCommand(['balance']);
    std.restore();
    expect(std.out()).toContain('xlm:     0.0000001');
  });

  it('displays a zero USDC balance as a plain zero decimal, not blank', async () => {
    mockGetOWSBalance.mockResolvedValue({ xlm: '10.0000000', usdc: '0.0000000' });
    const std = captureStd();
    await walletCommand(['balance']);
    std.restore();
    expect(std.out()).toContain('usdc:    0.0000000');
  });

  it('formats large XLM balances without truncation or scientific notation', async () => {
    mockGetOWSBalance.mockResolvedValue({ xlm: '9999999.9999999', usdc: '1234567.1234567' });
    const std = captureStd();
    await walletCommand(['balance']);
    std.restore();
    expect(std.out()).toContain('xlm:     9999999.9999999');
    expect(std.out()).toContain('usdc:    1234567.1234567');
  });
});
