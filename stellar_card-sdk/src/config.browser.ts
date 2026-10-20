// Browser stub for config.ts.
//
// The real config.ts reads/writes ~/.stellar_card/config.json using Node.js
// built-ins (fs, path, os, crypto). None of those are available in browsers.
//
// This stub is swapped in place of config.ts for browser bundler targets via
// the "browser" field in package.json. It satisfies the same interface so
// client.ts compiles without pulling fs/path/os/crypto into the browser bundle.
//
// Credentials must be passed explicitly when running in a browser:
//   new Stellar_CardClient({ apiKey: 'stellar_card_...', baseUrl: 'https://...' })

export interface Stellar_CardConfig {
  api_key: string;
  api_url: string;
  webhook_secret?: string | null;
  wallet_name?: string;
  vault_path?: string;
  passphrase_env?: string;
  created_at: string;
}

/**
 * Browser stub for {@link loadStellar_CardConfig} (config.ts).
 *
 * There is no `~/.stellar_card/config.json` in a browser — credentials must
 * be passed explicitly to `Stellar_CardClient`. Always returns `null` so
 * callers fall through to explicit-credential resolution.
 *
 * @param _configPath - Ignored; accepted only to match the Node entry point's signature.
 * @returns Always `null`.
 */
export function loadStellar_CardConfig(_configPath?: string): null {
  return null;
}

export function saveStellar_CardConfig(_config: Stellar_CardConfig, _configPath?: string): never {
  throw new Error(
    'saveStellar_CardConfig is not available in browser environments. ' +
      'Manage API keys via the Stellar_Card dashboard.',
  );
}

export function resolveCredentials(opts: { apiKey?: string; baseUrl?: string } = {}): {
  apiKey: string | undefined;
  baseUrl: string | undefined;
} {
  return { apiKey: opts.apiKey, baseUrl: opts.baseUrl };
}

/**
 * Validate that a base URL is safe to use for API requests.
 *
 * Rejects URLs carrying embedded `user:pass@` credentials (the API key is
 * sent via the `X-Api-Key` header, never in the URL) and anything that
 * isn't `https:`, so a misconfigured or malicious base URL can't
 * accidentally leak the API key over plaintext HTTP.
 *
 * @param url - Candidate base URL.
 * @param opts.context - Optional label included in the thrown error message (e.g. "webhook URL").
 * @returns The normalized URL string.
 * @throws {Error} If `url` fails to parse, embeds credentials, or is not HTTPS.
 */
export function assertSafeBaseUrl(url: string, opts: { context?: string } = {}): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid base URL: ${url}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(
      `Refusing base URL ${JSON.stringify(url)} with embedded credentials. ` +
        `Use a bare https://host/path form — the api key is sent via the X-Api-Key header.`,
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Refusing to use non-HTTPS base URL (${url})${opts.context ? ` for ${opts.context}` : ''}.`,
    );
  }
  return parsed.toString();
}

/**
 * Derive a cryptographic key using PBKDF2 with the WebCrypto subtle API.
 *
 * Uses standard Web Cryptography API to derive keys from passwords in browsers
 * and modern Node.js environments. This avoids dependence on Node-specific crypto
 * modules and works across browser and Node.js with a unified interface.
 *
 * @param password - The input password or passphrase
 * @param salt - Salt bytes for PBKDF2
 * @param iterations - Number of PBKDF2 iterations (higher = slower but more secure)
 * @returns The derived key material as raw bytes
 * @throws {Error} If WebCrypto API is unavailable or derivation fails
 *
 * @example
 * ```typescript
 * const salt = new Uint8Array(16);
 * crypto.getRandomValues(salt);
 * const key = await deriveKeyWithWebCrypto('mypassword', salt, 100000);
 * ```
 */
export async function deriveKeyWithWebCrypto(
  password: string,
  salt: Uint8Array,
  iterations: number = 100000,
): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      'WebCrypto subtle API is not available. Ensure you are using a modern browser or Node.js >= 15.7.0',
    );
  }

  const encoder = new TextEncoder();
  const passwordKey = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const derivedBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations,
    },
    passwordKey,
    256, // 32 bytes = 256 bits for AES-256
  );

  return new Uint8Array(derivedBits);
}

/**
 * Compute an HMAC signature using the WebCrypto subtle API.
 *
 * Generates an HMAC-SHA256 signature for message authentication and verification
 * using the standard Web Cryptography API. Works in browsers and Node.js.
 *
 * @param key - The key bytes for HMAC
 * @param message - The message to sign
 * @returns The HMAC signature as a Uint8Array
 * @throws {Error} If WebCrypto API is unavailable or signing fails
 *
 * @example
 * ```typescript
 * const key = new Uint8Array(32);
 * crypto.getRandomValues(key);
 * const signature = await hmacWithWebCrypto(key, 'message');
 * ```
 */
export async function hmacWithWebCrypto(key: Uint8Array, message: string): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      'WebCrypto subtle API is not available. Ensure you are using a modern browser or Node.js >= 15.7.0',
    );
  }

  const hmacKey = await globalThis.crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const encoder = new TextEncoder();
  const signature = await globalThis.crypto.subtle.sign('HMAC', hmacKey, encoder.encode(message));

  return new Uint8Array(signature);
}
