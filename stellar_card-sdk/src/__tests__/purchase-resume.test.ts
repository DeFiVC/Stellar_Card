// Unit tests for the CLI `stellar_card purchase --resume` state machine.
//
// Covers the 2026-04-15 audit fix (F1-resume): the last-order file
// now captures txHash + phase alongside orderId, and --resume uses
// that context to decide whether to wait, skip-to-waitForCard, or
// rebuild-and-resubmit instead of defaulting to a full 5-minute
// waitForCard hang on a dropped Soroban tx.
//
// Three layers tested:
//   1. saveLastOrder / loadLastOrder round-trip (JSON form)
//   2. Legacy bare-string format is accepted on load
//   3. purchaseCardOWS resume branch with a txHash + checkSorobanTxLanded

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { loadLastOrder, type LastOrderState } from '../commands/purchase';

// ── Test harness ─────────────────────────────────────────────────────────────

let tmpDir: string;
let origConfigDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar_card-resume-test-'));
  origConfigDir = process.env.CARDS402_CONFIG_DIR;
  process.env.CARDS402_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  if (origConfigDir === undefined) delete process.env.CARDS402_CONFIG_DIR;
  else process.env.CARDS402_CONFIG_DIR = origConfigDir;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// saveLastOrder is not exported from purchase.ts directly — only loadLastOrder
// is. Write the file by hand to exercise the loader, and for the save path we
// verify the CLI's behaviour end-to-end through the main-flow tests below.
function writeLastOrderJson(state: LastOrderState): void {
  const p = path.join(tmpDir, 'last-order');
  fs.writeFileSync(p, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function writeLastOrderLegacy(orderId: string): void {
  const p = path.join(tmpDir, 'last-order');
  fs.writeFileSync(p, `${orderId}\n`, { mode: 0o600 });
}

describe('loadLastOrder — JSON format', () => {
  it('returns null when the file is missing', () => {
    expect(loadLastOrder()).toBeNull();
  });

  it('round-trips a full LastOrderState', () => {
    const state: LastOrderState = {
      orderId: 'abc-123',
      txHash: 'deadbeef'.repeat(8),
      phase: 'unpaid',
      savedAt: '2026-04-15T10:00:00.000Z',
    };
    writeLastOrderJson(state);
    expect(loadLastOrder()).toEqual(state);
  });

  it('returns only the fields the JSON actually carries', () => {
    writeLastOrderJson({ orderId: 'minimal' });
    const loaded = loadLastOrder();
    expect(loaded?.orderId).toBe('minimal');
    expect(loaded?.txHash).toBeUndefined();
    expect(loaded?.phase).toBeUndefined();
  });

  it('rejects a JSON body with no orderId', () => {
    const p = path.join(tmpDir, 'last-order');
    fs.writeFileSync(p, JSON.stringify({ txHash: 'abc' }));
    expect(loadLastOrder()).toBeNull();
  });

  it('rejects a JSON body with non-string orderId', () => {
    const p = path.join(tmpDir, 'last-order');
    fs.writeFileSync(p, JSON.stringify({ orderId: 12345 }));
    expect(loadLastOrder()).toBeNull();
  });

  it('rejects a JSON body with invalid phase (sanitises to undefined)', () => {
    writeLastOrderJson({
      orderId: 'abc',
      phase: 'not-a-phase' as unknown as 'unpaid',
    });
    const loaded = loadLastOrder();
    expect(loaded?.orderId).toBe('abc');
    expect(loaded?.phase).toBeUndefined();
  });
});

describe('loadLastOrder — legacy bare-string format', () => {
  // Older CLI versions wrote the file as a plain line containing
  // just the order id. New loader must still accept this so a user
  // mid-purchase across an SDK upgrade doesn't lose their resume
  // context.
  it('accepts a bare orderId line (legacy format)', () => {
    writeLastOrderLegacy('legacy-order-id');
    expect(loadLastOrder()).toEqual({ orderId: 'legacy-order-id' });
  });

  it('strips whitespace from a legacy line', () => {
    const p = path.join(tmpDir, 'last-order');
    fs.writeFileSync(p, `  spaced-order-id  \n\n`);
    const loaded = loadLastOrder();
    expect(loaded?.orderId).toBe('spaced-order-id');
  });

  it('returns null on an empty file', () => {
    const p = path.join(tmpDir, 'last-order');
    fs.writeFileSync(p, '');
    expect(loadLastOrder()).toBeNull();
  });
});

describe('loadLastOrder — corruption and hostile input', () => {
  it('returns null on unparseable JSON', () => {
    const p = path.join(tmpDir, 'last-order');
    fs.writeFileSync(p, '{not valid json');
    expect(loadLastOrder()).toBeNull();
  });

  it('returns null on a directory-typed last-order path', () => {
    const p = path.join(tmpDir, 'last-order');
    fs.mkdirSync(p);
    expect(loadLastOrder()).toBeNull();
  });
});

// ── purchaseCardOWS resume branch — F1-resume regression ────────────────────
//
// This suite spies on checkSorobanTxLanded + Stellar_CardClient to drive
// purchaseCardOWS through each of the three resume decision branches:
//
//   1. Prior tx landed → skipPayment (wait for backend to see it)
//   2. Prior tx dropped → rebuild from status.payment and resubmit
//   3. Status unknown → skipPayment (conservative)
//
// We can't hit the real Soroban network in unit tests, so we mock
// both the backend client and the helper. The value is the state
// machine routing, not the network calls.

describe('purchaseCardOWS resume state machine — F1-resume', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function loadPurchaseCardOWSWithMocks(opts: {
    orderStatus: {
      phase: string;
      payment?: unknown;
      card?: { number: string; cvv: string; expiry: string; brand: string };
    };
    landedResult: 'landed' | 'dropped' | 'pending';
  }) {
    const getOrderSpy = vi.fn().mockResolvedValue(opts.orderStatus);
    const waitForCardSpy = vi
      .fn()
      .mockResolvedValue({ number: '4111', cvv: '123', expiry: '12/30', brand: 'Visa' });
    // `checkSorobanTxLanded` (ows.ts) hits Horizon via the global `fetch`
    // directly — stub fetch rather than the export, since ows.ts calls it
    // through its own module-local binding (vi.spyOn on the export object
    // does not intercept a module's calls to its own functions).
    const horizonFetchSpy = vi.fn(async () => {
      if (opts.landedResult === 'landed') {
        return new Response(JSON.stringify({ successful: true }), { status: 200 });
      }
      if (opts.landedResult === 'dropped') {
        return new Response('not found', { status: 404 });
      }
      // 'pending' — an ambiguous non-200/404 Horizon response.
      return new Response('service unavailable', { status: 503 });
    });
    vi.stubGlobal('fetch', horizonFetchSpy);

    // `payViaContractOWS` (ows.ts) calls `submitSorobanTx` /
    // `buildContractPaymentTx` from ./soroban — a DIFFERENT module, so
    // mocking it here genuinely intercepts ows.ts's calls (unlike trying
    // to mock ows.ts's own exports from within itself).
    const submitSorobanTxSpy = vi.fn().mockResolvedValue({
      hash: 'fake-resubmit-tx-hash',
      feeCharged: '100',
      feeRefunded: '0',
      maxFee: '100',
    });
    // Minimal fake Transaction: owsSignTx only needs `.toEnvelope().toXDR()`
    // (to build the signing payload) and a mutable `.signatures` array to
    // push the decorated signature onto — it never inspects XDR contents
    // in this test, so a fixed dummy envelope is fine.
    const fakeTx = {
      sequence: '1',
      fee: '100',
      signatures: [] as unknown[],
      toEnvelope: () => ({ toXDR: () => '00'.repeat(32) }),
    };
    const buildContractPaymentTxSpy = vi.fn().mockResolvedValue({
      tx: fakeTx,
      server: {},
    });
    vi.doMock('../soroban', async () => {
      const actual = await vi.importActual<typeof import('../soroban')>('../soroban');
      return {
        ...actual,
        submitSorobanTx: submitSorobanTxSpy,
        buildContractPaymentTx: buildContractPaymentTxSpy,
      };
    });

    // `getOWSPublicKey` / `getOWSBalance` (ows.ts) call out to
    // `@ctx.com/stellar-ows-core` (owsGet/owsSign) and
    // `@stellar/stellar-sdk`'s `Horizon.Server` — both external
    // packages, so mocking them intercepts ows.ts's real calls.
    const TEST_PUBLIC_KEY = 'GCY5PWJB77OWDLLJ7QLW3KZUKFQSNGZVAOCP4XEWIUORVCKVJBDNR5FK';
    vi.doMock('@ctx.com/stellar-ows-core', () => ({
      createWallet: vi.fn(),
      getWallet: vi.fn().mockReturnValue({
        name: 'test-wallet',
        accounts: [{ chainId: 'stellar:pubnet', address: TEST_PUBLIC_KEY }],
      }),
      importWalletPrivateKey: vi.fn(),
      signTransaction: vi.fn().mockReturnValue({ signature: '00'.repeat(64) }),
    }));

    vi.doMock('../client', () => ({
      Stellar_CardClient: class {
        constructor() {}
        getOrder = getOrderSpy;
        waitForCard = waitForCardSpy;
      },
    }));

    const ows = await import('../ows');
    const stellarSdk = await import('@stellar/stellar-sdk');
    vi.spyOn(stellarSdk.Horizon.Server.prototype, 'loadAccount').mockResolvedValue({
      balances: [
        { asset_type: 'native', balance: '10' },
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          balance: '50',
        },
      ],
    } as never);

    return {
      purchaseCardOWS: ows.purchaseCardOWS,
      getOrderSpy,
      checkLandedSpy: horizonFetchSpy,
      waitForCardSpy,
      payViaContractOWSSpy: submitSorobanTxSpy,
    };
  }

  // These tests exercise the static portions of the state machine —
  // the routing decision happens before any network call — so a
  // simple smoke test of each code path is enough. We verify that:
  //   - checkSorobanTxLanded is consulted when priorTxHash is present
  //     and status is still awaiting_payment
  //   - getOrderSpy is called exactly once per resume
  //
  // End-to-end coverage of the payViaContractOWS call path is done
  // via the integration tests that hit the real stellar-sdk.

  const BASE_RESUME_OPTS = {
    apiKey: 'test-key',
    walletName: 'test-wallet',
    amountUsdc: '10.00',
  };

  it('short-circuits to the card when the order is already ready (no landed-check, no resubmit)', async () => {
    const { purchaseCardOWS, getOrderSpy, checkLandedSpy, payViaContractOWSSpy } =
      await loadPurchaseCardOWSWithMocks({
        orderStatus: {
          phase: 'ready',
          card: { number: '4111', cvv: '123', expiry: '12/30', brand: 'Visa' },
        },
        landedResult: 'landed',
      });

    const result = await purchaseCardOWS({
      ...BASE_RESUME_OPTS,
      resume: { orderId: 'ord_ready', txHash: 'deadbeef'.repeat(8), phase: 'unpaid' },
    });

    expect(result.order_id).toBe('ord_ready');
    expect(result.number).toBe('4111');
    expect(getOrderSpy).toHaveBeenCalledTimes(1);
    expect(getOrderSpy).toHaveBeenCalledWith('ord_ready');
    // Phase is 'ready' — the landed-check and a resubmit would risk a
    // double payment on an order that's already settled. Neither must run.
    expect(checkLandedSpy).not.toHaveBeenCalled();
    expect(payViaContractOWSSpy).not.toHaveBeenCalled();
  });

  it('skips payment (waits) when the prior tx has landed — prevents double payment', async () => {
    const { purchaseCardOWS, checkLandedSpy, payViaContractOWSSpy, waitForCardSpy } =
      await loadPurchaseCardOWSWithMocks({
        orderStatus: { phase: 'awaiting_payment' },
        landedResult: 'landed',
      });

    const result = await purchaseCardOWS({
      ...BASE_RESUME_OPTS,
      resume: { orderId: 'ord_landed', txHash: 'cafebabe'.repeat(8), phase: 'unpaid' },
    });

    expect(checkLandedSpy).toHaveBeenCalledTimes(1);
    expect(checkLandedSpy.mock.calls[0][0]).toContain('cafebabe'.repeat(8));
    // Tx already landed on-chain — resubmitting would double-pay. Must not resubmit.
    expect(payViaContractOWSSpy).not.toHaveBeenCalled();
    expect(waitForCardSpy).toHaveBeenCalledTimes(1);
    expect(result.number).toBe('4111');
  });

  it('skips payment (waits) when the landed-check is inconclusive — conservative, no double payment', async () => {
    const { purchaseCardOWS, checkLandedSpy, payViaContractOWSSpy, waitForCardSpy } =
      await loadPurchaseCardOWSWithMocks({
        orderStatus: { phase: 'awaiting_payment' },
        landedResult: 'pending',
      });

    await purchaseCardOWS({
      ...BASE_RESUME_OPTS,
      resume: { orderId: 'ord_pending', txHash: 'f00dface'.repeat(8), phase: 'unpaid' },
    });

    expect(checkLandedSpy).toHaveBeenCalledTimes(1);
    // Can't tell if it's in-flight or dropped — resubmitting risks a
    // double-pay if it eventually lands, so the state machine must wait.
    expect(payViaContractOWSSpy).not.toHaveBeenCalled();
    expect(waitForCardSpy).toHaveBeenCalledTimes(1);
  });

  it('rebuilds and resubmits when the prior tx dropped and the order still has payment instructions', async () => {
    const paymentInstructions = {
      contract_id: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      usdc: { amount: '10.00', asset: 'USDC:GA5Z...' },
    };
    const { purchaseCardOWS, checkLandedSpy, payViaContractOWSSpy, waitForCardSpy } =
      await loadPurchaseCardOWSWithMocks({
        orderStatus: { phase: 'awaiting_payment', payment: paymentInstructions },
        landedResult: 'dropped',
      });

    const result = await purchaseCardOWS({
      ...BASE_RESUME_OPTS,
      paymentAsset: 'usdc',
      resume: { orderId: 'ord_dropped', txHash: 'deadc0de'.repeat(8), phase: 'unpaid' },
    });

    expect(checkLandedSpy).toHaveBeenCalledTimes(1);
    // Dropped pre-apply — safe (and necessary) to rebuild from the
    // order's persisted payment instructions and resubmit exactly once.
    expect(payViaContractOWSSpy).toHaveBeenCalledTimes(1);
    expect(waitForCardSpy).toHaveBeenCalledTimes(1);
    expect(result.number).toBe('4111');
  });

  it('throws OrderFailedError (does not resubmit) when the order expired during the outage', async () => {
    const { purchaseCardOWS, payViaContractOWSSpy, checkLandedSpy } =
      await loadPurchaseCardOWSWithMocks({
        orderStatus: { phase: 'expired' },
        landedResult: 'dropped',
      });

    await expect(
      purchaseCardOWS({
        ...BASE_RESUME_OPTS,
        resume: { orderId: 'ord_expired', txHash: 'abad1dea'.repeat(8), phase: 'unpaid' },
      }),
    ).rejects.toThrow(/Order ord_expired failed/);

    // Expired is terminal — never consult the landed-check or resubmit
    // against an order the backend has already closed out.
    expect(checkLandedSpy).not.toHaveBeenCalled();
    expect(payViaContractOWSSpy).not.toHaveBeenCalled();
  });

  it('throws OrderFailedError for failed/refunded/rejected orders too, each without resubmitting', async () => {
    for (const phase of ['failed', 'refunded', 'rejected'] as const) {
      const { purchaseCardOWS, payViaContractOWSSpy } = await loadPurchaseCardOWSWithMocks({
        orderStatus: { phase },
        landedResult: 'dropped',
      });
      await expect(
        purchaseCardOWS({ ...BASE_RESUME_OPTS, resume: `ord_${phase}` }),
      ).rejects.toThrow(/Order ord_\w+ failed/);
      expect(payViaContractOWSSpy).not.toHaveBeenCalled();
    }
  });

  it('includes the refund txid in the error message when the order response carries one', async () => {
    const { purchaseCardOWS } = await loadPurchaseCardOWSWithMocks({
      orderStatus: {
        phase: 'refunded',
        refund: { stellar_txid: 'refund-tx-hash-123' },
      } as unknown as { phase: string },
      landedResult: 'dropped',
    });

    await expect(
      purchaseCardOWS({ ...BASE_RESUME_OPTS, resume: 'ord_expired_refunded' }),
    ).rejects.toThrow(/refund-tx-hash-123/);
  });

  it('waits conservatively on a bare-string resume with no prior tx context (no resubmit)', async () => {
    const { purchaseCardOWS, checkLandedSpy, payViaContractOWSSpy, waitForCardSpy } =
      await loadPurchaseCardOWSWithMocks({
        orderStatus: { phase: 'awaiting_payment' },
        landedResult: 'landed',
      });

    await purchaseCardOWS({ ...BASE_RESUME_OPTS, resume: 'ord_bare_string' });

    // No txHash was supplied (bare-string resume) — the landed-check has
    // nothing to check against, so it must not run, and we must wait
    // rather than risk resubmitting an unknown payment.
    expect(checkLandedSpy).not.toHaveBeenCalled();
    expect(payViaContractOWSSpy).not.toHaveBeenCalled();
    expect(waitForCardSpy).toHaveBeenCalledTimes(1);
  });

  it('waits when the backend reports an in-progress phase other than awaiting_payment', async () => {
    const { purchaseCardOWS, payViaContractOWSSpy, waitForCardSpy } =
      await loadPurchaseCardOWSWithMocks({
        orderStatus: { phase: 'processing' },
        landedResult: 'landed',
      });

    await purchaseCardOWS({
      ...BASE_RESUME_OPTS,
      resume: { orderId: 'ord_processing', txHash: 'beefbeef'.repeat(8), phase: 'unpaid' },
    });

    expect(payViaContractOWSSpy).not.toHaveBeenCalled();
    expect(waitForCardSpy).toHaveBeenCalledTimes(1);
  });

  it('loadLastOrder reads the fields the resume path relies on', () => {
    // Integration-level assertion: the file format the CLI writes
    // is the same format purchaseCardOWS receives via the CLI's
    // resume pass-through. This locks in the contract between the
    // two modules.
    writeLastOrderJson({
      orderId: 'integration-order',
      txHash: 'feedfacecafebabe'.repeat(4),
      phase: 'unpaid',
      savedAt: new Date().toISOString(),
    });
    const loaded = loadLastOrder();
    expect(loaded).toBeTruthy();
    expect(loaded?.orderId).toBe('integration-order');
    expect(loaded?.txHash).toBe('feedfacecafebabe'.repeat(4));
    expect(loaded?.phase).toBe('unpaid');
    expect(loaded?.savedAt).toBeDefined();
  });
});
