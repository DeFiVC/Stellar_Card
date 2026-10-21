// `stellar_card completion [bash|zsh|fish]` — CLI completion generator (#737).

import { describe, it, expect, vi } from 'vitest';
import {
  generateCompletionScript,
  completionCommand,
  COMMANDS,
  WALLET_SUBCOMMANDS,
  COMMAND_FLAGS,
} from '../cli-completion';

describe('generateCompletionScript', () => {
  it('throws for an unsupported shell', () => {
    expect(() => generateCompletionScript('powershell')).toThrow(/Unsupported shell/);
  });

  it('throws for an empty shell name', () => {
    expect(() => generateCompletionScript('')).toThrow(/Unsupported shell/);
  });

  describe('bash', () => {
    const script = generateCompletionScript('bash');

    it('defines the completion function and registers it with `complete`', () => {
      expect(script).toContain('_stellar_card_completions()');
      expect(script).toContain('complete -F _stellar_card_completions stellar_card');
    });

    it('is syntactically valid bash (parses with `bash -n`)', () => {
      const { status, stderr } = runShellSyntaxCheck('bash', ['-n'], script);
      expect(stderr).toBe('');
      expect(status).toBe(0);
    });

    it('lists every top-level command', () => {
      for (const cmd of COMMANDS) {
        expect(script).toContain(cmd);
      }
    });

    it('lists wallet subcommands', () => {
      for (const sub of WALLET_SUBCOMMANDS) {
        expect(script).toContain(sub);
      }
    });

    it('includes flags for every documented command', () => {
      for (const flags of Object.values(COMMAND_FLAGS)) {
        for (const flag of flags) {
          expect(script).toContain(flag);
        }
      }
    });
  });

  describe('zsh', () => {
    const script = generateCompletionScript('zsh');

    it('starts with a #compdef pragma and registers via compdef', () => {
      expect(script.startsWith('#compdef stellar_card')).toBe(true);
      expect(script).toContain('compdef _stellar_card stellar_card');
    });

    it('is syntactically valid zsh when zsh is available, otherwise skips', () => {
      const result = runShellSyntaxCheck('zsh', ['-n'], script);
      if (result.skipped) return;
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });

    it('lists every top-level command', () => {
      for (const cmd of COMMANDS) {
        expect(script).toContain(cmd);
      }
    });
  });

  describe('fish', () => {
    const script = generateCompletionScript('fish');

    it('emits `complete -c stellar_card` registrations', () => {
      expect(script).toContain('complete -c stellar_card');
    });

    it('is syntactically valid fish when fish is available, otherwise skips', () => {
      const result = runShellSyntaxCheck('fish', ['--no-execute'], script);
      if (result.skipped) return;
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });

    it('registers every top-level command via __fish_use_subcommand', () => {
      expect(script).toContain('__fish_use_subcommand');
      for (const cmd of COMMANDS) {
        expect(script).toContain(cmd);
      }
    });

    it('registers per-subcommand flags behind __fish_seen_subcommand_from', () => {
      expect(script).toContain("__fish_seen_subcommand_from purchase' -l asset");
      expect(script).toContain("__fish_seen_subcommand_from purchase' -l amount");
    });
  });
});

describe('completionCommand', () => {
  function harness() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      deps: {
        out: (t: string) => out.push(t),
        err: (t: string) => err.push(t),
      },
    };
  }

  it('prints usage and returns 2 when no shell is given', () => {
    const h = harness();
    const code = completionCommand([], h.deps);
    expect(code).toBe(2);
    expect(h.err.join('')).toContain('Usage: stellar_card completion');
  });

  it('prints usage and returns 0 for --help', () => {
    const h = harness();
    const code = completionCommand(['--help'], h.deps);
    expect(code).toBe(0);
    expect(h.err.join('')).toContain('Usage: stellar_card completion');
  });

  it('rejects an unsupported shell with exit code 2', () => {
    const h = harness();
    const code = completionCommand(['powershell'], h.deps);
    expect(code).toBe(2);
    expect(h.err.join('')).toContain("unsupported shell 'powershell'");
  });

  for (const shell of ['bash', 'zsh', 'fish'] as const) {
    it(`generates a ${shell} script and prints install instructions in the same output`, () => {
      const h = harness();
      const code = completionCommand([shell], h.deps);
      expect(code).toBe(0);
      const output = h.out.join('');
      expect(output).toContain(`stellar_card completion ${shell}`);
      expect(output).toContain('source');
    });
  }

  it('includes a working `source <(stellar_card completion bash)` instruction', () => {
    const h = harness();
    completionCommand(['bash'], h.deps);
    expect(h.out.join('')).toContain('source <(stellar_card completion bash)');
  });

  it('defaults to writing to process.stdout/stderr when no deps are given', () => {
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = completionCommand(['bash']);
      expect(code).toBe(0);
      expect(outSpy).toHaveBeenCalled();
    } finally {
      outSpy.mockRestore();
    }
  });
});

// ── shell syntax validation helpers ─────────────────────────────────────────
// Validates generated scripts against the real shell's own syntax checker
// when that shell binary is available on the test runner's PATH, rather
// than asserting on string shape alone (a string can "look like" valid
// bash/zsh/fish without actually parsing).

import { spawnSync } from 'node:child_process';

function runShellSyntaxCheck(
  shell: 'bash' | 'zsh' | 'fish',
  flags: string[],
  script: string,
): { status: number | null; stderr: string; skipped: boolean } {
  const probe = spawnSync(shell, ['-c', 'exit 0'], { encoding: 'utf-8' });
  if (probe.error) {
    return { status: 0, stderr: '', skipped: true };
  }

  const result = spawnSync(shell, flags, { input: script, encoding: 'utf-8' });
  return { status: result.status, stderr: result.stderr ?? '', skipped: false };
}
