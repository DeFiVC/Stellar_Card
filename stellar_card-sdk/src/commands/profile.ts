// `stellar_card profile [list|add|use|remove]` — manage multiple named
// wallet profiles (alias, network, public key, encrypted secret) so an
// operator running several agents/wallets doesn't have to juggle separate
// config directories or re-onboard each time they switch networks (#742).
//
// Storage: ~/.stellar-card/profiles.json (deliberately a different file
// from ~/.stellar_card/config.json — profiles are an orthogonal, opt-in
// multi-wallet layer on top of the single-wallet onboarding flow). Secrets
// are encrypted at rest using the existing encryption.ts helpers (the same
// AES-256-GCM + PBKDF2 scheme as keystore.ts), never written in plaintext.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { encrypt, decrypt, type EncryptedPayload } from '../encryption';

const MAX_PROFILES_BYTES = 64 * 1024;
const SAFE_ALIAS_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export interface WalletProfile {
  alias: string;
  network: 'mainnet' | 'testnet' | 'futurenet' | 'custom';
  publicKey: string;
  /** Encrypted-at-rest secret key — never stored in plaintext. */
  encryptedSecret: EncryptedPayload;
  created_at: string;
}

export interface ProfilesFile {
  /** Alias of the currently active profile, or null if none selected. */
  activeProfile: string | null;
  profiles: Record<string, WalletProfile>;
}

function defaultProfilesDir(): string {
  return process.env.STELLAR_CARD_PROFILES_DIR || path.join(os.homedir(), '.stellar-card');
}

function defaultProfilesPath(): string {
  return path.join(defaultProfilesDir(), 'profiles.json');
}

function emptyProfilesFile(): ProfilesFile {
  return { activeProfile: null, profiles: {} };
}

function sanitizeAlias(alias: string): string {
  const trimmed = alias.trim();
  if (!SAFE_ALIAS_REGEX.test(trimmed)) {
    throw new Error(
      `Invalid profile alias "${alias}". Must be 1-64 alphanumeric characters, dashes, or underscores.`,
    );
  }
  return trimmed;
}

/**
 * Load the profiles file, or an empty one if it doesn't exist yet.
 * Never throws on a missing file — only on corrupt JSON or an
 * over-sized file (same defensive posture as config.ts's size cap).
 */
export function loadProfiles(profilesPath?: string): ProfilesFile {
  const p = profilesPath || defaultProfilesPath();
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyProfilesFile();
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`stellar-card profiles file at ${p} is a symbolic link. Refusing to load.`);
  }
  if (!stat.isFile()) {
    throw new Error(`stellar-card profiles file at ${p} is not a regular file.`);
  }
  if (stat.size > MAX_PROFILES_BYTES) {
    throw new Error(
      `stellar-card profiles file at ${p} is ${stat.size} bytes (max ${MAX_PROFILES_BYTES}). Refusing to load.`,
    );
  }
  const raw = fs.readFileSync(p, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `stellar-card profiles file at ${p} is corrupt JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const obj = parsed as Partial<ProfilesFile>;
  return {
    activeProfile: obj.activeProfile ?? null,
    profiles: obj.profiles ?? {},
  };
}

/**
 * Persist the profiles file atomically (tmp file + rename), matching the
 * write pattern used by config.ts and keystore.ts. Mode 0600 — the file
 * contains encrypted secrets, but we still keep it off-limits to other
 * local users as defense in depth.
 */
export function saveProfiles(data: ProfilesFile, profilesPath?: string): void {
  const p = profilesPath || defaultProfilesPath();
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best-effort */
    }
  }
  const tmp = `${p}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const body = JSON.stringify(data, null, 2);
  let committed = false;
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, body, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, p);
    committed = true;
  } finally {
    if (!committed) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }
}

export interface AddProfileOptions {
  alias: string;
  network: WalletProfile['network'];
  publicKey: string;
  secret: string;
  /** Passphrase used to encrypt `secret` at rest. */
  passphrase: string;
  profilesPath?: string;
}

/** `stellar-card profile add` — create (or overwrite) a named profile. */
export async function addProfile(opts: AddProfileOptions): Promise<WalletProfile> {
  const alias = sanitizeAlias(opts.alias);
  if (!opts.passphrase || !opts.passphrase.trim()) {
    throw new Error('A non-empty passphrase is required to encrypt the profile secret.');
  }
  if (!opts.publicKey || !opts.publicKey.startsWith('G')) {
    throw new Error(`Invalid Stellar public key: "${opts.publicKey}"`);
  }
  if (!opts.secret || !opts.secret.startsWith('S')) {
    throw new Error('Invalid Stellar secret key — refusing to store.');
  }

  const encryptedSecret = await encrypt(opts.secret, {
    passphrase: opts.passphrase,
    context: 'wallet-profile',
  });

  const data = loadProfiles(opts.profilesPath);
  const profile: WalletProfile = {
    alias,
    network: opts.network,
    publicKey: opts.publicKey,
    encryptedSecret,
    created_at: new Date().toISOString(),
  };
  data.profiles[alias] = profile;
  // First profile added becomes active automatically — matches the
  // "onboard sets config" convention elsewhere in this CLI, where the
  // first successful setup is the one subsequent commands use by default.
  if (data.activeProfile === null) {
    data.activeProfile = alias;
  }
  saveProfiles(data, opts.profilesPath);
  return profile;
}

export interface ListedProfile {
  alias: string;
  network: WalletProfile['network'];
  publicKey: string;
  active: boolean;
  created_at: string;
}

/** `stellar-card profile list` — all profiles, with the active one marked. */
export function listProfiles(profilesPath?: string): ListedProfile[] {
  const data = loadProfiles(profilesPath);
  return Object.values(data.profiles)
    .map((p) => ({
      alias: p.alias,
      network: p.network,
      publicKey: p.publicKey,
      active: p.alias === data.activeProfile,
      created_at: p.created_at,
    }))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

/** `stellar-card profile use <alias>` — switch the active profile pointer. */
export function useProfile(alias: string, profilesPath?: string): void {
  const safeAlias = sanitizeAlias(alias);
  const data = loadProfiles(profilesPath);
  if (!data.profiles[safeAlias]) {
    throw new Error(
      `No profile named "${safeAlias}". Run 'stellar_card profile list' to see available profiles.`,
    );
  }
  data.activeProfile = safeAlias;
  saveProfiles(data, profilesPath);
}

export interface RemoveProfileResult {
  removed: boolean;
  /** True when the removed profile was the active one — activeProfile is now null. */
  clearedActive: boolean;
}

/**
 * `stellar-card profile remove <alias>` — delete a profile.
 *
 * Removing the currently-active profile clears the active pointer (set to
 * `null`) rather than erroring or silently picking another profile — an
 * operator should have to explicitly `use` a new profile afterward instead
 * of commands silently resuming against a profile they didn't choose.
 */
export function removeProfile(alias: string, profilesPath?: string): RemoveProfileResult {
  const safeAlias = sanitizeAlias(alias);
  const data = loadProfiles(profilesPath);
  if (!data.profiles[safeAlias]) {
    throw new Error(
      `No profile named "${safeAlias}". Run 'stellar_card profile list' to see available profiles.`,
    );
  }
  delete data.profiles[safeAlias];
  const clearedActive = data.activeProfile === safeAlias;
  if (clearedActive) {
    data.activeProfile = null;
  }
  saveProfiles(data, profilesPath);
  return { removed: true, clearedActive };
}

/** Decrypt a stored profile's secret key. Throws on a wrong passphrase. */
export async function getProfileSecret(
  alias: string,
  passphrase: string,
  profilesPath?: string,
): Promise<string> {
  const safeAlias = sanitizeAlias(alias);
  const data = loadProfiles(profilesPath);
  const profile = data.profiles[safeAlias];
  if (!profile) {
    throw new Error(`No profile named "${safeAlias}".`);
  }
  return decrypt({
    payload: profile.encryptedSecret,
    passphrase,
    context: 'wallet-profile',
  });
}

// ── CLI wiring ───────────────────────────────────────────────────────────────

function usage(): void {
  process.stderr.write(`Usage: stellar_card profile <subcommand> [options]

Subcommands:
  list                                    List all profiles, marking the active one
  add --alias <name> --network <net>      Add a new profile
      --public-key <G...> --secret <S...>
      --passphrase-env <ENVNAME>
  use <alias>                             Switch the active profile
  remove <alias>                          Delete a profile
  -h, --help                              Show this message

Profiles are stored at ~/.stellar-card/profiles.json. Secrets are encrypted
at rest and the passphrase is never persisted — pass --passphrase-env to
name an environment variable holding it (read at call time only).
`);
}

function parseFlag(rest: string[], name: string): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg) continue;
    if (arg === name) return rest[i + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

export interface ProfileCliDeps {
  out?: (text: string) => void;
  err?: (text: string) => void;
  profilesPath?: string;
}

export async function profileCommand(argv: string[], deps: ProfileCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((t: string) => process.stdout.write(t));
  const errOut = deps.err ?? ((t: string) => process.stderr.write(t));
  const [sub, ...rest] = argv;

  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
    usage();
    return sub ? 0 : 2;
  }

  try {
    if (sub === 'list') {
      const profiles = listProfiles(deps.profilesPath);
      if (profiles.length === 0) {
        out("No profiles found. Run 'stellar_card profile add' to create one.\n");
        return 0;
      }
      for (const p of profiles) {
        out(`${p.active ? '* ' : '  '}${p.alias}  (${p.network})  ${p.publicKey}\n`);
      }
      return 0;
    }

    if (sub === 'add') {
      const alias = parseFlag(rest, '--alias');
      const network = parseFlag(rest, '--network') as WalletProfile['network'] | undefined;
      const publicKey = parseFlag(rest, '--public-key');
      const secret = parseFlag(rest, '--secret');
      const passphraseEnv = parseFlag(rest, '--passphrase-env');
      if (!alias || !network || !publicKey || !secret || !passphraseEnv) {
        errOut(
          'error: --alias, --network, --public-key, --secret, and --passphrase-env are all required.\n',
        );
        usage();
        return 2;
      }
      const passphrase = process.env[passphraseEnv];
      if (!passphrase) {
        errOut(`error: environment variable "${passphraseEnv}" is not set.\n`);
        return 1;
      }
      await addProfile({
        alias,
        network,
        publicKey,
        secret,
        passphrase,
        profilesPath: deps.profilesPath,
      });
      out(`✓ Profile "${alias}" added.\n`);
      return 0;
    }

    if (sub === 'use') {
      const alias = rest[0];
      if (!alias) {
        errOut('error: usage: stellar_card profile use <alias>\n');
        return 2;
      }
      useProfile(alias, deps.profilesPath);
      out(`✓ Switched active profile to "${alias}".\n`);
      return 0;
    }

    if (sub === 'remove') {
      const alias = rest[0];
      if (!alias) {
        errOut('error: usage: stellar_card profile remove <alias>\n');
        return 2;
      }
      const result = removeProfile(alias, deps.profilesPath);
      out(`✓ Profile "${alias}" removed.\n`);
      if (result.clearedActive) {
        out(
          `  It was the active profile — no profile is active now. Run 'stellar_card profile use <alias>' to pick one.\n`,
        );
      }
      return 0;
    }

    errOut(`error: unknown profile subcommand '${sub}'\n`);
    usage();
    return 2;
  } catch (err) {
    errOut(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
