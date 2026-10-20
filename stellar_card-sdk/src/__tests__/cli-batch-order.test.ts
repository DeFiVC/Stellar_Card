import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  batchOrderCommand,
  parseBatchOrderArgs,
  parseCsv,
  type BatchOrderClient,
  type BatchOrderDeps,
} from '../commands/batch-order';

const tempDirs: string[] = [];

function fixture(): { input: string; output: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-card-batch-'));
  tempDirs.push(directory);
  return {
    input: path.join(directory, 'orders.csv'),
    output: path.join(directory, 'results.csv'),
  };
}

function harness(overrides: Partial<BatchOrderDeps> = {}) {
  let out = '';
  let err = '';
  const client: BatchOrderClient = {
    createOrder: vi.fn().mockImplementation(async () => ({
      order_id: `ord_${String((client.createOrder as ReturnType<typeof vi.fn>).mock.calls.length)}`,
      status: 'pending_payment',
    })),
  } as unknown as BatchOrderClient;
  const confirm = vi.fn().mockResolvedValue(true);
  const deps: BatchOrderDeps = {
    client,
    confirm,
    out: (text) => (out += text),
    err: (text) => (err += text),
    ...overrides,
  };
  return {
    deps,
    client,
    confirm,
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('parseBatchOrderArgs', () => {
  it('parses file, output, and yes flags', () => {
    expect(parseBatchOrderArgs(['--file=orders.csv', '--output', 'summary.csv', '-y'])).toEqual({
      file: 'orders.csv',
      output: 'summary.csv',
      yes: true,
    });
  });
});

describe('parseCsv', () => {
  it('handles commas, escaped quotes, and newlines inside quoted fields', () => {
    expect(parseCsv('a,b\r\n"merchant, one","memo ""quoted""\ncontinued"')).toEqual([
      ['a', 'b'],
      ['merchant, one', 'memo "quoted"\ncontinued'],
    ]);
  });
});

describe('batchOrderCommand', () => {
  it('validates all rows, confirms total budget, submits sequentially, and exports results', async () => {
    const files = fixture();
    fs.writeFileSync(
      files.input,
      'amount,currency,merchant_id,memo\n10,USD,merchant-1,"launch, office"\n5.50,USD,merchant-2,"batch ""two"""\n',
    );
    let active = 0;
    let maxActive = 0;
    const createOrder = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active--;
      return { order_id: `ord_${createOrder.mock.calls.length}`, status: 'pending_payment' };
    });
    const confirm = vi.fn().mockResolvedValue(true);
    const h = harness({
      client: { createOrder } as unknown as BatchOrderClient,
      confirm,
    });

    const result = await batchOrderCommand(
      ['--file', files.input, '--output', files.output],
      h.deps,
    );

    expect(result).toBe(0);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('$15.50 USD'));
    expect(maxActive).toBe(1);
    expect(createOrder).toHaveBeenNthCalledWith(1, {
      amount_usdc: '10.00',
      metadata: { currency: 'USD', merchant_id: 'merchant-1', memo: 'launch, office' },
    });
    expect(createOrder).toHaveBeenNthCalledWith(2, {
      amount_usdc: '5.50',
      metadata: { currency: 'USD', merchant_id: 'merchant-2', memo: 'batch "two"' },
    });
    expect(h.out).toContain('2/2');
    expect(fs.readFileSync(files.output, 'utf8')).toContain(
      '"10.00","USD","ord_1","pending_payment",""',
    );
  });

  it('rejects invalid rows before prompting or creating any orders', async () => {
    const files = fixture();
    fs.writeFileSync(files.input, 'amount,currency,merchant_id,memo\n10001,USD,m-1,too much\n');
    const h = harness();

    expect(await batchOrderCommand(['--file', files.input], h.deps)).toBe(2);
    expect(h.err).toContain('between 0.01 and 10000.00');
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.client.createOrder).not.toHaveBeenCalled();
  });

  it('does not submit orders when the aggregate confirmation is declined', async () => {
    const files = fixture();
    fs.writeFileSync(files.input, 'amount,currency,merchant_id,memo\n1.25,USD,m-1,test\n');
    const h = harness({ confirm: vi.fn().mockResolvedValue(false) });

    expect(await batchOrderCommand(['--file', files.input], h.deps)).toBe(0);
    expect(h.client.createOrder).not.toHaveBeenCalled();
    expect(h.err).toContain('cancelled');
  });

  it('continues after a failed row and exports its error status', async () => {
    const files = fixture();
    fs.writeFileSync(
      files.input,
      'amount,currency,merchant_id,memo\n1,USD,m-1,first\n2,USD,m-2,second\n',
    );
    const createOrder = vi
      .fn()
      .mockRejectedValueOnce(new Error('service unavailable'))
      .mockResolvedValueOnce({ order_id: 'ord_2', status: 'pending_payment' });
    const h = harness({ client: { createOrder } as unknown as BatchOrderClient });

    expect(
      await batchOrderCommand(['--file', files.input, '--output', files.output, '--yes'], h.deps),
    ).toBe(1);
    expect(createOrder).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(files.output, 'utf8')).toContain(
      '"1.00","USD","","error","service unavailable"',
    );
    expect(fs.readFileSync(files.output, 'utf8')).toContain('"2.00","USD","ord_2"');
  });
});
