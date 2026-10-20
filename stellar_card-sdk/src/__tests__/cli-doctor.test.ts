import { describe, it, expect, vi, afterEach } from 'vitest';
import { doctorCommand } from '../commands/doctor';

afterEach(() => {
  vi.unstubAllGlobals();
});

function harness() {
  let out = '';
  return {
    deps: { out: (text: string) => (out += text), color: false },
    get out() {
      return out;
    },
  };
}

function healthyFetch() {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return new Response(JSON.stringify({ result: { status: 'healthy' } }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
}

describe('stellar_card doctor', () => {
  it('prints runtime and endpoint checks and returns success when all checks pass', async () => {
    const h = harness();
    const fetch = healthyFetch();
    const checkContract = vi.fn().mockResolvedValue(true);
    const code = await doctorCommand(['--contract', `C${'A'.repeat(55)}`], {
      ...h.deps,
      fetch,
      checkContract,
      backendUrl: 'https://api.example.test/v1',
      nodeVersion: 'v22.0.0',
      platform: 'linux',
      architecture: 'x64',
      sdkVersion: '1.2.3',
    });

    expect(code).toBe(0);
    expect(h.out).toContain('Node.js: v22.0.0');
    expect(h.out).toContain('Platform: linux x64');
    expect(h.out).toContain('SDK: 1.2.3');
    expect(h.out).toContain('Backend API: reachable');
    expect(h.out).toContain('Horizon: https://horizon.stellar.org reachable');
    expect(h.out).toContain('Soroban RPC: https://mainnet.sorobanrpc.com reachable');
    expect(h.out).toContain('Receiver contract: deployed on Mainnet');
    expect(checkContract).toHaveBeenCalledWith(
      `C${'A'.repeat(55)}`,
      'https://mainnet.sorobanrpc.com',
      expect.any(String),
      expect.any(AbortSignal),
    );
    expect(fetch).toHaveBeenCalledWith('https://api.example.test/status', expect.any(Object));
  });

  it('suggests fixes and returns failure for unsupported Node and missing contract id', async () => {
    const h = harness();
    const code = await doctorCommand([], {
      ...h.deps,
      fetch: healthyFetch(),
      backendUrl: 'https://api.example.test/v1',
      nodeVersion: 'v16.0.0',
    });

    expect(code).toBe(1);
    expect(h.out).toContain('Install Node.js 18 or newer.');
    expect(h.out).toContain('Pass --contract <C-address> or set RECEIVER_CONTRACT_ID.');
  });

  it('reports unreachable services and contract lookup failures', async () => {
    const h = harness();
    const fetch = vi.fn(async () => new Response('unavailable', { status: 503 }));
    const code = await doctorCommand(['--contract', `C${'A'.repeat(55)}`], {
      ...h.deps,
      fetch: fetch as typeof globalThis.fetch,
      checkContract: vi.fn().mockResolvedValue(false),
      backendUrl: 'https://api.example.test/v1',
    });

    expect(code).toBe(1);
    expect(h.out).toContain('Backend API: HTTP 503');
    expect(h.out).toContain('Horizon: HTTP 503');
    expect(h.out).toContain('Soroban RPC: HTTP 503');
    expect(h.out).toContain('contract instance was not found on this network');
    expect(h.out).toContain('Fix:');
  });

  it('shows usage without making network requests', async () => {
    const h = harness();
    const fetch = vi.fn();
    expect(await doctorCommand(['--help'], { ...h.deps, fetch })).toBe(0);
    expect(h.out).toContain('Usage: stellar_card doctor');
    expect(fetch).not.toHaveBeenCalled();
  });
});
