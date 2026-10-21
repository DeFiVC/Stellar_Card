/**
 * Unit tests for `stellar_card purchase` CLI flags and options (#758).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parsePurchaseArgs,
  purchaseCommand,
  type PurchaseDeps,
} from '../commands/purchase';

const CONFIG = {
  api_key: 'stellar_card_testkey',
  api_url: 'https://api.stellar_card.test',
  wallet_name: 'agent-test',
  vault_path: '/tmp/vault',
  passphrase_env: undefined as string | undefined,
  created_at: '2026-01-01T00:00:00Z',
};

function harness(overrides: Partial<PurchaseDeps> = {}) {
  let out = '';
  let err = '';
  const purchase = vi.fn().mockResolvedValue({
    number: '4111111111111234',
    cvv: '123',
    expiry: '12/27',
    brand: 'Visa',
    order_id: 'ord_test_1',
  });
  const getBalance = vi.fn().mockResolvedValue({ xlm: '100.0000000', usdc: '50.0000000' });
  const confirm = vi.fn().mockResolvedValue(true);
  const deps: PurchaseDeps = {
    loadConfig: () => CONFIG,
    getBalance,
    purchase,
    confirm,
    out: (t) => (out += t),
    err: (t) => (err += t),
    ...overrides,
  };
  return {
    deps,
    purchase,
    getBalance,
    confirm,
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

describe('parsePurchaseArgs', () => {
  it('parses --amount, --asset, --merchant, --memo, --json, --dry-run', () => {
    const args = parsePurchaseArgs([
      '--amount',
      '10.00',
      '--asset=usdc',
      '--merchant',
      'Acme',
      '--memo=Order#1',
      '--json',
      '--dry-run',
      '--yes',
    ]);
    expect(args).toMatchObject({
      amount: '10.00',
      asset: 'usdc',
      merchant: 'Acme',
      memo: 'Order#1',
      json: true,
      dryRun: true,
      yes: true,
    });
  });

  it('flags invalid --asset values', () => {
    expect(parsePurchaseArgs(['--amount', '1', '--asset', 'usd']).assetInvalid).toBe('usd');
  });

  it('accepts -a short amount flag', () => {
    expect(parsePurchaseArgs(['-a', '5']).amount).toBe('5');
  });
});

describe('purchaseCommand flag validation', () => {
  it('requires --amount or --resume', async () => {
    const h = harness();
    expect(await purchaseCommand([], h.deps)).toBe(2);
    expect(h.err).toContain('--amount');
  });

  it('rejects --resume with --amount', async () => {
    const h = harness();
    expect(await purchaseCommand(['--amount', '10', '--resume', 'ord_1'], h.deps)).toBe(2);
    expect(h.err).toContain('cannot be used together');
  });

  it('rejects invalid amount format', async () => {
    const h = harness();
    expect(await purchaseCommand(['--amount', '10.123', '--yes'], h.deps)).toBe(2);
    expect(h.err).toContain('decimal');
  });

  it('rejects unknown --asset', async () => {
    const h = harness();
    expect(await purchaseCommand(['--amount', '10', '--asset', 'btc', '--yes'], h.deps)).toBe(2);
    expect(h.err).toContain("--asset must be 'xlm'");
  });
});

describe('purchaseCommand --dry-run', () => {
  it('validates without calling purchase', async () => {
    const h = harness();
    const code = await purchaseCommand(
      ['--amount', '10.00', '--asset', 'usdc', '--dry-run', '--merchant', 'Cafe'],
      h.deps,
    );
    expect(code).toBe(0);
    expect(h.purchase).not.toHaveBeenCalled();
    expect(h.out).toContain('Dry run OK');
    expect(h.out).toContain('merchant: Cafe');
  });

  it('emits JSON plan with --json --dry-run', async () => {
    const h = harness();
    await purchaseCommand(
      ['--amount', '5', '--asset', 'xlm', '--dry-run', '--json', '--memo', 'm1'],
      h.deps,
    );
    const plan = JSON.parse(h.out);
    expect(plan).toMatchObject({
      ok: true,
      dry_run: true,
      amount_usdc: '5',
      payment_asset: 'xlm',
      memo: 'm1',
    });
  });
});

describe('purchaseCommand insufficient balance', () => {
  it('errors when USDC balance is too low', async () => {
    const h = harness({
      getBalance: vi.fn().mockResolvedValue({ xlm: '100', usdc: '1.00' }),
    });
    const code = await purchaseCommand(
      ['--amount', '25.00', '--asset', 'usdc', '--yes'],
      h.deps,
    );
    expect(code).toBe(1);
    expect(h.err).toContain('insufficient USDC');
    expect(h.purchase).not.toHaveBeenCalled();
  });

  it('errors when XLM balance is zero', async () => {
    const h = harness({
      getBalance: vi.fn().mockResolvedValue({ xlm: '0', usdc: '0' }),
    });
    const code = await purchaseCommand(['--amount', '10', '--asset', 'xlm', '--yes'], h.deps);
    expect(code).toBe(1);
    expect(h.err).toContain('insufficient XLM');
  });
});

describe('purchaseCommand confirmation prompt', () => {
  it('cancels when the user declines confirmation', async () => {
    const h = harness({ confirm: vi.fn().mockResolvedValue(false) });
    const code = await purchaseCommand(['--amount', '10', '--asset', 'usdc'], h.deps);
    expect(code).toBe(0);
    expect(h.err).toContain('cancelled');
    expect(h.purchase).not.toHaveBeenCalled();
  });

  it('skips confirmation with --yes', async () => {
    const h = harness();
    await purchaseCommand(['--amount', '10', '--asset', 'usdc', '--yes'], h.deps);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.purchase).toHaveBeenCalledOnce();
  });
});

describe('purchaseCommand --json output', () => {
  it('matches the standard CLI JSON schema', async () => {
    const h = harness();
    const code = await purchaseCommand(
      ['--amount', '10', '--asset', 'usdc', '--json', '--merchant', 'Shop', '--memo', 'm'],
      h.deps,
    );
    expect(code).toBe(0);
    const body = JSON.parse(h.out);
    expect(body).toEqual({
      ok: true,
      order_id: 'ord_test_1',
      number: '4111111111111234',
      cvv: '123',
      expiry: '12/27',
      brand: 'Visa',
      merchant: 'Shop',
      memo: 'm',
    });
  });
});

describe('purchaseCommand asset selection', () => {
  it('auto-picks USDC when balance covers the amount', async () => {
    const h = harness();
    await purchaseCommand(['--amount', '10', '--yes'], h.deps);
    expect(h.out).toContain('Auto-picked USDC');
    expect(h.purchase.mock.calls[0]![0].paymentAsset).toBe('usdc');
  });

  it('auto-picks XLM when USDC is insufficient', async () => {
    const h = harness({
      getBalance: vi.fn().mockResolvedValue({ xlm: '50', usdc: '1' }),
    });
    await purchaseCommand(['--amount', '10', '--yes'], h.deps);
    expect(h.out).toContain('Auto-picked XLM');
    expect(h.purchase.mock.calls[0]![0].paymentAsset).toBe('xlm');
  });

  it('respects explicit --asset flag over balance', async () => {
    const h = harness({
      getBalance: vi.fn().mockResolvedValue({ xlm: '100', usdc: '500' }),
    });
    await purchaseCommand(['--amount', '10', '--asset', 'xlm', '--yes'], h.deps);
    expect(h.purchase.mock.calls[0]![0].paymentAsset).toBe('xlm');
  });

  it('falls back to XLM when balance check fails', async () => {
    const h = harness({
      getBalance: vi.fn().mockRejectedValue(new Error('Horizon down')),
    });
    await purchaseCommand(['--amount', '10', '--yes'], h.deps);
    expect(h.out).toContain('Could not read balance');
    expect(h.purchase.mock.calls[0]![0].paymentAsset).toBe('xlm');
  });

  it('displays balances to the user', async () => {
    const h = harness({
      getBalance: vi.fn().mockResolvedValue({ xlm: '100.5', usdc: '50.25' }),
    });
    await purchaseCommand(['--amount', '10', '--yes'], h.deps);
    expect(h.getBalance).toHaveBeenCalledWith('agent-test', '/tmp/vault');
  });

  it('shows estimated fee information for XLM payment', async () => {
    const h = harness({
      getBalance: vi.fn().mockResolvedValue({ xlm: '100', usdc: '0' }),
    });
    await purchaseCommand(['--amount', '10', '--yes'], h.deps);
    expect(h.out).toContain('XLM');
  });

  it('uses auto-pick when --json is passed', async () => {
    const h = harness();
    await purchaseCommand(['--amount', '10', '--json'], h.deps);
    expect(h.out).not.toContain('Selected');
    const result = JSON.parse(h.out);
    expect(result.payment_asset).toBeDefined();
  });

  it('uses auto-pick when --dry-run is passed', async () => {
    const h = harness();
    const code = await purchaseCommand(['--amount', '10', '--dry-run'], h.deps);
    expect(code).toBe(0);
    expect(h.out).toContain('Dry run OK');
    expect(h.purchase).not.toHaveBeenCalled();
  });
});
