// Tests for `stellar_card profile [list|add|use|remove]` (#742).
//
// File I/O is isolated to a real temp directory per test (same pattern as
// __tests__/config.test.ts) — never touches the real ~/.stellar-card.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  addProfile,
  listProfiles,
  useProfile,
  removeProfile,
  getProfileSecret,
  loadProfiles,
} from '../commands/profile';

const PASSPHRASE = 'correct-horse-battery-staple';
const SECRET_A = 'SA'.padEnd(56, 'A');
const PUBLIC_A = 'GA'.padEnd(56, 'A');
const SECRET_B = 'SB'.padEnd(56, 'B');
const PUBLIC_B = 'GB'.padEnd(56, 'B');

describe('CLI wallet profiles (#742)', () => {
  let tmpDir: string;
  let profilesPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar_card-profiles-test-'));
    profilesPath = path.join(tmpDir, 'profiles.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('add', () => {
    it('creates a profile with an encrypted secret', async () => {
      await addProfile({
        alias: 'testnet-dev',
        network: 'testnet',
        publicKey: PUBLIC_A,
        secret: SECRET_A,
        passphrase: PASSPHRASE,
        profilesPath,
      });

      const data = loadProfiles(profilesPath);
      expect(data.profiles['testnet-dev']).toBeDefined();
      expect(data.profiles['testnet-dev']!.publicKey).toBe(PUBLIC_A);
      expect(data.profiles['testnet-dev']!.encryptedSecret.value).toBeTruthy();
    });

    it('never writes the raw secret anywhere in the file content', async () => {
      await addProfile({
        alias: 'testnet-dev',
        network: 'testnet',
        publicKey: PUBLIC_A,
        secret: SECRET_A,
        passphrase: PASSPHRASE,
        profilesPath,
      });

      const raw = fs.readFileSync(profilesPath, 'utf8');
      expect(raw).not.toContain(SECRET_A);
      expect(raw).not.toContain(PASSPHRASE);
    });

    it('rejects an invalid secret key shape', async () => {
      await expect(
        addProfile({
          alias: 'bad',
          network: 'testnet',
          publicKey: PUBLIC_A,
          secret: 'not-a-secret-key',
          passphrase: PASSPHRASE,
          profilesPath,
        }),
      ).rejects.toThrow();
    });

    it('rejects an empty passphrase', async () => {
      await expect(
        addProfile({
          alias: 'bad',
          network: 'testnet',
          publicKey: PUBLIC_A,
          secret: SECRET_A,
          passphrase: '',
          profilesPath,
        }),
      ).rejects.toThrow();
    });

    it('the first profile added becomes active automatically', async () => {
      await addProfile({
        alias: 'first',
        network: 'testnet',
        publicKey: PUBLIC_A,
        secret: SECRET_A,
        passphrase: PASSPHRASE,
        profilesPath,
      });
      const data = loadProfiles(profilesPath);
      expect(data.activeProfile).toBe('first');
    });

    it('a second profile does not change the active pointer', async () => {
      await addProfile({
        alias: 'first',
        network: 'testnet',
        publicKey: PUBLIC_A,
        secret: SECRET_A,
        passphrase: PASSPHRASE,
        profilesPath,
      });
      await addProfile({
        alias: 'second',
        network: 'mainnet',
        publicKey: PUBLIC_B,
        secret: SECRET_B,
        passphrase: PASSPHRASE,
        profilesPath,
      });
      const data = loadProfiles(profilesPath);
      expect(data.activeProfile).toBe('first');
    });
  });

  describe('list', () => {
    it('shows all profiles and marks the active one', async () => {
      await addProfile({
        alias: 'alpha',
        network: 'testnet',
        publicKey: PUBLIC_A,
        secret: SECRET_A,
        passphrase: PASSPHRASE,
        profilesPath,
      });
      await addProfile({
        alias: 'beta',
        network: 'mainnet',
        publicKey: PUBLIC_B,
        secret: SECRET_B,
        passphrase: PASSPHRASE,
        profilesPath,
      });

      const listed = listProfiles(profilesPath);
      expect(listed).toHaveLength(2);
      const alpha = listed.find((p) => p.alias === 'alpha');
      const beta = listed.find((p) => p.alias === 'beta');
      expect(alpha?.active).toBe(true);
      expect(beta?.active).toBe(false);
    });

    it('returns an empty list when no profiles exist', () => {
      expect(listProfiles(profilesPath)).toEqual([]);
    });
  });

  describe('use', () => {
    it('switches the active profile and persists it', async () => {
      await addProfile({
        alias: 'alpha',
        network: 'testnet',
        publicKey: PUBLIC_A,
        secret: SECRET_A,
        passphrase: PASSPHRASE,
        profilesPath,
      });
      await addProfile({
        alias: 'beta',
        network: 'mainnet',
        publicKey: PUBLIC_B,
        secret: SECRET_B,
        passphrase: PASSPHRASE,
        profilesPath,
      });

      useProfile('beta', profilesPath);

      const data = loadProfiles(profilesPath);
      expect(data.activeProfile).toBe('beta');

      // Persisted — a fresh load sees the same value.
      const reloaded = loadProfiles(profilesPath);
      expect(reloaded.activeProfile).toBe('beta');
    });

    it('errors clearly when switching to a nonexistent profile', async () => {
      await addProfile({
        alias: 'alpha',
        network: 'testnet',
        publicKey: PUBLIC_A,
        secret: SECRET_A,
        passphrase: PASSPHRASE,
        profilesPath,
      });

      expect(() => useProfile('does-not-exist', profilesPath)).toThrow(/No profile named/);
    });
  });

  describe('remove', () => {
    it('deletes a profile', async () => {
      await addProfile({
        alias: 'alpha',
        network: 'testnet',
        publicKey: PUBLIC_A,
        secret: SECRET_A,
        passphrase: PASSPHRASE,
        profilesPath,
      });
      await addProfile({
        alias: 'beta',
        network: 'mainnet',
        publicKey: PUBLIC_B,
        secret: SECRET_B,
        passphrase: PASSPHRASE,
        profilesPath,
      });

      const result = removeProfile('beta', profilesPath);
      expect(result.removed).toBe(true);
      expect(result.clearedActive).toBe(false);

      const data = loadProfiles(profilesPath);
      expect(data.profiles['beta']).toBeUndefined();
      expect(data.profiles['alpha']).toBeDefined();
    });

    it('clears the active pointer when removing the currently-active profile', async () => {
      await addProfile({
        alias: 'alpha',
        network: 'testnet',
        publicKey: PUBLIC_A,
        secret: SECRET_A,
        passphrase: PASSPHRASE,
        profilesPath,
      });

      const result = removeProfile('alpha', profilesPath);
      expect(result.clearedActive).toBe(true);

      const data = loadProfiles(profilesPath);
      expect(data.activeProfile).toBeNull();
    });

    it('errors clearly when removing a nonexistent profile', () => {
      expect(() => removeProfile('does-not-exist', profilesPath)).toThrow(/No profile named/);
    });
  });

  describe('getProfileSecret', () => {
    it('decrypts the stored secret with the correct passphrase', async () => {
      await addProfile({
        alias: 'alpha',
        network: 'testnet',
        publicKey: PUBLIC_A,
        secret: SECRET_A,
        passphrase: PASSPHRASE,
        profilesPath,
      });

      const decrypted = await getProfileSecret('alpha', PASSPHRASE, profilesPath);
      expect(decrypted).toBe(SECRET_A);
    });

    it('fails to decrypt with the wrong passphrase', async () => {
      await addProfile({
        alias: 'alpha',
        network: 'testnet',
        publicKey: PUBLIC_A,
        secret: SECRET_A,
        passphrase: PASSPHRASE,
        profilesPath,
      });

      await expect(getProfileSecret('alpha', 'wrong-passphrase', profilesPath)).rejects.toThrow();
    });
  });
});
