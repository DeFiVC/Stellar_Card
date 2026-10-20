// Unit tests for createClaimableBalance / claimBalance / getClaimableBalances (#736).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, Networks } from '@stellar/stellar-sdk';

const mockLoadAccount = vi.fn();
const mockSubmitTransaction = vi.fn();
const mockClaimant = vi.fn();
const mockLimit = vi.fn();
const mockCall = vi.fn();

vi.mock('@stellar/stellar-sdk', async () => {
  const actual =
    await vi.importActual<typeof import('@stellar/stellar-sdk')>('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      Server: vi.fn(function (this: any) {
        this.loadAccount = mockLoadAccount;
        this.submitTransaction = mockSubmitTransaction;
        this.claimableBalances = () => ({
          claimant: mockClaimant.mockReturnValue({
            limit: mockLimit.mockReturnValue({ call: mockCall }),
          }),
        });
      }),
    },
  };
});

import { createClaimableBalance, claimBalance, getClaimableBalances } from '../stellar';

const FUNDER = Keypair.random();
const CLAIMANT = Keypair.random();

function fakeAccount(publicKey: string) {
  return {
    accountId: () => publicKey,
    sequenceNumber: () => '1',
    incrementSequenceNumber: () => {},
    balances: [],
  };
}

describe('createClaimableBalance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadAccount.mockResolvedValue(fakeAccount(FUNDER.publicKey()));
    mockSubmitTransaction.mockResolvedValue({ hash: 'CB_TX_HASH' });
  });

  it('submits a CreateClaimableBalance op and returns the tx hash', async () => {
    const hash = await createClaimableBalance({
      sourceSecret: FUNDER.secret(),
      amount: '10.0000000',
      claimants: [{ destination: CLAIMANT.publicKey() }],
    });
    expect(hash).toBe('CB_TX_HASH');
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
  });

  it('applies a beforeAbsoluteTime predicate without throwing', async () => {
    const hash = await createClaimableBalance({
      sourceSecret: FUNDER.secret(),
      amount: '5.0000000',
      claimants: [
        {
          destination: CLAIMANT.publicKey(),
          predicate: { beforeAbsoluteTime: '2027-01-01T00:00:00Z' },
        },
      ],
    });
    expect(hash).toBe('CB_TX_HASH');
  });

  it('applies an afterAbsoluteTime predicate without throwing', async () => {
    const hash = await createClaimableBalance({
      sourceSecret: FUNDER.secret(),
      amount: '5.0000000',
      claimants: [
        {
          destination: CLAIMANT.publicKey(),
          predicate: { afterAbsoluteTime: '2024-01-01T00:00:00Z' },
        },
      ],
    });
    expect(hash).toBe('CB_TX_HASH');
  });

  it('applies both before and after predicates combined', async () => {
    const hash = await createClaimableBalance({
      sourceSecret: FUNDER.secret(),
      amount: '1.0000000',
      claimants: [
        {
          destination: CLAIMANT.publicKey(),
          predicate: {
            afterAbsoluteTime: '2024-01-01T00:00:00Z',
            beforeAbsoluteTime: '2027-01-01T00:00:00Z',
          },
        },
      ],
    });
    expect(hash).toBe('CB_TX_HASH');
  });

  it('supports multiple claimants', async () => {
    const claimant2 = Keypair.random();
    const hash = await createClaimableBalance({
      sourceSecret: FUNDER.secret(),
      amount: '1.0000000',
      claimants: [{ destination: CLAIMANT.publicKey() }, { destination: claimant2.publicKey() }],
    });
    expect(hash).toBe('CB_TX_HASH');
  });

  it('throws when claimants list is empty', async () => {
    await expect(
      createClaimableBalance({
        sourceSecret: FUNDER.secret(),
        amount: '1.0000000',
        claimants: [],
      }),
    ).rejects.toThrow(/at least one claimant/i);
    expect(mockSubmitTransaction).not.toHaveBeenCalled();
  });

  it('throws on an invalid source secret', async () => {
    await expect(
      createClaimableBalance({
        sourceSecret: 'not-a-secret',
        amount: '1.0000000',
        claimants: [{ destination: CLAIMANT.publicKey() }],
      }),
    ).rejects.toThrow();
  });

  it('propagates Horizon submission failures', async () => {
    mockSubmitTransaction.mockRejectedValue(new Error('tx_failed'));
    await expect(
      createClaimableBalance({
        sourceSecret: FUNDER.secret(),
        amount: '1.0000000',
        claimants: [{ destination: CLAIMANT.publicKey() }],
      }),
    ).rejects.toThrow('tx_failed');
  });
});

// A syntactically valid (64 hex char, big-endian uint64 type prefix of 0)
// claimable balance ID, as returned by Horizon / CreateClaimableBalanceResult.
const VALID_BALANCE_ID = `00000000${'ab'.repeat(32)}`;

describe('claimBalance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadAccount.mockResolvedValue(fakeAccount(CLAIMANT.publicKey()));
    mockSubmitTransaction.mockResolvedValue({ hash: 'CLAIM_TX_HASH' });
  });

  it('submits a ClaimClaimableBalance op and returns the tx hash', async () => {
    const hash = await claimBalance(VALID_BALANCE_ID, CLAIMANT.secret());
    expect(hash).toBe('CLAIM_TX_HASH');
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
  });

  it('accepts a Keypair instance directly', async () => {
    const hash = await claimBalance(VALID_BALANCE_ID, CLAIMANT);
    expect(hash).toBe('CLAIM_TX_HASH');
  });

  it('propagates Horizon errors (e.g. already claimed)', async () => {
    mockSubmitTransaction.mockRejectedValue(new Error('op_already_claimed'));
    await expect(claimBalance(VALID_BALANCE_ID, CLAIMANT.secret())).rejects.toThrow(
      'op_already_claimed',
    );
  });

  it('respects a custom networkPassphrase option', async () => {
    const hash = await claimBalance(VALID_BALANCE_ID, CLAIMANT.secret(), {
      networkPassphrase: Networks.TESTNET,
    });
    expect(hash).toBe('CLAIM_TX_HASH');
  });

  it('throws on an invalid balance ID', async () => {
    await expect(claimBalance('not-a-balance-id', CLAIMANT.secret())).rejects.toThrow();
  });
});

describe('getClaimableBalances', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps Horizon records into ClaimableBalanceEntry shape', async () => {
    mockCall.mockResolvedValue({
      records: [
        {
          id: 'balance1',
          asset: 'native',
          amount: '10.0000000',
          sponsor: FUNDER.publicKey(),
          claimants: [{ destination: CLAIMANT.publicKey(), predicate: {} }],
          last_modified_ledger: 12345,
        },
      ],
    });

    const result = await getClaimableBalances(CLAIMANT.publicKey());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'balance1',
      asset: 'native',
      amount: '10.0000000',
      lastModifiedLedger: 12345,
    });
  });

  it('returns an empty array when the account has no claimable balances', async () => {
    mockCall.mockResolvedValue({ records: [] });
    const result = await getClaimableBalances(CLAIMANT.publicKey());
    expect(result).toEqual([]);
  });

  it('rejects an invalid public key without calling Horizon', async () => {
    await expect(getClaimableBalances('not-a-valid-key')).rejects.toThrow(
      /Invalid Stellar public key/,
    );
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('passes a custom limit through to the Horizon query', async () => {
    mockCall.mockResolvedValue({ records: [] });
    await getClaimableBalances(CLAIMANT.publicKey(), { limit: 5 });
    expect(mockLimit).toHaveBeenCalledWith(5);
  });

  it('propagates Horizon request failures', async () => {
    mockCall.mockRejectedValue(new Error('horizon_unreachable'));
    await expect(getClaimableBalances(CLAIMANT.publicKey())).rejects.toThrow('horizon_unreachable');
  });
});
