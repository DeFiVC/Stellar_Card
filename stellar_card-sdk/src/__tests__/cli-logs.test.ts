import { describe, it, expect, vi } from 'vitest';
import { logsCommand, renderLogsTable, type LogsCliDeps } from '../commands/logs';
import type { AuditLogEntry } from '../client';

function makeEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: 'evt_1',
    timestamp: '2026-01-01T00:00:00.000Z',
    action: 'order.create',
    actor: 'api_key:abc123',
    result: 'success',
    ...overrides,
  };
}

function makeDeps(entries: AuditLogEntry[]): {
  deps: LogsCliDeps;
  out: ReturnType<typeof vi.fn>;
  err: ReturnType<typeof vi.fn>;
  getAuditLogs: ReturnType<typeof vi.fn>;
} {
  const out = vi.fn();
  const err = vi.fn();
  const getAuditLogs = vi.fn().mockResolvedValue(entries);
  const deps: LogsCliDeps = {
    client: { getAuditLogs },
    out,
    err,
    color: false,
  };
  return { deps, out, err, getAuditLogs };
}

describe('stellar_card logs', () => {
  it('fetches and renders audit log entries as a table', async () => {
    const entries = [makeEntry(), makeEntry({ id: 'evt_2', action: 'card.authorize' })];
    const { deps, out, getAuditLogs } = makeDeps(entries);

    const code = await logsCommand([], deps);

    expect(code).toBe(0);
    expect(getAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({ action: undefined, limit: 20 }),
    );
    const printed = out.mock.calls.map((c) => c[0]).join('');
    expect(printed).toContain('order.create');
    expect(printed).toContain('card.authorize');
    expect(printed).toContain('TIMESTAMP');
    expect(printed).toContain('ACTION');
    expect(printed).toContain('ACTOR');
    expect(printed).toContain('RESULT');
  });

  it('prints a friendly message when there are no audit events', async () => {
    const { deps, out } = makeDeps([]);
    const code = await logsCommand([], deps);
    expect(code).toBe(0);
    expect(out).toHaveBeenCalledWith('No audit events found.\n');
  });

  it('passes --action filter through to the client', async () => {
    const { deps, getAuditLogs } = makeDeps([]);
    await logsCommand(['--action', 'order.create'], deps);
    expect(getAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'order.create', limit: 20 }),
    );
  });

  it('passes --limit through to the client', async () => {
    const { deps, getAuditLogs } = makeDeps([]);
    await logsCommand(['--limit', '5'], deps);
    expect(getAuditLogs).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
  });

  it('supports --action=value syntax', async () => {
    const { deps, getAuditLogs } = makeDeps([]);
    await logsCommand(['--action=card.authorize'], deps);
    expect(getAuditLogs).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'card.authorize' }),
    );
  });

  it('outputs raw JSON with --json', async () => {
    const entries = [makeEntry()];
    const { deps, out } = makeDeps(entries);
    const code = await logsCommand(['--json'], deps);
    expect(code).toBe(0);
    expect(out).toHaveBeenCalledWith(`${JSON.stringify(entries, null, 2)}\n`);
  });

  it('returns exit code 1 and writes to err on failure', async () => {
    const out = vi.fn();
    const err = vi.fn();
    const getAuditLogs = vi.fn().mockRejectedValue(new Error('boom'));
    const code = await logsCommand([], { client: { getAuditLogs }, out, err, color: false });
    expect(code).toBe(1);
    expect(err).toHaveBeenCalledWith('error: boom\n');
  });

  it('--tail polls repeatedly until aborted, printing only new entries', async () => {
    vi.useFakeTimers();
    const out = vi.fn();
    const err = vi.fn();
    const first = [makeEntry({ id: 'evt_1' })];
    const second = [makeEntry({ id: 'evt_1' }), makeEntry({ id: 'evt_2', action: 'card.pay' })];
    const getAuditLogs = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const controller = new AbortController();
    const promise = logsCommand(['--tail', '--interval', '10'], {
      client: { getAuditLogs },
      out,
      err,
      color: false,
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10);
    const code = await promise;

    expect(code).toBe(0);
    expect(getAuditLogs).toHaveBeenCalledTimes(2);
    const printed = out.mock.calls.map((c) => c[0]).join('');
    expect(printed).toContain('card.pay');
    vi.useRealTimers();
  });

  describe('renderLogsTable', () => {
    it('aligns columns and uppercases headers', () => {
      const table = renderLogsTable([makeEntry()], false);
      const lines = table.trim().split('\n');
      expect(lines[0]).toMatch(/TIMESTAMP\s+ACTION\s+ACTOR\s+RESULT/);
      expect(lines[2]).toContain('order.create');
    });
  });
});
