// `stellar_card logs` — view recent audit events (API calls, card
// authorizations, webhook deliveries) for the configured API key (#731).
//
// Auth: STELLAR_CARD_API_KEY env var, else the client's normal resolution
// (CARDS402_API_KEY / ~/.stellar_card/config.json) — same convention as
// `status` / `balance`.

import { Stellar_CardClient } from '../client';
import type { AuditLogEntry } from '../client';

type LogsClient = Pick<Stellar_CardClient, 'getAuditLogs'>;

export interface LogsCliDeps {
  client?: LogsClient;
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** Force colors on/off. Defaults to stdout TTY detection + NO_COLOR. */
  color?: boolean;
  /** Abort signal to stop a `--tail` loop (used by tests; CLI wires SIGINT). */
  signal?: AbortSignal;
}

const COLORS = { green: '\x1b[32m', red: '\x1b[31m', reset: '\x1b[0m' };

function resultColor(result: string): keyof typeof COLORS {
  return result.toLowerCase() === 'success' ? 'green' : 'red';
}

function badge(result: string, color: boolean): string {
  const label = result.toUpperCase();
  return color ? `${COLORS[resultColor(result)]}${label}${COLORS.reset}` : label;
}

/** Render audit log entries as an aligned text table. Colors are applied after padding. */
export function renderLogsTable(rows: AuditLogEntry[], color: boolean): string {
  const headers = ['Timestamp', 'Action', 'Actor', 'Result'];
  const cells = rows.map((r) => [r.timestamp, r.action, r.actor, r.result.toUpperCase()]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...(cells.length ? cells.map((c) => c[i]!.length) : [0])),
  );
  const line = (c: string[]): string =>
    c
      .map((v, i) => v.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  const headerLine = line(headers.map((h) => h.toUpperCase()));
  const body = cells.map((c, idx) => {
    const padded = line(c);
    if (!color) return padded;
    const raw = c[3]!;
    return padded.replace(raw, badge(rows[idx]!.result, true));
  });
  return [headerLine, line(widths.map((w) => '-'.repeat(w))), ...body].join('\n') + '\n';
}

interface ParsedArgs {
  json: boolean;
  tail: boolean;
  action?: string;
  limit: number;
  intervalMs: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  let json = false;
  let tail = false;
  let action: string | undefined;
  let limit = 20;
  let intervalMs = 3000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') {
      json = true;
    } else if (a === '--tail') {
      tail = true;
    } else if (a === '--action') {
      action = argv[++i];
    } else if (a.startsWith('--action=')) {
      action = a.slice('--action='.length);
    } else if (a === '--limit') {
      limit = Number(argv[++i]);
    } else if (a.startsWith('--limit=')) {
      limit = Number(a.slice('--limit='.length));
    } else if (a === '--interval') {
      intervalMs = Number(argv[++i]);
    } else if (a.startsWith('--interval=')) {
      intervalMs = Number(a.slice('--interval='.length));
    }
  }
  return { json, tail, action, limit, intervalMs };
}

function resolve(deps: LogsCliDeps): Required<Omit<LogsCliDeps, 'client' | 'signal'>> & {
  client: () => LogsClient;
  signal?: AbortSignal;
} {
  return {
    client: () =>
      deps.client ??
      new Stellar_CardClient({ apiKey: process.env.STELLAR_CARD_API_KEY || undefined }),
    out: deps.out ?? ((t) => process.stdout.write(t)),
    err: deps.err ?? ((t) => process.stderr.write(t)),
    color: deps.color ?? (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR),
    signal: deps.signal,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        res();
      },
      { once: true },
    );
  });
}

/**
 * `stellar_card logs [--action <name>] [--limit <n>] [--tail] [--json]`
 *
 * Without `--tail`, fetches one page of recent audit events and renders
 * them (or prints raw JSON with `--json`). With `--tail`, polls the same
 * endpoint on an interval and prints only newly-seen entries (by `id`)
 * until aborted via `deps.signal` (wired to SIGINT by the CLI dispatcher).
 */
export async function logsCommand(argv: string[], deps: LogsCliDeps = {}): Promise<number> {
  const { client, out, err, color, signal } = resolve(deps);
  const { json, tail, action, limit, intervalMs } = parseArgs(argv);

  const printPage = (entries: AuditLogEntry[]): void => {
    if (json) {
      out(`${JSON.stringify(entries, null, 2)}\n`);
      return;
    }
    if (entries.length === 0) {
      out('No audit events found.\n');
      return;
    }
    out(renderLogsTable(entries, color && !json));
  };

  try {
    const c = client();

    if (!tail) {
      const entries = await c.getAuditLogs({ action, limit });
      printPage(entries);
      return 0;
    }

    // --tail: poll on an interval, printing only entries not seen before.
    const seen = new Set<string>();
    while (!signal?.aborted) {
      const entries = await c.getAuditLogs({ action, limit });
      const fresh = entries.filter((e) => !seen.has(e.id));
      for (const e of entries) seen.add(e.id);
      if (fresh.length > 0) {
        if (json) {
          for (const e of fresh) out(`${JSON.stringify(e)}\n`);
        } else {
          out(renderLogsTable(fresh, color && !json));
        }
      }
      if (signal?.aborted) break;
      await sleep(intervalMs, signal);
    }
    return 0;
  } catch (e) {
    err(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
