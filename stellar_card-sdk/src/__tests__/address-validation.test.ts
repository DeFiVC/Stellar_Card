import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { isValidStellarAddress, resolveFederationAddress } from '../stellar';

const VALID_ACCOUNT_ID = Keypair.random().publicKey();
const FEDERATION_ADDRESS = 'alice*stellarcard.com';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isValidStellarAddress', () => {
  it('accepts valid account and contract StrKeys', () => {
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 1));

    expect(isValidStellarAddress(VALID_ACCOUNT_ID)).toBe(true);
    expect(isValidStellarAddress(contractId)).toBe(true);
  });

  it('rejects invalid values and checksum-corrupted addresses', () => {
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 1));
    const corruptedAccount = `${VALID_ACCOUNT_ID.slice(0, -1)}A`;
    const corruptedContract = `${contractId.slice(0, -1)}A`;

    expect(isValidStellarAddress('')).toBe(false);
    expect(isValidStellarAddress('not-an-address')).toBe(false);
    expect(isValidStellarAddress(corruptedAccount)).toBe(false);
    expect(isValidStellarAddress(corruptedContract)).toBe(false);
  });
});

describe('resolveFederationAddress', () => {
  it('resolves an account and memo from SEP-0002', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        stellar_address: FEDERATION_ADDRESS,
        account_id: VALID_ACCOUNT_ID,
        memo_type: 'id',
        memo: '12345',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveFederationAddress(FEDERATION_ADDRESS)).resolves.toEqual({
      accountId: VALID_ACCOUNT_ID,
      memo: '12345',
      memoType: 'id',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://stellarcard.com/federation?type=name&q=alice*stellarcard.com',
      { headers: { Accept: 'application/json' } },
    );
  });

  it('resolves an account when the response has no memo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          stellar_address: FEDERATION_ADDRESS,
          account_id: VALID_ACCOUNT_ID,
        }),
      }),
    );

    await expect(resolveFederationAddress(FEDERATION_ADDRESS)).resolves.toEqual({
      accountId: VALID_ACCOUNT_ID,
    });
  });

  it('rejects malformed federation addresses without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveFederationAddress('alice@stellarcard.com')).rejects.toThrow(
      'Invalid federation address',
    );
    await expect(resolveFederationAddress('alice*stellarcard.com/path')).rejects.toThrow(
      'Invalid federation address',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects HTTP errors and invalid federation responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }),
    );
    await expect(resolveFederationAddress(FEDERATION_ADDRESS)).rejects.toThrow(
      'Federation lookup failed with HTTP 404',
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ stellar_address: FEDERATION_ADDRESS, account_id: 'invalid' }),
      }),
    );
    await expect(resolveFederationAddress(FEDERATION_ADDRESS)).rejects.toThrow(
      'invalid address or account ID',
    );
  });

  it('rejects mismatched federation identity and malformed memo details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          stellar_address: 'other*stellarcard.com',
          account_id: VALID_ACCOUNT_ID,
        }),
      }),
    );
    await expect(resolveFederationAddress(FEDERATION_ADDRESS)).rejects.toThrow(
      'invalid address or account ID',
    );

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          stellar_address: FEDERATION_ADDRESS,
          account_id: VALID_ACCOUNT_ID,
          memo_type: 'unknown',
          memo: '12345',
        }),
      }),
    );
    await expect(resolveFederationAddress(FEDERATION_ADDRESS)).rejects.toThrow(
      'invalid memo details',
    );
  });
});
