// `stellar_card batch-order --file orders.csv` — create multiple card orders
// from a validated CSV file and export their order IDs and statuses.

import * as fs from 'fs';
import * as path from 'path';

import { Stellar_CardClient } from '../client';
import type { OrderResponse } from '../client';

const REQUIRED_COLUMNS = ['amount', 'currency', 'merchant_id', 'memo'] as const;
const MAX_CSV_BYTES = 5 * 1024 * 1024;

export interface BatchOrderRow {
  amount: string;
  amountCents: number;
  currency: 'USD';
  merchantId: string;
  memo: string;
  rowNumber: number;
}

export interface BatchOrderResult {
  amount: string;
  currency: string;
  orderId: string;
  status: string;
  error: string;
}

export interface BatchOrderArgs {
  file?: string;
  output?: string;
  yes?: boolean;
  help?: boolean;
  invalid?: string;
}

export type BatchOrderClient = Pick<Stellar_CardClient, 'createOrder'>;

export interface BatchOrderDeps {
  client?: BatchOrderClient;
  confirm?: (prompt: string) => Promise<boolean>;
  readFile?: (filePath: string) => string;
  writeFile?: (filePath: string, content: string) => void;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/** Parse CSV rows with RFC 4180 quoting, escaped quotes, and multiline cells. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;

    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (
      closedQuote &&
      char !== ',' &&
      char !== '\r' &&
      char !== '\n' &&
      char !== ' ' &&
      char !== '\t'
    ) {
      throw new Error(`unexpected character after closing quote at CSV character ${index + 1}`);
    }
    if (closedQuote && (char === ' ' || char === '\t')) continue;
    if (char === '"') {
      if (cell.length > 0) throw new Error(`unexpected quote at CSV character ${index + 1}`);
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
      closedQuote = false;
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && input[index + 1] === '\n') index++;
      row.push(cell);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
      closedQuote = false;
    } else {
      cell += char;
    }
  }

  if (quoted) throw new Error('unterminated quoted field in CSV');
  if (cell.length > 0 || row.length > 0 || closedQuote) {
    row.push(cell);
    if (row.some((value) => value.trim() !== '')) rows.push(row);
  }
  return rows;
}

export function parseBatchOrderArgs(argv: string[]): BatchOrderArgs {
  const args: BatchOrderArgs = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '-h' || arg === '--help') args.help = true;
    else if (arg === '-y' || arg === '--yes') args.yes = true;
    else if (arg === '--file') {
      const value = argv[++index];
      if (!value || value.startsWith('-')) args.invalid = '--file requires a path';
      else args.file = value;
    } else if (arg.startsWith('--file=')) args.file = arg.slice('--file='.length);
    else if (arg === '--output') {
      const value = argv[++index];
      if (!value || value.startsWith('-')) args.invalid = '--output requires a path';
      else args.output = value;
    } else if (arg.startsWith('--output=')) args.output = arg.slice('--output='.length);
    else args.invalid = `unknown argument: ${arg}`;
  }
  return args;
}

function validateRows(rows: string[][]): BatchOrderRow[] {
  if (rows.length < 2) throw new Error('CSV must contain a header and at least one order row');

  const headers = rows[0]!.map((value) => value.trim().toLowerCase());
  const indexes = new Map<string, number>();
  headers.forEach((header, index) => {
    if (indexes.has(header)) throw new Error(`duplicate CSV column: ${header}`);
    indexes.set(header, index);
  });
  for (const column of REQUIRED_COLUMNS) {
    if (!indexes.has(column)) throw new Error(`missing required CSV column: ${column}`);
  }

  return rows.slice(1).map((values, index) => {
    const rowNumber = index + 2;
    const get = (column: (typeof REQUIRED_COLUMNS)[number]): string =>
      (values[indexes.get(column)!] ?? '').trim();
    const amount = get('amount');
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
      throw new Error(`CSV row ${rowNumber}: amount must be a decimal with up to 2 places`);
    }
    const amountCents = Math.round(Number(amount) * 100);
    if (amountCents < 1 || amountCents > 1_000_000) {
      throw new Error(`CSV row ${rowNumber}: amount must be between 0.01 and 10000.00`);
    }
    const currency = get('currency').toUpperCase();
    if (currency !== 'USD') {
      throw new Error(`CSV row ${rowNumber}: currency must be USD for card orders`);
    }
    if (!get('merchant_id')) throw new Error(`CSV row ${rowNumber}: merchant_id is required`);
    if (
      values.length > headers.length &&
      values.slice(headers.length).some((value) => value.trim())
    ) {
      throw new Error(`CSV row ${rowNumber}: contains more values than the header`);
    }
    return {
      amount: (amountCents / 100).toFixed(2),
      amountCents,
      currency,
      merchantId: get('merchant_id'),
      memo: get('memo'),
      rowNumber,
    };
  });
}

function defaultOutputPath(inputPath: string): string {
  const extension = path.extname(inputPath);
  const base = extension ? inputPath.slice(0, -extension.length) : inputPath;
  return `${base}-results.csv`;
}

function csvCell(value: string): string {
  const safeValue = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safeValue.replaceAll('"', '""')}"`;
}

export function serializeBatchResults(results: BatchOrderResult[]): string {
  const header = ['amount', 'currency', 'order_id', 'status', 'error'];
  const rows = results.map((result) => [
    result.amount,
    result.currency,
    result.orderId,
    result.status,
    result.error,
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

async function defaultConfirm(prompt: string): Promise<boolean> {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

function usage(write: (text: string) => void): void {
  write(`Usage: stellar_card batch-order --file <orders.csv> [--output <results.csv>] [--yes]

CSV columns: amount,currency,merchant_id,memo
Card amounts and currency are USD. Each row creates an order; payment is still
required before a card is issued. The default result file is <input>-results.csv.

Options:
  --file <path>       CSV file containing orders (required)
  --output <path>     Write the result summary to this path
  -y, --yes           Skip aggregate budget confirmation
  -h, --help          Show this message
`);
}

/** Create orders sequentially from CSV and export IDs/statuses, including row failures. */
export async function batchOrderCommand(
  argv: string[],
  deps: BatchOrderDeps = {},
): Promise<number> {
  const out = deps.out ?? ((text) => process.stdout.write(text));
  const err = deps.err ?? ((text) => process.stderr.write(text));
  const confirm = deps.confirm ?? defaultConfirm;
  const args = parseBatchOrderArgs(argv);

  if (args.help) {
    usage(out);
    return 0;
  }
  if (args.invalid) {
    err(`error: ${args.invalid}\n`);
    return 2;
  }
  if (!args.file) {
    err('error: --file <orders.csv> is required\n');
    return 2;
  }

  let rows: BatchOrderRow[];
  const outputPath = path.resolve(args.output ?? defaultOutputPath(args.file));
  if (outputPath === path.resolve(args.file)) {
    err('error: result output path must not overwrite the input CSV\n');
    return 2;
  }
  try {
    const content = (deps.readFile ?? ((filePath) => fs.readFileSync(filePath, 'utf8')))(args.file);
    if (Buffer.byteLength(content, 'utf8') > MAX_CSV_BYTES) {
      throw new Error(`CSV exceeds the ${MAX_CSV_BYTES}-byte size limit`);
    }
    const parsed = parseCsv(content.replace(/^\uFEFF/, ''));
    rows = validateRows(parsed);
  } catch (error) {
    err(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const totalCents = rows.reduce((total, row) => total + row.amountCents, 0);
  if (!args.yes) {
    const approved = await confirm(
      `Create ${rows.length} card orders totaling $${(totalCents / 100).toFixed(2)} USD? [y/N] `,
    );
    if (!approved) {
      err('Batch order cancelled.\n');
      return 0;
    }
  }

  let client: BatchOrderClient;
  try {
    client =
      deps.client ??
      new Stellar_CardClient({ apiKey: process.env.STELLAR_CARD_API_KEY || undefined });
  } catch (error) {
    err(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const results: BatchOrderResult[] = [];
  for (const [index, row] of rows.entries()) {
    try {
      const order: OrderResponse = await client.createOrder({
        amount_usdc: row.amount,
        metadata: {
          currency: row.currency,
          merchant_id: row.merchantId || undefined,
          memo: row.memo || undefined,
        },
      });
      results.push({
        amount: row.amount,
        currency: row.currency,
        orderId: order.order_id,
        status: order.status,
        error: '',
      });
    } catch (error) {
      results.push({
        amount: row.amount,
        currency: row.currency,
        orderId: '',
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const completed = index + 1;
    const width = 20;
    const filled = Math.round((completed / rows.length) * width);
    out(
      `\rBatch orders [${'#'.repeat(filled)}${'.'.repeat(width - filled)}] ${completed}/${rows.length}`,
    );
  }
  out('\n');

  try {
    (deps.writeFile ?? ((filePath, content) => fs.writeFileSync(filePath, content, 'utf8')))(
      outputPath,
      serializeBatchResults(results),
    );
  } catch (error) {
    err(
      `error: could not write result CSV: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const failed = results.filter((result) => result.status === 'error').length;
  out(`Created ${results.length - failed}/${results.length} orders. Results: ${outputPath}\n`);
  if (failed > 0) {
    err(`error: ${failed} order${failed === 1 ? '' : 's'} failed; see the result CSV\n`);
    return 1;
  }
  return 0;
}
