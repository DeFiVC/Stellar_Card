// Tests for custom base fee overrides (#732) — client-level default,
// per-call override precedence, upper-bound enforcement, and invalid
// value rejection. Covers both soroban.ts (buildContractPaymentTx) and
// the stellar.ts payViaContract wrapper.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ValidationError } from '../errors';

vi.mock('@stellar/stellar-sdk', async () => {
  // Capture the `fee` passed to TransactionBuilder's constructor so tests
  // can assert on the resolved base fee without needing a live Soroban RPC.
  // Declared inside the factory (not as an outer `let`) because vi.mock
  // factories are hoisted above the rest of the module and cannot
  // reference top-level bindings declared after them.
  const g = globalThis as { __baseFeeTestState?: { fee?: string } };
  const state: { fee?: string } = g.__baseFeeTestState ?? (g.__baseFeeTestState = {});
  const actual =
    await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return {
    ...actual,
    rpc: {
      Server: class MockServer {
        constructor(_url?: string) {}
        getAccount = vi.fn().mockResolvedValue({
          accountId: () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          sequenceNumber: () => '12345',
          incrementSequenceNumber: () => {},
        });
        simulateTransaction = vi.fn().mockResolvedValue({
          status: 'SUCCESS',
          result: { auth: [], retval: { switch: () => ({ name: 'void' }) } },
        });
        sendTransaction = vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'a'.repeat(64) });
        getTransaction = vi.fn().mockResolvedValue({ status: 'SUCCESS', hash: 'a'.repeat(64) });
      },
      Api: {
        isSimulationError: vi.fn().mockReturnValue(false),
        isSimulationSuccess: vi.fn().mockReturnValue(true),
      },
      assembleTransaction: vi.fn().mockReturnValue({
        build: vi.fn().mockReturnValue({
          hash: vi.fn().mockReturnValue(Buffer.alloc(32)),
          signatures: [],
          toEnvelope: vi.fn().mockReturnValue({ toXDR: vi.fn().mockReturnValue('AAAAAg==') }),
          sequence: '12345',
          fee: state.fee,
        }),
      }),
    },
    Account: class MockAccount {
      constructor(_address?: string, _sequence?: string) {}
      accountId = () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
      sequenceNumber = () => '12345';
      incrementSequenceNumber = () => {};
    },
    Address: class MockAddress {
      constructor(_address?: string) {}
      toScVal = vi.fn().mockReturnValue({ switch: () => ({ name: 'address' }) });
    },
    Contract: class MockContract {
      constructor(_id?: string) {}
      call = vi.fn().mockReturnValue({ switch: () => ({ name: 'invoke' }) });
    },
    TransactionBuilder: class MockTransactionBuilder {
      constructor(_account?: unknown, opts?: { fee?: string }) {
        state.fee = opts?.fee;
      }
      addOperation = vi.fn().mockReturnThis();
      setTimeout = vi.fn().mockReturnThis();
      build = vi.fn().mockReturnValue({
        hash: vi.fn().mockReturnValue(Buffer.alloc(32)),
        signatures: [],
        toEnvelope: vi.fn().mockReturnValue({ toXDR: vi.fn().mockReturnValue('AAAAAg==') }),
        sequence: '12345',
        fee: state.fee,
        sign: vi.fn(),
      });
    },
    Networks: {
      PUBLIC: 'Public Global Stellar Network ; September 2015',
      TESTNET: 'Test SDF Network ; September 2015',
    },
    BASE_FEE: '100',
    nativeToScVal: vi.fn().mockReturnValue({ switch: () => ({ name: 'value' }) }),
    xdr: { DecoratedSignature: vi.fn().mockImplementation(() => ({})) },
  };
});

function getCapturedFee(): string | undefined {
  return (globalThis as { __baseFeeTestState?: { fee?: string } }).__baseFeeTestState?.fee;
}

function resetCapturedFee(): void {
  const g = globalThis as { __baseFeeTestState?: { fee?: string } };
  if (g.__baseFeeTestState) {
    g.__baseFeeTestState.fee = undefined;
  } else {
    g.__baseFeeTestState = {};
  }
}

import {
  buildContractPaymentTx,
  setDefaultBaseFee,
  getDefaultBaseFee,
  resetDefaultBaseFee,
  DEFAULT_BASE_FEE_STROOPS,
  MAX_BASE_FEE_STROOPS,
  validateBaseFee,
} from '../soroban';

describe('custom base fee overrides (#732)', () => {
  beforeEach(() => {
    resetCapturedFee();
    resetDefaultBaseFee();
  });

  afterEach(() => {
    resetDefaultBaseFee();
  });

  const baseOpts = {
    contractId: 'C' + 'A'.repeat(55),
    fn: 'pay_usdc' as const,
    fromPublicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    amountStroops: 100_000_000n,
    orderId: 'ord_123',
    networkPassphrase: 'Test SDF Network ; September 2015',
  };

  it('applies the default fee (100 stroops) when nothing is specified', async () => {
    await buildContractPaymentTx({ ...baseOpts });
    expect(getCapturedFee()).toBe(String(DEFAULT_BASE_FEE_STROOPS));
  });

  it('uses the client-level default when set', () => {
    setDefaultBaseFee(500);
    expect(getDefaultBaseFee()).toBe(500);
  });

  it('builds a transaction using the client-level default fee', async () => {
    setDefaultBaseFee(500);
    await buildContractPaymentTx({ ...baseOpts });
    expect(getCapturedFee()).toBe('500');
  });

  it('a per-call baseFee override takes precedence over the client-level default', async () => {
    setDefaultBaseFee(500);
    await buildContractPaymentTx({ ...baseOpts, baseFee: 1234 });
    expect(getCapturedFee()).toBe('1234');
  });

  it('a per-call baseFee override takes precedence over the built-in default', async () => {
    await buildContractPaymentTx({ ...baseOpts, baseFee: 777 });
    expect(getCapturedFee()).toBe('777');
  });

  it('the network-driven `fee` (insufficient-fee retry) wins over baseFee entirely', async () => {
    await buildContractPaymentTx({ ...baseOpts, baseFee: 50, fee: '999999' });
    expect(getCapturedFee()).toBe('999999');
  });

  describe('upper-bound enforcement (100,000 stroops)', () => {
    it('accepts exactly the boundary value', () => {
      expect(() => validateBaseFee(MAX_BASE_FEE_STROOPS)).not.toThrow();
    });

    it('rejects one stroop over the boundary', () => {
      expect(() => validateBaseFee(MAX_BASE_FEE_STROOPS + 1)).toThrow(ValidationError);
    });

    it('buildContractPaymentTx rejects a baseFee over the boundary before any network call', async () => {
      await expect(
        buildContractPaymentTx({ ...baseOpts, baseFee: MAX_BASE_FEE_STROOPS + 1 }),
      ).rejects.toThrow(ValidationError);
    });

    it('setDefaultBaseFee rejects a value over the boundary and leaves the old default in place', () => {
      setDefaultBaseFee(1000);
      expect(() => setDefaultBaseFee(MAX_BASE_FEE_STROOPS + 1)).toThrow(ValidationError);
      expect(getDefaultBaseFee()).toBe(1000);
    });
  });

  describe('invalid values', () => {
    it('rejects a negative fee', () => {
      expect(() => validateBaseFee(-1)).toThrow(ValidationError);
    });

    it('rejects zero', () => {
      expect(() => validateBaseFee(0)).toThrow(ValidationError);
    });

    it('rejects a non-integer fee', () => {
      expect(() => validateBaseFee(100.5)).toThrow(ValidationError);
    });

    it('rejects NaN', () => {
      expect(() => validateBaseFee(NaN)).toThrow(ValidationError);
    });

    it('rejects Infinity', () => {
      expect(() => validateBaseFee(Infinity)).toThrow(ValidationError);
    });

    it('buildContractPaymentTx rejects a non-integer baseFee', async () => {
      await expect(buildContractPaymentTx({ ...baseOpts, baseFee: 1.5 })).rejects.toThrow(
        ValidationError,
      );
    });
  });
});

describe('payViaContract baseFee integration (#732)', () => {
  beforeEach(() => {
    resetCapturedFee();
    resetDefaultBaseFee();
  });

  afterEach(() => {
    resetDefaultBaseFee();
  });

  it('rejects an over-the-boundary baseFee before signing or submitting', async () => {
    const { payViaContract } = await import('../stellar');
    const { Keypair } = await import('@stellar/stellar-sdk');
    const walletSecret = Keypair.random().secret();

    await expect(
      payViaContract({
        walletSecret,
        payment: {
          type: 'soroban_contract',
          contract_id: 'CB2JZVAJYFJZV4FMVTE2QCSF7EZKQ6SQB44JKON24WHZPRO43HRKUSA3',
          order_id: 'ord_123',
          usdc: { amount: '10.00', asset: 'USDC:ISSUER' },
        },
        baseFee: MAX_BASE_FEE_STROOPS + 1,
      }),
    ).rejects.toThrow(ValidationError);
  });
});
