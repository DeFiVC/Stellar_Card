// Vitest setup for Soroban integration tests
import { beforeAll, afterAll, vi } from 'vitest';

beforeAll(() => {
  // Set default timeout and suppress network warnings during tests
  process.env.STELLAR_NETWORK = 'TESTNET';

  // jsdom (used only by src/**/*.test.tsx, via environmentMatchGlobs) does
  // not implement a persistent localStorage by default in this version.
  // Polyfill a minimal in-memory Storage so hook tests exercising
  // localStorage (e.g. useWallet's connected-wallet persistence) behave
  // like a real browser. No-op when `window` doesn't exist (the default
  // 'node' environment used by every other test file).
  if (typeof window !== 'undefined' && !window.localStorage) {
    const store = new Map<string, string>();
    const storage: Storage = {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => store.clear(),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    };
    Object.defineProperty(window, 'localStorage', {
      value: storage,
      writable: true,
      configurable: true,
    });
  }
});

afterAll(() => {
  vi.restoreAllMocks();
});
