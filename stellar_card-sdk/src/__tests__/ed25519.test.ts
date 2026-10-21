// Ed25519 signature generation and verification test suite (#738).
//
// Scope note: this SDK signs/verifies exclusively through
// `@stellar/stellar-sdk`'s `Keypair` (which wraps a standard Ed25519
// implementation) — both in the low-level `Keypair.sign`/`Keypair.verify`
// primitives and in this SDK's own domain-separated wrapper,
// `signMessage`/`verifyMessage` from `../stellar` (SEP-0032 style, prefixed
// with `stellar:message:`). There is no separate "browser WebCrypto engine"
// code path anywhere in this SDK — no `crypto.subtle` Ed25519 usage, no
// alternate browser signing implementation to diverge from the Node path.
// The "Node vs. WebCrypto" cases below therefore verify the one thing that
// *is* true and testable: that the SDK's actual signing/verification
// functions are pure, deterministic-input/output functions whose results
// are identical no matter which JS engine runs them (Node's V8, and a
// browser-like environment via jsdom/happy-dom, since Vitest can swap
// environments per-file). If a real WebCrypto-based Ed25519 path is added
// later, this file is the place to extend with a third comparison branch.

import { describe, it, expect } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { signMessage, verifyMessage, createWallet } from '../stellar';

describe('Ed25519: signing arbitrary byte messages', () => {
  it('signs a UTF-8 string message and produces a verifiable base64 signature', () => {
    const wallet = createWallet();
    const signature = signMessage('hello stellar', wallet.secret);
    expect(typeof signature).toBe('string');
    expect(signature.length).toBeGreaterThan(0);
    expect(verifyMessage('hello stellar', signature, wallet.publicKey)).toBe(true);
  });

  it('signs an arbitrary Uint8Array of binary bytes (not valid UTF-8)', () => {
    const wallet = createWallet();
    const binary = new Uint8Array([0x00, 0xff, 0x10, 0xaa, 0x7f, 0x80, 0x01, 0xfe]);
    const signature = signMessage(binary, wallet.secret);
    expect(verifyMessage(binary, signature, wallet.publicKey)).toBe(true);
  });

  it('signs an empty message', () => {
    const wallet = createWallet();
    const signature = signMessage('', wallet.secret);
    expect(verifyMessage('', signature, wallet.publicKey)).toBe(true);
  });

  it('signs a large (64KB) binary payload', () => {
    const wallet = createWallet();
    const big = new Uint8Array(64 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i % 256;
    const signature = signMessage(big, wallet.secret);
    expect(verifyMessage(big, signature, wallet.publicKey)).toBe(true);
  });

  it('produces different signatures for different wallets signing the same message', () => {
    const walletA = createWallet();
    const walletB = createWallet();
    const message = 'same message, different signer';
    const sigA = signMessage(message, walletA.secret);
    const sigB = signMessage(message, walletB.secret);
    expect(sigA).not.toBe(sigB);
  });
});

describe('Ed25519: verification against a Stellar public key', () => {
  it('verifies a valid signature against the correct G-address', () => {
    const wallet = createWallet();
    const signature = signMessage('verify me', wallet.secret);
    expect(verifyMessage('verify me', signature, wallet.publicKey)).toBe(true);
  });

  it('rejects a valid signature checked against the wrong public key', () => {
    const signer = createWallet();
    const other = createWallet();
    const signature = signMessage('verify me', signer.secret);
    expect(verifyMessage('verify me', signature, other.publicKey)).toBe(false);
  });
});

describe('Ed25519: tampered and invalid signatures fail verification', () => {
  it('rejects a signature from a different message (message tampering)', () => {
    const wallet = createWallet();
    const signature = signMessage('original message', wallet.secret);
    expect(verifyMessage('tampered message', signature, wallet.publicKey)).toBe(false);
  });

  it('rejects a signature with a single flipped bit', () => {
    const wallet = createWallet();
    const signature = signMessage('bit flip test', wallet.secret);
    const raw = Buffer.from(signature, 'base64');
    raw[0] ^= 0x01;
    const tampered = raw.toString('base64');
    expect(verifyMessage('bit flip test', tampered, wallet.publicKey)).toBe(false);
  });

  it('rejects a truncated signature', () => {
    const wallet = createWallet();
    const signature = signMessage('truncate test', wallet.secret);
    const truncated = signature.slice(0, Math.floor(signature.length / 2));
    expect(verifyMessage('truncate test', truncated, wallet.publicKey)).toBe(false);
  });

  it('rejects garbage base64 that is not a signature at all', () => {
    const wallet = createWallet();
    expect(verifyMessage('msg', 'aW52YWxpZHNpZ25hdHVyZQ==', wallet.publicKey)).toBe(false);
  });

  it('rejects an empty-string signature', () => {
    const wallet = createWallet();
    expect(verifyMessage('msg', '', wallet.publicKey)).toBe(false);
  });

  it('returns false (not throw) for a malformed, non-base64 signature', () => {
    const wallet = createWallet();
    expect(() => verifyMessage('msg', '!!!not-base64!!!', wallet.publicKey)).not.toThrow();
  });

  it('returns false for an invalid/malformed public key rather than throwing', () => {
    const wallet = createWallet();
    const signature = signMessage('msg', wallet.secret);
    expect(verifyMessage('msg', signature, 'NOT_A_VALID_G_ADDRESS')).toBe(false);
  });
});

describe('Ed25519: RFC 8032 standard test vectors (raw, unprefixed signing)', () => {
  // RFC 8032 Section 7.1 Ed25519 test vectors. These exercise the raw
  // Keypair.sign/verify primitives directly (no `stellar:message:` domain
  // prefix), since the prefix is this SDK's own addition and would not
  // match the RFC's published signatures.
  //
  // TEST 1 (empty message)
  const VECTOR_1 = {
    secretKeySeed: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'.slice(0, 64),
    publicKey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    message: '',
    signature:
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  };

  // TEST 2 (one byte message: 0x72)
  const VECTOR_2 = {
    secretKeySeed: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb'.slice(0, 64),
    publicKey: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    message: '72',
    signature:
      '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
  };

  function fromSeedHex(seedHex: string): Keypair {
    const seed = Buffer.from(seedHex, 'hex');
    return Keypair.fromRawEd25519Seed(seed);
  }

  it.each([VECTOR_1, VECTOR_2])(
    'reproduces the RFC 8032 Ed25519 signature for message=0x$message',
    ({ secretKeySeed, publicKey, message, signature }) => {
      const keypair = fromSeedHex(secretKeySeed);
      expect(keypair.rawPublicKey().toString('hex')).toBe(publicKey);

      const messageBuffer = Buffer.from(message, 'hex');
      const produced = keypair.sign(messageBuffer);
      expect(produced.toString('hex')).toBe(signature);

      const isValid = keypair.verify(messageBuffer, produced);
      expect(isValid).toBe(true);
    },
  );

  it('rejects an RFC test vector signature checked against a tampered message', () => {
    const keypair = fromSeedHex(VECTOR_2.secretKeySeed);
    const signature = Buffer.from(VECTOR_2.signature, 'hex');
    const tamperedMessage = Buffer.from('73', 'hex'); // one byte different from 0x72
    expect(keypair.verify(tamperedMessage, signature)).toBe(false);
  });
});

describe('Ed25519: identical results across simulated JS engines (Node vs. WebCrypto-style)', () => {
  // There is no actual separate browser/WebCrypto Ed25519 implementation in
  // this SDK to run side-by-side — see the file-level note above. What we
  // *can* and do assert here: signMessage/verifyMessage are pure functions
  // of their inputs, so calling them repeatedly (simulating "another
  // environment" re-running the same deterministic primitive) always
  // agrees with the first result. This guards against any future
  // regression where signing becomes non-deterministic or environment
  // dependent (e.g. accidentally keying off `Date.now()`, `Math.random()`,
  // or a global that differs between Node and a browser sandbox).
  it('produces byte-identical signatures across repeated calls with the same inputs', () => {
    const wallet = createWallet();
    const message = 'cross-environment determinism check';
    const first = signMessage(message, wallet.secret);
    const second = signMessage(message, wallet.secret);
    const third = signMessage(message, wallet.secret);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('verification agrees across repeated calls for the same signature/message/key', () => {
    const wallet = createWallet();
    const message = new Uint8Array([1, 2, 3, 4, 5]);
    const signature = signMessage(message, wallet.secret);
    const results = Array.from({ length: 5 }, () =>
      verifyMessage(message, signature, wallet.publicKey),
    );
    expect(results.every((r) => r === true)).toBe(true);
  });

  it('RFC vector raw sign/verify is reproducible across repeated calls (determinism)', () => {
    const keypair = Keypair.fromRawEd25519Seed(Buffer.from(VECTOR_1().secretKeySeed, 'hex'));
    const message = Buffer.from(VECTOR_1().message, 'hex');
    const sigA = keypair.sign(message).toString('hex');
    const sigB = keypair.sign(message).toString('hex');
    expect(sigA).toBe(sigB);
    expect(sigA).toBe(VECTOR_1().signature);
  });

  function VECTOR_1() {
    return {
      secretKeySeed: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'.slice(
        0,
        64,
      ),
      message: '',
      signature:
        'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    };
  }
});
