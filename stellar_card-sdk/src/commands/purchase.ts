// `stellar_card purchase --amount 10 [--asset xlm|usdc]` — one-command
// card purchase. Loads creds from the on-disk config written by
// `stellar_card onboard`, opens the order, pays the Soroban contract
// from the local OWS wallet, waits for the SSE stream to report
// the card ready, and prints the card details.
//
// Designed so the cautious-agent flow is a single shell invocation:
// the agent doesn't have to write any JavaScript or guess at the
// SDK surface area.
//
// Resume: if a purchase fails mid-flight (Soroban RPC timeout, network
// blip, etc.), the order id is saved to ~/.stellar_card/last-order and the
// user can retry with `stellar_card purchase --resume <order-id>`.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

import { loadStellar_CardConfig } from '../config';
import { purchaseCardOWS, getOWSBalance } from '../ows';
import { ResumableError, OrderFailedError } from '../errors';

export interface PurchaseArgs {
  amount?: string;
  asset?: 'xlm' | 'usdc';
  walletName?: string;
  vaultPath?: string;
  passphraseEnv?: string;
  resume?: string;
  merchant?: string;
  memo?: string;
  json?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  help?: boolean;
}

export interface PurchaseArgsParsed extends PurchaseArgs {
  assetInvalid?: string;
}

/** Injectable deps so unit tests can drive confirmation / purchase without I/O. */
export interface PurchaseDeps {
  loadConfig?: typeof loadStellar_CardConfig;
  getBalance?: typeof getOWSBalance;
  purchase?: typeof purchaseCardOWS;
  confirm?: (prompt: string) => Promise<boolean>;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

export function parsePurchaseArgs(argv: string[]): PurchaseArgsParsed {
  const out: PurchaseArgsParsed = {};
  const takeAsset = (v: string | undefined): void => {
    if (v === undefined) return;
    if (v === 'xlm' || v === 'usdc') {
      out.asset = v;
    } else if (v === 'auto') {
      // 'auto' is the default when --asset isn't passed; we accept it
      // as an explicit flag too so help-reading users who type what
      // they saw in the help text aren't surprised.
      out.asset = undefined;
    } else {
      out.assetInvalid = v;
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '-h' || arg === '--help') out.help = true;
    else if (arg === '-a' || arg === '--amount') out.amount = argv[++i];
    else if (arg.startsWith('--amount=')) out.amount = arg.slice('--amount='.length);
    else if (arg === '--asset') takeAsset(argv[++i]);
    else if (arg.startsWith('--asset=')) takeAsset(arg.slice('--asset='.length));
    else if (arg === '--wallet-name') out.walletName = argv[++i];
    else if (arg.startsWith('--wallet-name=')) out.walletName = arg.slice('--wallet-name='.length);
    else if (arg === '--vault-path') out.vaultPath = argv[++i];
    else if (arg.startsWith('--vault-path=')) out.vaultPath = arg.slice('--vault-path='.length);
    else if (arg === '--passphrase-env') out.passphraseEnv = argv[++i];
    else if (arg.startsWith('--passphrase-env='))
      out.passphraseEnv = arg.slice('--passphrase-env='.length);
    else if (arg === '--resume') out.resume = argv[++i];
    else if (arg.startsWith('--resume=')) out.resume = arg.slice('--resume='.length);
    else if (arg === '--merchant') out.merchant = argv[++i];
    else if (arg.startsWith('--merchant=')) out.merchant = arg.slice('--merchant='.length);
    else if (arg === '--memo') out.memo = argv[++i];
    else if (arg.startsWith('--memo=')) out.memo = arg.slice('--memo='.length);
    else if (arg === '--json') out.json = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '-y' || arg === '--yes') out.yes = true;
  }
  return out;
}

/** @deprecated Use {@link parsePurchaseArgs}. */
const parseArgs = parsePurchaseArgs;

function usage(errWrite: (t: string) => void = (t) => process.stderr.write(t)): void {
  errWrite(`Usage: stellar_card purchase --amount <USDC> [--asset xlm|usdc]
       stellar_card purchase --resume <order-id>

Buys a virtual Visa card for the given USD value using the credentials
and wallet set up by 'stellar_card onboard'. Reads ~/.stellar_card/config.json
for the api key, wallet name, vault path, and passphrase env var.

When running interactively (no --yes, --json, or --dry-run), displays wallet
balances and prompts you to select payment currency (USDC or XLM).

Options:
  -a, --amount <USDC>        Card value in USD. Required for new purchases.
  --asset xlm|usdc           Which asset to pay with. Default: interactive prompt
                             (if TTY), or auto-pick (if batch) — USDC if wallet
                             has enough, otherwise XLM. Pass an explicit value
                             to force one.
  --merchant <name>          Optional merchant label stored on the order.
  --memo <text>              Optional memo attached to the order metadata.
  --json                     Emit machine-readable JSON on success. Skips interactive prompt.
  --dry-run                  Validate flags and balances without purchasing.
  -y, --yes                  Skip the interactive confirmation prompt.
  --wallet-name <name>       Override the wallet name from config.json
  --vault-path <path>        Override the vault path from config.json
  --passphrase-env <ENVNAME> Override the passphrase env var from config.json.
                             The passphrase value is read from process.env at
                             call time and never logged.
  --resume <order-id>        Resume a purchase that failed mid-flight. Omit --amount.
  -h, --help                 Show this message

Examples:
  stellar_card purchase --amount 10                 # Interactive: shows balances, prompts currency
  stellar_card purchase --amount 5 --asset usdc     # Force USDC payment
  stellar_card purchase --amount 10 --yes --asset xlm  # Batch: XLM, no prompt
  stellar_card purchase --amount 10 --dry-run --json
  stellar_card purchase --resume a94d18cc-...       # pick up an interrupted purchase
`);
}

async function defaultConfirm(prompt: string): Promise<boolean> {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
    });
  });
}

async function promptForCurrency(
  xlmBalance: string,
  usdcBalance: string,
  amountUsdc: string,
): Promise<'xlm' | 'usdc'> {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    const xlmBal = parseFloat(xlmBalance || '0');
    const usdcBal = parseFloat(usdcBalance || '0');
    const want = parseFloat(amountUsdc);

    process.stdout.write('\n');
    process.stdout.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    process.stdout.write(' Available Balances\n');
    process.stdout.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    process.stdout.write(`  XLM:  ${xlmBal.toFixed(2)}\n`);
    process.stdout.write(`  USDC: ${usdcBal.toFixed(2)}\n`);
    process.stdout.write(`\n  Order total: $${want.toFixed(2)}\n`);
    process.stdout.write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n');

    const question =
      usdcBal >= want && want > 0
        ? 'Select currency [1=USDC, 2=XLM, 3=cancel]: '
        : 'Select currency [1=USDC (insufficient), 2=XLM, 3=cancel]: ';

    rl.question(question, (answer) => {
      rl.close();
      const choice = answer.trim().toLowerCase();
      if (choice === '1' || choice === 'usdc') {
        resolve('usdc');
      } else if (choice === '2' || choice === 'xlm') {
        resolve('xlm');
      } else {
        // Default to cancel (empty answer or '3')
        resolve('xlm'); // Return value won't be used if user cancels
      }
    });
  });
}

function lastOrderFile(): string {
  const dir = process.env.CARDS402_CONFIG_DIR || path.join(os.homedir(), '.stellar_card');
  return path.join(dir, 'last-order');
}

/**
 * Serialised form of the last-attempted purchase that errored out with
 * a ResumableError. Captured context lets `--resume` make an informed
 * decision instead of defaulting to "wait 5 minutes for the SSE stream
 * to say anything".
 *
 * - `orderId`: the stellar_card order id (always present)
 * - `txHash`:  Soroban tx hash if the client-side submit got far enough
 *              to capture one. Absent if the error fired before submit
 *              (e.g. trustline add failed).
 * - `phase`:   'unpaid' if the payment submit didn't reach confirmed-
 *              on-ledger, 'paid' if the client saw it land but the
 *              post-payment wait/step failed. Mirrors the field on
 *              ResumableError.
 * - `savedAt`: ISO-8601 of the save. Used by the resume path to decide
 *              how aggressively to retry — if the save is older than
 *              the Soroban inclusion window, a still-missing tx is
 *              almost certainly dropped.
 */
export interface LastOrderState {
  orderId: string;
  txHash?: string;
  phase?: 'unpaid' | 'paid';
  savedAt?: string;
}

function saveLastOrder(state: LastOrderState): void {
  try {
    const p = lastOrderFile();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    // Atomic write via tmp + rename, same pattern as config.ts. An
    // interrupted save would otherwise leave a truncated JSON that
    // loadLastOrder would silently skip — losing the resume context
    // for the very error that triggered the save.
    const body = JSON.stringify({ savedAt: new Date().toISOString(), ...state }, null, 2);
    // F3-purchase (2026-04-16): use crypto.randomBytes for the temp
    // suffix instead of process.pid alone. PID is predictable and
    // collision-prone across container restarts that recycle PIDs.
    // Matches config.ts's F3-config hardening.
    const tmp = `${p}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, p);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* temp not created */
      }
      throw new Error('save failed');
    }
    // Belt-and-braces mode enforcement — some filesystems drop the
    // mode on rename.
    try {
      fs.chmodSync(p, 0o600);
    } catch {
      /* non-fatal */
    }
  } catch {
    // F2-purchase (2026-04-16): warn on save failure instead of
    // swallowing silently. Pre-fix, a disk-full or permission-denied
    // error produced zero signal — the purchase output said "saved to
    // ~/.stellar_card/last-order" and told the user to --resume, but the
    // file didn't exist. Now we print a warning so the user knows to
    // copy the order ID from the error message manually.
    process.stderr.write(
      '⚠ Could not save resume state to ~/.stellar_card/last-order.\n' +
        '  Copy the order ID from the error above if you need to --resume later.\n',
    );
  }
}

/**
 * Read the last-order file. Supports both the current JSON shape and
 * the legacy line-based format (`<orderId>\n`) that older versions
 * wrote — so a user who ran an older CLI and then upgraded mid-purchase
 * doesn't lose their resume context. Returns null if the file is
 * missing, unreadable, or has no parseable orderId.
 */
// F1-purchase (2026-04-16): size cap matching config.ts's MAX_CONFIG_BYTES.
// The last-order file is tiny (<1 KB typically). A multi-GB file from disk
// corruption or a symlink to a large file would OOM the process.
const MAX_LAST_ORDER_BYTES = 16 * 1024;

export function loadLastOrder(): LastOrderState | null {
  try {
    // F1-purchase: check size before reading.
    const stat = fs.statSync(lastOrderFile());
    if (stat.size > MAX_LAST_ORDER_BYTES) return null;
    const raw = fs.readFileSync(lastOrderFile(), 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('{')) {
      // JSON form
      const parsed = JSON.parse(trimmed) as Partial<LastOrderState>;
      if (!parsed.orderId || typeof parsed.orderId !== 'string') return null;
      return {
        orderId: parsed.orderId,
        txHash: typeof parsed.txHash === 'string' ? parsed.txHash : undefined,
        phase: parsed.phase === 'paid' || parsed.phase === 'unpaid' ? parsed.phase : undefined,
        savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : undefined,
      };
    }
    // Legacy bare-line form — first line is the order id.
    const orderId = trimmed.split('\n')[0]?.trim();
    if (!orderId) return null;
    return { orderId };
  } catch {
    return null;
  }
}

function clearLastOrder(): void {
  try {
    fs.unlinkSync(lastOrderFile());
  } catch {
    /* non-fatal */
  }
}

function printCard(
  card: {
    number: string;
    cvv: string;
    expiry: string;
    brand: string | null;
    order_id: string;
  },
  write: (text: string) => void = (t) => process.stdout.write(t),
): void {
  write('\n');
  write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  write(' Card delivered\n');
  write('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  write(`  Number: ${card.number}\n`);
  write(`  CVV:    ${card.cvv}\n`);
  write(`  Expiry: ${card.expiry}\n`);
  if (card.brand) write(`  Brand:  ${card.brand}\n`);
  write(`  Order:  ${card.order_id}\n`);
  write('\n');
  write(
    'The card details above are sensitive — save them to a secrets store immediately and do not log them.\n',
  );
}

export async function purchaseCommand(argv: string[], deps: PurchaseDeps = {}): Promise<number> {
  const out = deps.out ?? ((t) => process.stdout.write(t));
  const err = deps.err ?? ((t) => process.stderr.write(t));
  const loadConfig = deps.loadConfig ?? loadStellar_CardConfig;
  const getBalance = deps.getBalance ?? getOWSBalance;
  const purchase = deps.purchase ?? purchaseCardOWS;
  const confirm = deps.confirm ?? defaultConfirm;

  const args = parseArgs(argv);
  if (args.help) {
    usage(err);
    return 0;
  }

  // Reject unknown --asset values up front so `--asset usd` doesn't
  // silently fall through to the auto-pick path.
  if (args.assetInvalid) {
    err(`error: --asset must be 'xlm', 'usdc', or 'auto' (got: ${args.assetInvalid})\n`);
    return 2;
  }

  // --resume and --amount are mutually exclusive; --resume doesn't need --amount.
  if (args.resume && args.amount) {
    err('error: --resume and --amount cannot be used together\n');
    return 2;
  }
  if (!args.resume && !args.amount) {
    err('error: --amount <USDC> is required (or --resume <order-id>)\n\n');
    usage(err);
    return 2;
  }
  if (args.amount) {
    // Bounds mirror backend/src/api/orders.js and the MCP tool: decimal
    // string with ≤2 fractional digits, min $0.01, max $10,000. Fail
    // locally so the CLI gives a specific error instead of a backend 400.
    if (!/^\d+(\.\d{1,2})?$/.test(args.amount)) {
      err(
        `error: --amount must be a decimal string with up to 2 decimal places (got: ${args.amount})\n`,
      );
      return 2;
    }
    const amt = parseFloat(args.amount);
    if (amt < 0.01) {
      err('error: --amount must be at least 0.01 (one US cent)\n');
      return 2;
    }
    if (amt > 10000) {
      err(
        "error: --amount cannot exceed 10000 (Pathward's per-card balance ceiling). Issue multiple cards for larger spends.\n",
      );
      return 2;
    }
  }

  const config = loadConfig();
  if (!config) {
    err(
      `error: no stellar_card config found at ~/.stellar_card/config.json

Run 'stellar_card onboard --claim <code>' first to set up credentials.
Your operator can mint a claim code from https://stellar_card.com/dashboard.
`,
    );
    return 1;
  }

  // Resolve wallet name. The onboard command writes a unique wallet_name
  // to config (derived from the claim code suffix) specifically to avoid
  // cross-agent collisions. Falling back to a static default here would
  // reintroduce the bug onboard.ts closed. If wallet_name is missing,
  // the config is from an old onboarding or was hand-edited — either way
  // we refuse to proceed rather than silently colliding.
  const walletName = args.walletName || config.wallet_name;
  if (!walletName) {
    err(
      'error: no wallet_name in ~/.stellar_card/config.json and no --wallet-name passed.\n' +
        "Either pass --wallet-name <name>, or re-run 'stellar_card onboard --claim <code>'\n" +
        'to write a fresh config with a unique wallet name.\n',
    );
    return 1;
  }

  // F12: vault_path and passphrase_env both come from config first, then
  // CLI overrides. The passphrase value is read from process.env at call
  // time; only the env var NAME is ever stored in config.
  const vaultPath = args.vaultPath ?? config.vault_path;
  const passphraseEnv = args.passphraseEnv ?? config.passphrase_env;
  const passphrase = passphraseEnv ? process.env[passphraseEnv] : undefined;
  if (passphraseEnv && !passphrase) {
    err(
      `error: --passphrase-env ${passphraseEnv} is set in config but the env var is empty.\n` +
        `Set ${passphraseEnv} to your wallet passphrase before running purchase.\n`,
    );
    return 2;
  }

  // Resolve the payment asset. If the user didn't pass --asset we either:
  // - show interactive prompt (if TTY and no batch flags)
  // - auto-pick based on balance (if batch mode)
  // Rule:
  //   - explicit --asset wins always
  //   - on resume, asset doesn't matter (the order is already paid or
  //     waiting for an existing payment)
  //   - interactive prompt if TTY and no --yes/--json/--dry-run
  //   - otherwise: auto-pick USDC if balance covers, else XLM
  let paymentAsset: 'xlm' | 'usdc';
  let balance: { xlm: string; usdc: string } | null = null;
  if (args.asset) {
    paymentAsset = args.asset;
  } else if (args.resume) {
    paymentAsset = 'xlm'; // unused on resume, any value is fine
  } else {
    try {
      balance = await getBalance(walletName, vaultPath);
      const usdcBal = parseFloat(balance.usdc || '0');
      const xlmBal = parseFloat(balance.xlm || '0');
      const wantUsdc = parseFloat(args.amount || '0');

      // Interactive prompt if TTY and not in batch mode
      if (
        !args.yes &&
        !args.json &&
        !args.dryRun &&
        process.stdin.isTTY &&
        process.stdout.isTTY
      ) {
        paymentAsset = await promptForCurrency(
          balance.xlm || '0',
          balance.usdc || '0',
          args.amount || '0',
        );
        if (paymentAsset === 'usdc') {
          out(
            `→ Selected USDC (wallet has ${usdcBal.toFixed(2)} USDC; covers $${wantUsdc.toFixed(2)})\n`,
          );
        } else {
          out(
            `→ Selected XLM (wallet has ${xlmBal.toFixed(2)} XLM; estimated fee ${(wantUsdc * 0.02).toFixed(2)} USDC)\n`,
          );
        }
      } else {
        // Auto-pick for batch mode
        if (usdcBal >= wantUsdc && wantUsdc > 0) {
          paymentAsset = 'usdc';
          out(
            `→ Auto-picked USDC (wallet has ${usdcBal.toFixed(2)} USDC; covers $${wantUsdc.toFixed(2)})\n`,
          );
        } else {
          paymentAsset = 'xlm';
          if (usdcBal > 0) {
            out(
              `→ Auto-picked XLM (wallet has only ${usdcBal.toFixed(2)} USDC; needs $${wantUsdc.toFixed(2)})\n`,
            );
          } else {
            out(`→ Auto-picked XLM (no USDC in wallet)\n`);
          }
        }
      }
    } catch {
      // Horizon down or unactivated wallet — fall back to XLM (no
      // trustline required) and let payViaContractOWS surface the real
      // error if the wallet really has nothing.
      paymentAsset = 'xlm';
      out(
        `→ Could not read balance from Horizon — defaulting to XLM. Pass --asset usdc to override.\n`,
      );
    }
  }

  // Insufficient-balance guard for explicit asset selection / dry-run.
  if (!args.resume && args.amount) {
    try {
      if (!balance) balance = await getBalance(walletName, vaultPath);
      const want = parseFloat(args.amount);
      if (paymentAsset === 'usdc') {
        const usdcBal = parseFloat(balance.usdc || '0');
        if (usdcBal < want) {
          err(
            `error: insufficient USDC balance (have ${usdcBal.toFixed(2)}, need ${want.toFixed(2)})\n`,
          );
          return 1;
        }
      } else if (paymentAsset === 'xlm') {
        const xlmBal = parseFloat(balance.xlm || '0');
        // XLM amount is DEX-quoted later; only block obviously empty wallets.
        if (xlmBal <= 0) {
          err('error: insufficient XLM balance (wallet has 0 XLM)\n');
          return 1;
        }
      }
    } catch {
      // Balance check is best-effort when Horizon is down; dry-run still reports.
      if (args.dryRun) {
        err('error: could not read wallet balance for --dry-run\n');
        return 1;
      }
    }
  }

  // Dry-run: validate and report the plan without purchasing.
  if (args.dryRun) {
    const plan = {
      ok: true,
      dry_run: true,
      amount_usdc: args.amount ?? null,
      payment_asset: paymentAsset,
      wallet_name: walletName,
      merchant: args.merchant ?? null,
      memo: args.memo ?? null,
      resume: args.resume ?? null,
    };
    if (args.json) {
      out(JSON.stringify(plan, null, 2) + '\n');
    } else {
      out(
        `Dry run OK — would purchase $${args.amount} via ${paymentAsset.toUpperCase()}` +
          (args.merchant ? ` (merchant: ${args.merchant})` : '') +
          (args.memo ? ` (memo: ${args.memo})` : '') +
          `\n`,
      );
    }
    return 0;
  }

  // Interactive confirmation unless --yes / --json / --resume.
  if (!args.yes && !args.json && !args.resume && args.amount) {
    const ok = await confirm(
      `Purchase $${args.amount} card paying with ${paymentAsset.toUpperCase()}? [y/N] `,
    );
    if (!ok) {
      err('Purchase cancelled.\n');
      return 0;
    }
  }

  // Enrich the resume pass-through with saved txHash / phase context
  // from the last-order file. If the user's --resume orderId matches
  // the saved state, the SDK can make an informed decision about
  // whether to wait (tx still pending), skip-to-waitForCard (tx
  // landed), or re-submit (tx dropped). Without this enrichment,
  // --resume defaulted to "wait the full timeout" even when the
  // original tx was provably dropped pre-apply.
  let resumeArg:
    | string
    | { orderId: string; txHash?: string; phase?: 'unpaid' | 'paid' }
    | undefined;
  if (args.resume) {
    const saved = loadLastOrder();
    if (saved && saved.orderId === args.resume) {
      resumeArg = {
        orderId: saved.orderId,
        txHash: saved.txHash,
        phase: saved.phase,
      };
      out(
        `→ Resuming order ${args.resume}` +
          (saved.txHash ? ` (prior tx: ${saved.txHash.slice(0, 8)}…)` : '') +
          `…\n`,
      );
    } else {
      // User passed a --resume id that doesn't match last-order, or
      // there is no last-order. Fall back to the bare-string form —
      // conservative "wait for backend" behavior.
      resumeArg = args.resume;
      out(`→ Resuming order ${args.resume}…\n`);
    }
  } else if (!args.json) {
    out(`→ Purchasing $${args.amount} card via ${paymentAsset.toUpperCase()}…\n`);
  }

  try {
    const card = await purchase({
      apiKey: config.api_key,
      baseUrl: config.api_url,
      walletName,
      // amount is unused on resume but the type requires it; pass '0' safely.
      amountUsdc: args.amount ?? '0',
      paymentAsset,
      passphrase,
      vaultPath,
      ...(resumeArg ? { resume: resumeArg } : {}),
    });
    clearLastOrder();
    if (args.json) {
      out(
        JSON.stringify(
          {
            ok: true,
            order_id: card.order_id,
            number: card.number,
            cvv: card.cvv,
            expiry: card.expiry,
            brand: card.brand,
            merchant: args.merchant ?? null,
            memo: args.memo ?? null,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      printCard(card, out);
    }
    return 0;
  } catch (e) {
    if (e instanceof OrderFailedError) {
      err(`\nerror: ${e.message}\n`);
      clearLastOrder();
      return 1;
    }
    if (e instanceof ResumableError) {
      // Preserve the full context — txHash + phase — so the next
      // --resume run can decide whether the prior submit landed.
      saveLastOrder({
        orderId: e.orderId,
        txHash: e.txHash,
        phase: e.phase,
      });
      err(`\nerror: ${e.message}\n`);
      err(
        `\nYour payment may still be processing on-chain. The stellar_card backend will\n` +
          `credit the order if the transaction finalizes. Resume with:\n\n` +
          `  stellar_card purchase --resume ${e.orderId}\n\n` +
          `(saved to ~/.stellar_card/last-order)\n`,
      );
      return 1;
    }
    const msg = e instanceof Error ? e.message : String(e);
    err(`error: purchase failed: ${msg}\n`);
    return 1;
  }
}
