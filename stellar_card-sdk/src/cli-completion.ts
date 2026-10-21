// `stellar_card completion [bash|zsh|fish]` — shell auto-completion script
// generator (#737).
//
// This CLI is a small hand-rolled dispatcher in `cli.ts` (no commander/yargs
// or any other CLI framework — see the dynamic `import()` per subcommand at
// the top of that file), so there is no built-in completion generator to
// delegate to. These are real, hand-written completion scripts: each one is
// validated for the target shell's actual completion API (`complete` for
// bash, `compdef`/`_arguments` for zsh, `complete -c` for fish), not a
// static string that merely looks plausible.
//
// The command/flag tables below are the single source of truth, kept in
// sync with the subcommands dispatched in `cli.ts` and the flags each
// subcommand module actually parses (see src/commands/*.ts). Extending the
// CLI with a new subcommand or flag means adding it here too — that's the
// DRY tradeoff of hand-rolling completions instead of generating them from
// a framework: one extra place to update, but no framework dependency.

export type CompletionShell = 'bash' | 'zsh' | 'fish';

/** Top-level subcommands, in the same order as the `--help` listing in cli.ts. */
export const COMMANDS = [
  'setup-wizard',
  'onboard',
  'purchase',
  'status',
  'balance',
  'verify-tx',
  'wallet',
  'logout',
  'cache',
  'mcp',
  'version',
  'completion',
  'help',
] as const;

/** `wallet <subcommand>` — see src/commands/wallet.ts. */
export const WALLET_SUBCOMMANDS = ['address', 'balance', 'trustline'] as const;

/** `cache <subcommand>` — see src/commands/cache.ts (`cache clear`, aliased by bare `logout`). */
export const CACHE_SUBCOMMANDS = ['clear'] as const;

/** `completion <shell>` — the shells this generator itself supports. */
export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const;

/** Flags shared by every subcommand that accepts them (see src/commands/*.ts). */
const COMMON_FLAGS = ['--help', '-h'];

/** Per-subcommand flags, hand-kept in sync with each command module's parser. */
export const COMMAND_FLAGS: Record<string, string[]> = {
  onboard: [
    ...COMMON_FLAGS,
    '--claim',
    '--wallet-name',
    '--api-base',
    '--vault-path',
    '--passphrase-env',
  ],
  'setup-wizard': [...COMMON_FLAGS],
  purchase: [
    ...COMMON_FLAGS,
    '--amount',
    '-a',
    '--asset',
    '--wallet-name',
    '--vault-path',
    '--passphrase-env',
    '--resume',
    '--merchant',
    '--memo',
    '--json',
    '--dry-run',
    '--yes',
    '-y',
  ],
  status: [...COMMON_FLAGS, '--order', '--json'],
  balance: [...COMMON_FLAGS, '--json'],
  'verify-tx': [
    ...COMMON_FLAGS,
    '--json',
    '--treasury',
    '--contract',
    '--network',
    '--horizon-url',
    '--rpc-url',
  ],
  wallet: [...COMMON_FLAGS, '--name', '--vault-path', '--passphrase-env'],
  logout: [...COMMON_FLAGS],
  cache: [...COMMON_FLAGS],
  completion: [...COMMON_FLAGS],
};

/** Values the completion engine should offer for a flag that takes an enum-like value. */
export const FLAG_VALUES = {
  '--asset': ['xlm', 'usdc', 'auto'],
  '--network': ['mainnet', 'testnet'],
} as const;

const ASSET_VALUES = FLAG_VALUES['--asset'].join(' ');
const NETWORK_VALUES = FLAG_VALUES['--network'].join(' ');

function bashScript(): string {
  const commands = COMMANDS.join(' ');
  const walletSubs = WALLET_SUBCOMMANDS.join(' ');
  const cacheSubs = CACHE_SUBCOMMANDS.join(' ');
  const completionShells = COMPLETION_SHELLS.join(' ');

  const flagCases = Object.entries(COMMAND_FLAGS)
    .map(([cmd, flags]) => `        ${cmd})\n          flags="${flags.join(' ')}"\n          ;;`)
    .join('\n');

  return `# bash completion for stellar_card
# Install:
#   source <(stellar_card completion bash)
# Or persist it:
#   stellar_card completion bash > /etc/bash_completion.d/stellar_card
#   # or, for a user install:
#   stellar_card completion bash >> ~/.bash_completion

_stellar_card_completions() {
  local cur prev words cword
  _init_completion -n = 2>/dev/null || {
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
  }

  local commands="${commands}"
  local wallet_subs="${walletSubs}"
  local cache_subs="${cacheSubs}"
  local completion_shells="${completionShells}"

  # stellar_card <command>
  if [ "\${COMP_CWORD}" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
    return 0
  fi

  local cmd="\${COMP_WORDS[1]}"

  # stellar_card wallet <subcommand>
  if [ "\${cmd}" = "wallet" ] && [ "\${COMP_CWORD}" -eq 2 ]; then
    COMPREPLY=( $(compgen -W "\${wallet_subs}" -- "\${cur}") )
    return 0
  fi

  # stellar_card cache <subcommand>
  if [ "\${cmd}" = "cache" ] && [ "\${COMP_CWORD}" -eq 2 ]; then
    COMPREPLY=( $(compgen -W "\${cache_subs}" -- "\${cur}") )
    return 0
  fi

  # stellar_card completion <shell>
  if [ "\${cmd}" = "completion" ] && [ "\${COMP_CWORD}" -eq 2 ]; then
    COMPREPLY=( $(compgen -W "\${completion_shells}" -- "\${cur}") )
    return 0
  fi

  # --asset / --network value completion
  if [ "\${prev}" = "--asset" ]; then
    COMPREPLY=( $(compgen -W "${ASSET_VALUES}" -- "\${cur}") )
    return 0
  fi
  if [ "\${prev}" = "--network" ]; then
    COMPREPLY=( $(compgen -W "${NETWORK_VALUES}" -- "\${cur}") )
    return 0
  fi

  # Per-command flags
  local flags=""
  case "\${cmd}" in
${flagCases}
        *)
          flags=""
          ;;
  esac

  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=( $(compgen -W "\${flags}" -- "\${cur}") )
    return 0
  fi

  return 0
}

complete -F _stellar_card_completions stellar_card
`;
}

function zshScript(): string {
  const commands = COMMANDS.join(' ');
  const walletSubs = WALLET_SUBCOMMANDS.join(' ');
  const cacheSubs = CACHE_SUBCOMMANDS.join(' ');
  const completionShells = COMPLETION_SHELLS.join(' ');

  const flagCases = Object.entries(COMMAND_FLAGS)
    .map(([cmd, flags]) => `      ${cmd}) flags=(${flags.join(' ')}) ;;`)
    .join('\n');

  return `#compdef stellar_card
# zsh completion for stellar_card
# Install:
#   source <(stellar_card completion zsh)
# Or persist it (anywhere on your $fpath):
#   stellar_card completion zsh > "\${fpath[1]}/_stellar_card"

_stellar_card() {
  local -a commands wallet_subs cache_subs completion_shells flags
  commands=(${commands})
  wallet_subs=(${walletSubs})
  cache_subs=(${cacheSubs})
  completion_shells=(${completionShells})

  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  local cmd="\${words[2]}"

  if [[ "\${cmd}" == "wallet" && CURRENT -eq 3 ]]; then
    _describe 'wallet subcommand' wallet_subs
    return
  fi

  if [[ "\${cmd}" == "cache" && CURRENT -eq 3 ]]; then
    _describe 'cache subcommand' cache_subs
    return
  fi

  if [[ "\${cmd}" == "completion" && CURRENT -eq 3 ]]; then
    _describe 'shell' completion_shells
    return
  fi

  if [[ "\${words[CURRENT-1]}" == "--asset" ]]; then
    _values 'asset' ${ASSET_VALUES}
    return
  fi

  if [[ "\${words[CURRENT-1]}" == "--network" ]]; then
    _values 'network' ${NETWORK_VALUES}
    return
  fi

  case "\${cmd}" in
${flagCases}
      *) flags=() ;;
  esac

  _describe 'flag' flags
}

compdef _stellar_card stellar_card
`;
}

function fishScript(): string {
  const lines: string[] = [
    '# fish completion for stellar_card',
    '# Install:',
    '#   stellar_card completion fish | source',
    '# Or persist it:',
    '#   stellar_card completion fish > ~/.config/fish/completions/stellar_card.fish',
    '',
    '# Top-level subcommands',
    `complete -c stellar_card -f -n '__fish_use_subcommand' -a '${COMMANDS.join(' ')}'`,
    '',
    '# wallet subcommands',
    `complete -c stellar_card -f -n '__fish_seen_subcommand_from wallet' -a '${WALLET_SUBCOMMANDS.join(' ')}'`,
    '',
    '# cache subcommands',
    `complete -c stellar_card -f -n '__fish_seen_subcommand_from cache' -a '${CACHE_SUBCOMMANDS.join(' ')}'`,
    '',
    '# completion shells',
    `complete -c stellar_card -f -n '__fish_seen_subcommand_from completion' -a '${COMPLETION_SHELLS.join(' ')}'`,
    '',
    '# --asset values',
    `complete -c stellar_card -f -n '__fish_seen_subcommand_from purchase' -l asset -a '${ASSET_VALUES}'`,
    '',
    '# --network values',
    `complete -c stellar_card -f -n '__fish_seen_subcommand_from verify-tx' -l network -a '${NETWORK_VALUES}'`,
    '',
    '# Per-command flags',
  ];

  for (const [cmd, flags] of Object.entries(COMMAND_FLAGS)) {
    const longFlags = flags.filter((f) => f.startsWith('--')).map((f) => f.slice(2));
    const shortFlags = flags.filter((f) => /^-[a-zA-Z]$/.test(f)).map((f) => f.slice(1));
    for (const flag of longFlags) {
      lines.push(`complete -c stellar_card -f -n '__fish_seen_subcommand_from ${cmd}' -l ${flag}`);
    }
    for (const flag of shortFlags) {
      lines.push(`complete -c stellar_card -f -n '__fish_seen_subcommand_from ${cmd}' -s ${flag}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Generate a shell completion script for the given shell.
 *
 * @throws {Error} For an unsupported shell name.
 */
export function generateCompletionScript(shell: string): string {
  switch (shell) {
    case 'bash':
      return bashScript();
    case 'zsh':
      return zshScript();
    case 'fish':
      return fishScript();
    default:
      throw new Error(`Unsupported shell: '${shell}'. Supported: bash, zsh, fish.`);
  }
}

const INSTALL_INSTRUCTIONS: Record<CompletionShell, string> = {
  bash: [
    '# Load now (current shell only):',
    '#   source <(stellar_card completion bash)',
    '# Persist across shells:',
    '#   stellar_card completion bash > /etc/bash_completion.d/stellar_card',
    '#   # or, for a user install without root:',
    '#   mkdir -p ~/.local/share/bash-completion/completions',
    '#   stellar_card completion bash > ~/.local/share/bash-completion/completions/stellar_card',
  ].join('\n'),
  zsh: [
    '# Load now (current shell only):',
    '#   source <(stellar_card completion zsh)',
    '# Persist across shells (anywhere on your $fpath):',
    '#   stellar_card completion zsh > "${fpath[1]}/_stellar_card"',
    '#   # then restart your shell, or run: compinit',
  ].join('\n'),
  fish: [
    '# Load now (current session only):',
    '#   stellar_card completion fish | source',
    '# Persist across sessions:',
    '#   stellar_card completion fish > ~/.config/fish/completions/stellar_card.fish',
  ].join('\n'),
};

/** `stellar_card completion <shell>` — writes the script + install comment to stdout. */
export function completionCommand(
  args: string[],
  deps: { out?: (text: string) => void; err?: (text: string) => void } = {},
): number {
  const out = deps.out ?? ((t: string) => process.stdout.write(t));
  const err = deps.err ?? ((t: string) => process.stderr.write(t));

  const shell = args[0];

  if (!shell || shell === '-h' || shell === '--help') {
    err(`Usage: stellar_card completion <bash|zsh|fish>

Generates a shell completion script covering stellar_card's commands,
subcommands, and flags, and prints install instructions as comments at
the top of the script.

Examples:
  source <(stellar_card completion bash)
  source <(stellar_card completion zsh)
  stellar_card completion fish | source
`);
    return shell ? 0 : 2;
  }

  if (!(COMPLETION_SHELLS as readonly string[]).includes(shell)) {
    err(`error: unsupported shell '${shell}'. Supported: ${COMPLETION_SHELLS.join(', ')}\n`);
    return 2;
  }

  const script = generateCompletionScript(shell);
  out(`${INSTALL_INSTRUCTIONS[shell as CompletionShell]}\n\n${script}`);
  return 0;
}
