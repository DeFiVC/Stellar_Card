// React hook wrappers for the stellar_card SDK (#733).
//
// Published as a separate `stellar_card/react` subpath so apps that don't
// use React never pay for pulling `react` into their bundle (it's a peer
// dependency, not a hard dependency — see package.json `peerDependencies`).
//
// SSR safety: none of these hooks touch `window`, `document`, or
// `localStorage` during the initial render. All browser-only reads happen
// inside `useEffect`, which only runs after hydration on the client, so
// server-rendered markup (Next.js, Remix) always matches the first client
// render — no hydration mismatch warnings.

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Stellar_CardClient } from '../client';
import type { OrderStatus, StellarCardClientOptions } from '../client';
import { getAccountBalances } from '../stellar';
import type { AccountBalances } from '../stellar';

// ─── useStellarCard ─────────────────────────────────────────────────────

export interface StellarCardProviderProps {
  apiKey: string;
  network?: StellarCardClientOptions['network'];
  baseUrl?: string;
  children: ReactNode;
}

const StellarCardContext = createContext<Stellar_CardClient | null>(null);

/**
 * Provides a shared {@link Stellar_CardClient} instance to the component
 * tree via React Context. The client is created once (memoized on
 * apiKey/network/baseUrl) and reused across re-renders.
 *
 * @example
 * <StellarCardProvider apiKey={process.env.NEXT_PUBLIC_STELLAR_CARD_KEY!}>
 *   <App />
 * </StellarCardProvider>
 */
export function StellarCardProvider({
  apiKey,
  network,
  baseUrl,
  children,
}: StellarCardProviderProps): ReturnType<typeof createElement> {
  const client = useMemo(
    () => new Stellar_CardClient({ apiKey, network, baseUrl }),
    [apiKey, network, baseUrl],
  );
  return createElement(StellarCardContext.Provider, { value: client }, children);
}

/**
 * Returns the {@link Stellar_CardClient} instance from the nearest
 * {@link StellarCardProvider}, constructing one directly from `apiKey`/
 * `network` when no provider is mounted (e.g. a single hook used without
 * wrapping the app).
 *
 * @throws {Error} When neither a provider nor `apiKey` is available.
 */
export function useStellarCard(opts?: {
  apiKey?: string;
  network?: StellarCardClientOptions['network'];
  baseUrl?: string;
}): Stellar_CardClient {
  const fromContext = useContext(StellarCardContext);
  const client = useMemo(() => {
    if (fromContext && !opts?.apiKey) return fromContext;
    if (!opts?.apiKey) {
      throw new Error(
        'useStellarCard: no <StellarCardProvider> found and no apiKey was passed. ' +
          'Wrap your app in <StellarCardProvider apiKey="..."> or call useStellarCard({ apiKey }).',
      );
    }
    return new Stellar_CardClient({
      apiKey: opts.apiKey,
      network: opts.network,
      baseUrl: opts.baseUrl,
    });
  }, [fromContext, opts?.apiKey, opts?.network, opts?.baseUrl]);
  return client;
}

// ─── useCardOrder ───────────────────────────────────────────────────────

export interface UseCardOrderResult {
  order: OrderStatus | null;
  loading: boolean;
  error: Error | null;
  /** Re-fetch the order's current status from the API. */
  refresh: () => Promise<void>;
  /**
   * Submit the on-chain payment for this order. The actual Soroban/XLM
   * transaction signing is environment-specific (a browser wallet
   * extension, a server-side signer, etc.), so callers supply a `signer`
   * that receives the order's {@link PaymentInstructions} and resolves
   * with the submitted transaction hash. `pay` then re-fetches the order
   * so `order` reflects the post-payment status.
   */
  pay: (signer: (payment: NonNullable<OrderStatus['payment']>) => Promise<string>) => Promise<{
    txHash: string;
  }>;
}

/**
 * Tracks a single order's status, exposing `refresh` to poll it again and
 * `pay` to submit payment via a caller-supplied signer. Does nothing (no
 * fetch, no error) when `orderId` is falsy, so it's safe to call before an
 * order exists yet.
 */
export function useCardOrder(
  orderId: string | null | undefined,
  client?: Stellar_CardClient,
): UseCardOrderResult {
  const ctxClient = useContext(StellarCardContext);
  const resolvedClient = client ?? ctxClient;
  const [order, setOrder] = useState<OrderStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const requireClient = useCallback((): Stellar_CardClient => {
    if (!resolvedClient) {
      throw new Error(
        'useCardOrder: no Stellar_CardClient available. Pass one explicitly or ' +
          'wrap your app in <StellarCardProvider>.',
      );
    }
    return resolvedClient;
  }, [resolvedClient]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!orderId) return;
    setLoading(true);
    setError(null);
    try {
      const c = requireClient();
      const result = await c.getOrder(orderId);
      setOrder(result);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [orderId, requireClient]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pay = useCallback(
    async (
      signer: (payment: NonNullable<OrderStatus['payment']>) => Promise<string>,
    ): Promise<{ txHash: string }> => {
      if (!order?.payment) {
        throw new Error('useCardOrder: no pending payment instructions for this order.');
      }
      const txHash = await signer(order.payment);
      await refresh();
      return { txHash };
    },
    [order, refresh],
  );

  return { order, loading, error, refresh, pay };
}

// ─── useWallet ──────────────────────────────────────────────────────────

export interface UseWalletResult {
  /** Connected wallet's Stellar public key, or null when not connected. */
  publicKey: string | null;
  balances: AccountBalances | null;
  loading: boolean;
  error: Error | null;
  /** Connect (or switch to) a wallet by its Stellar G-address. */
  connect: (publicKey: string) => void;
  /** Clear the connected wallet and its cached balances. */
  disconnect: () => void;
  /** Re-fetch balances for the currently connected wallet. */
  refresh: () => Promise<void>;
}

const WALLET_STORAGE_KEY = 'stellar_card.connectedWallet';

function readStoredWallet(): string | null {
  // Guarded so this never runs during SSR / initial render — only from
  // inside useEffect, which is client-only.
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    return window.localStorage.getItem(WALLET_STORAGE_KEY);
  } catch {
    // Storage disabled (private browsing, blocked cookies, etc.) — treat
    // as "no stored wallet" rather than throwing.
    return null;
  }
}

function writeStoredWallet(publicKey: string | null): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    if (publicKey) window.localStorage.setItem(WALLET_STORAGE_KEY, publicKey);
    else window.localStorage.removeItem(WALLET_STORAGE_KEY);
  } catch {
    /* non-fatal */
  }
}

/**
 * Tracks a connected Stellar wallet's public key and its XLM/USDC/trustline
 * balances. The public key is persisted to `localStorage` so a refresh
 * doesn't lose the connection — read only inside `useEffect`, never during
 * the initial render, so SSR output always matches the first client render
 * (no hydration mismatch).
 */
export function useWallet(networkPassphrase?: string): UseWalletResult {
  // Starts null on both server and client; the stored value (if any) is
  // applied after mount, in an effect.
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [balances, setBalances] = useState<AccountBalances | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    const stored = readStoredWallet();
    if (stored) setPublicKey(stored);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!publicKey) {
      setBalances(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await getAccountBalances(publicKey, networkPassphrase);
      setBalances(result);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [publicKey, networkPassphrase]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = useCallback((key: string): void => {
    writeStoredWallet(key);
    setPublicKey(key);
  }, []);

  const disconnect = useCallback((): void => {
    writeStoredWallet(null);
    setPublicKey(null);
    setBalances(null);
  }, []);

  return { publicKey, balances, loading, error, connect, disconnect, refresh };
}
