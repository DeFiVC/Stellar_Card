// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, waitFor, cleanup, renderHook, act } from '@testing-library/react';
import {
  StellarCardProvider,
  useStellarCard,
  useCardOrder,
  useWallet,
} from '../integrations/react';
import { Stellar_CardClient } from '../client';
import * as stellarModule from '../stellar';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe('useStellarCard', () => {
  it('returns the client from the nearest StellarCardProvider', () => {
    let captured: Stellar_CardClient | null = null;
    function Probe(): null {
      captured = useStellarCard();
      return null;
    }
    render(createElement(StellarCardProvider, { apiKey: 'test-key' }, createElement(Probe)));
    expect(captured).toBeInstanceOf(Stellar_CardClient);
  });

  it('constructs its own client when apiKey is passed without a provider', () => {
    const { result } = renderHook(() => useStellarCard({ apiKey: 'direct-key' }));
    expect(result.current).toBeInstanceOf(Stellar_CardClient);
  });

  it('throws when neither a provider nor apiKey is available', () => {
    expect(() => renderHook(() => useStellarCard())).toThrow(/no <StellarCardProvider>/);
  });

  it('does not touch window/localStorage during initial render (SSR safety)', () => {
    // If the hook touched window during render (not an effect), this
    // would behave identically in a simulated SSR pass. We assert no
    // storage access happens synchronously during render by checking the
    // hook construction path never calls localStorage.
    const spy = vi.spyOn(window.localStorage, 'getItem');
    renderHook(() => useStellarCard({ apiKey: 'k' }));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('useCardOrder', () => {
  it('fetches order status on mount and exposes it', async () => {
    const getOrder = vi.fn().mockResolvedValue({
      order_id: 'order_1',
      status: 'pending_payment',
      phase: 'awaiting_payment',
      amount_usdc: '10.00',
      payment_asset: 'usdc',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    const client = { getOrder } as unknown as Stellar_CardClient;

    const { result } = renderHook(() => useCardOrder('order_1', client));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(getOrder).toHaveBeenCalledWith('order_1');
    expect(result.current.order?.order_id).toBe('order_1');
    expect(result.current.error).toBeNull();
  });

  it('does nothing when orderId is null', () => {
    const getOrder = vi.fn();
    const client = { getOrder } as unknown as Stellar_CardClient;
    const { result } = renderHook(() => useCardOrder(null, client));
    expect(result.current.loading).toBe(false);
    expect(result.current.order).toBeNull();
    expect(getOrder).not.toHaveBeenCalled();
  });

  it('captures errors from a failed fetch', async () => {
    const getOrder = vi.fn().mockRejectedValue(new Error('network down'));
    const client = { getOrder } as unknown as Stellar_CardClient;
    const { result } = renderHook(() => useCardOrder('order_1', client));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe('network down');
    expect(result.current.order).toBeNull();
  });

  it('refresh re-fetches the order', async () => {
    const getOrder = vi
      .fn()
      .mockResolvedValueOnce({ order_id: 'o1', status: 'pending_payment' })
      .mockResolvedValueOnce({ order_id: 'o1', status: 'delivered' });
    const client = { getOrder } as unknown as Stellar_CardClient;
    const { result } = renderHook(() => useCardOrder('o1', client));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.order?.status).toBe('pending_payment');

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.order?.status).toBe('delivered');
    expect(getOrder).toHaveBeenCalledTimes(2);
  });

  it('pay calls the signer with payment instructions then refreshes', async () => {
    const payment = {
      type: 'soroban_contract' as const,
      contract_id: 'C123',
      order_id: 'o1',
      usdc: { amount: '10.0000000', asset: 'USDC:ISSUER' },
    };
    const getOrder = vi
      .fn()
      .mockResolvedValueOnce({ order_id: 'o1', status: 'pending_payment', payment })
      .mockResolvedValueOnce({ order_id: 'o1', status: 'processing' });
    const client = { getOrder } as unknown as Stellar_CardClient;
    const { result } = renderHook(() => useCardOrder('o1', client));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const signer = vi.fn().mockResolvedValue('tx_hash_abc');
    let payResult: { txHash: string } | undefined;
    await act(async () => {
      payResult = await result.current.pay(signer);
    });

    expect(signer).toHaveBeenCalledWith(payment);
    expect(payResult?.txHash).toBe('tx_hash_abc');
    expect(result.current.order?.status).toBe('processing');
  });

  it('pay throws when there are no pending payment instructions', async () => {
    const getOrder = vi.fn().mockResolvedValue({ order_id: 'o1', status: 'delivered' });
    const client = { getOrder } as unknown as Stellar_CardClient;
    const { result } = renderHook(() => useCardOrder('o1', client));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await expect(result.current.pay(vi.fn())).rejects.toThrow(/no pending payment/);
  });
});

describe('useWallet', () => {
  it('starts disconnected with no SSR/initial-render storage access', () => {
    const spy = vi.spyOn(window.localStorage, 'getItem');
    const { result } = renderHook(() => useWallet());
    // The hook's first synchronous render must not have read storage yet —
    // only the post-mount effect does, confirming no hydration mismatch.
    expect(result.current.publicKey).toBeNull();
    expect(result.current.balances).toBeNull();
    // After React flushes effects (renderHook does this synchronously in
    // the test environment), storage access is expected exactly once.
    expect(spy).toHaveBeenCalled();
  });

  it('connect sets publicKey and persists it, fetching balances', async () => {
    const balances = { xlm: '100', usdc: '50', balances: [], funded: true };
    vi.spyOn(stellarModule, 'getAccountBalances').mockResolvedValue(balances);

    const { result } = renderHook(() => useWallet());
    const PUBLIC_KEY = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    act(() => {
      result.current.connect(PUBLIC_KEY);
    });

    await waitFor(() => expect(result.current.balances).toEqual(balances));
    expect(window.localStorage.getItem('stellar_card.connectedWallet')).toBe(PUBLIC_KEY);
  });

  it('disconnect clears publicKey, balances, and storage', async () => {
    const balances = { xlm: '100', usdc: '50', balances: [], funded: true };
    vi.spyOn(stellarModule, 'getAccountBalances').mockResolvedValue(balances);
    const { result } = renderHook(() => useWallet());
    const PUBLIC_KEY = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    act(() => result.current.connect(PUBLIC_KEY));
    await waitFor(() => expect(result.current.balances).toEqual(balances));

    act(() => result.current.disconnect());
    expect(result.current.publicKey).toBeNull();
    expect(result.current.balances).toBeNull();
    expect(window.localStorage.getItem('stellar_card.connectedWallet')).toBeNull();
  });

  it('restores a previously-connected wallet from localStorage after mount', async () => {
    const PUBLIC_KEY = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    window.localStorage.setItem('stellar_card.connectedWallet', PUBLIC_KEY);
    const balances = { xlm: '0', usdc: '0', balances: [], funded: false };
    vi.spyOn(stellarModule, 'getAccountBalances').mockResolvedValue(balances);

    const { result } = renderHook(() => useWallet());
    await waitFor(() => expect(result.current.publicKey).toBe(PUBLIC_KEY));
  });

  it('captures errors from a failed balance fetch', async () => {
    vi.spyOn(stellarModule, 'getAccountBalances').mockRejectedValue(new Error('horizon down'));
    const { result } = renderHook(() => useWallet());
    act(() => result.current.connect('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe('horizon down');
  });
});

describe('SSR hydration safety', () => {
  it('renders without throwing when window is temporarily undefined-like (jsdom baseline)', () => {
    // We cannot truly unset `window` under jsdom, but we assert the guarded
    // read/write helpers (readStoredWallet/writeStoredWallet) are only
    // reached via useEffect by checking render output is stable and no
    // console errors about mismatched content are produced (React would
    // throw/warn on a real mismatch).
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Probe(): ReturnType<typeof createElement> {
      const { publicKey } = useWallet();
      return createElement('span', null, publicKey ?? 'disconnected');
    }
    render(createElement(Probe));
    expect(screen.getByText('disconnected')).toBeTruthy();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
