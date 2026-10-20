import { Address, StrKey, xdr } from '@stellar/stellar-sdk';
import { resolveCredentials } from '../config';
import { resolveNetworkConfigFromEnv } from '../network';

const MIN_NODE_MAJOR = 18;
const REQUEST_TIMEOUT_MS = 5000;
const COLORS = { green: '\x1b[32m', red: '\x1b[31m', reset: '\x1b[0m' };

interface DoctorCheck {
  label: string;
  ok: boolean;
  detail: string;
  suggestion?: string;
}

export interface DoctorDeps {
  fetch?: typeof fetch;
  out?: (text: string) => void;
  color?: boolean;
  now?: () => number;
  nodeVersion?: string;
  platform?: string;
  architecture?: string;
  sdkVersion?: string;
  backendUrl?: string;
  contractId?: string;
  checkContract?: (
    contractId: string,
    rpcUrl: string,
    networkPassphrase: string,
    signal: AbortSignal,
  ) => Promise<boolean>;
}

function parseArgs(argv: string[]): { help: boolean; contractId?: string } {
  let contractId: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') help = true;
    else if (arg === '--contract') contractId = argv[++i];
    else if (arg.startsWith('--contract=')) contractId = arg.slice('--contract='.length);
  }
  return { help, contractId };
}

function usage(): string {
  return `Usage: stellar_card doctor [--contract <C-address>]

Check the local runtime, backend API, Stellar endpoints, and receiver contract.

Options:
  --contract <C-address>  Receiver contract id (overrides RECEIVER_CONTRACT_ID)
  -h, --help              Show this message
`;
}

function packageVersion(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('../../package.json') as { version: string }).version;
}

function endpointHeaders(headers?: Record<string, string>, apiKey?: string): HeadersInit {
  const result: Record<string, string> = {
    'content-type': 'application/json',
    ...headers,
  };
  if (apiKey && !result.Authorization && !result.authorization) {
    result.Authorization = `Bearer ${apiKey}`;
  }
  return result;
}

async function rpcRequest(
  fetchImpl: typeof fetch,
  url: string,
  headers: HeadersInit,
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  const body = (await response.json()) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (body.error) throw new Error(body.error.message || 'RPC returned an error');
  return body.result;
}

async function contractExists(
  fetchImpl: typeof fetch,
  contractId: string,
  rpcUrl: string,
  networkPassphrase: string,
  headers: HeadersInit,
  signal: AbortSignal,
): Promise<boolean> {
  if (!StrKey.isValidContract(contractId)) {
    throw new Error('contract id is not a valid Stellar contract address');
  }
  const key = xdr.LedgerKey.contractData({
    contract: new Address(contractId).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
  });
  const result = (await rpcRequest(
    fetchImpl,
    rpcUrl,
    headers,
    'getLedgerEntries',
    { keys: [key.toXDR('base64')] },
    signal,
  )) as { entries?: unknown[] } | undefined;
  void networkPassphrase;
  return Boolean(result && Array.isArray(result.entries) && result.entries.length > 0);
}

async function measure(
  label: string,
  now: () => number,
  check: (signal: AbortSignal) => Promise<string>,
  suggestion: string,
): Promise<DoctorCheck> {
  const startedAt = now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const detail = await check(controller.signal);
    return { label, ok: true, detail: `${detail} (${Math.max(0, now() - startedAt)} ms)` };
  } catch (error) {
    const message = controller.signal.aborted
      ? `request timed out after ${REQUEST_TIMEOUT_MS} ms`
      : error instanceof Error
        ? error.message
        : String(error);
    return { label, ok: false, detail: message, suggestion };
  } finally {
    clearTimeout(timeout);
  }
}

function formatCheck(check: DoctorCheck, color: boolean): string {
  const marker = check.ok ? '\u2713' : '\u2717';
  const tint = check.ok ? COLORS.green : COLORS.red;
  const line = `${color ? tint : ''}${marker}${color ? COLORS.reset : ''} ${check.label}: ${check.detail}`;
  return check.suggestion ? `${line}\n  Fix: ${check.suggestion}\n` : `${line}\n`;
}

export async function doctorCommand(argv: string[], deps: DoctorDeps = {}): Promise<number> {
  const args = parseArgs(argv);
  const out = deps.out ?? ((text) => process.stdout.write(text));
  const color = deps.color ?? (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
  if (args.help) {
    out(usage());
    return 0;
  }

  const checks: DoctorCheck[] = [];
  const nodeVersion = deps.nodeVersion ?? process.version;
  const nodeMajor = Number(/^v?(\d+)/.exec(nodeVersion)?.[1]);
  checks.push(
    Number.isFinite(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR
      ? { label: 'Node.js', ok: true, detail: nodeVersion }
      : {
          label: 'Node.js',
          ok: false,
          detail: `${nodeVersion} is unsupported`,
          suggestion: `Install Node.js ${MIN_NODE_MAJOR} or newer.`,
        },
  );
  checks.push({
    label: 'Platform',
    ok: true,
    detail: `${deps.platform ?? process.platform} ${deps.architecture ?? process.arch}`,
  });
  checks.push({
    label: 'SDK',
    ok: true,
    detail: deps.sdkVersion ?? packageVersion(),
  });

  try {
    const network = resolveNetworkConfigFromEnv();
    const credentials = resolveCredentials();
    const backendUrl = deps.backendUrl ?? credentials.baseUrl ?? 'https://api.stellar_card.com/v1';
    const backendStatusUrl = new URL('/status', backendUrl).toString();
    const fetchImpl = deps.fetch ?? fetch;
    const now = deps.now ?? Date.now;
    const rpcHeaders = endpointHeaders(network.sorobanRpc.headers, network.sorobanRpc.apiKey);
    const contractId = args.contractId ?? deps.contractId ?? process.env.RECEIVER_CONTRACT_ID;

    const networkChecks = await Promise.all([
      measure(
        'Backend API',
        now,
        async (signal) => {
          const response = await fetchImpl(backendStatusUrl, { signal });
          if (!response.ok)
            throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
          return 'reachable';
        },
        'Check the backend URL and network access; configure CARDS402_BASE_URL if needed.',
      ),
      measure(
        'Horizon',
        now,
        async (signal) => {
          const response = await fetchImpl(network.horizon.url.replace(/\/+$/, ''), {
            headers: endpointHeaders(network.horizon.headers, network.horizon.apiKey),
            signal,
          });
          if (!response.ok)
            throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
          return `${network.horizon.url} reachable`;
        },
        'Check STELLAR_HORIZON_URL and confirm the Horizon service is available.',
      ),
      measure(
        'Soroban RPC',
        now,
        async (signal) => {
          const result = (await rpcRequest(
            fetchImpl,
            network.sorobanRpc.url,
            rpcHeaders,
            'getHealth',
            {},
            signal,
          )) as { status?: string } | undefined;
          if (result?.status && result.status.toLowerCase() !== 'healthy') {
            throw new Error(`RPC reports ${result.status}`);
          }
          return `${network.sorobanRpc.url} reachable`;
        },
        'Check STELLAR_SOROBAN_RPC_URL and confirm the Soroban RPC service is healthy.',
      ),
    ]);
    checks.push(...networkChecks);

    if (!contractId) {
      checks.push({
        label: 'Receiver contract',
        ok: false,
        detail: 'no contract id configured',
        suggestion: 'Pass --contract <C-address> or set RECEIVER_CONTRACT_ID.',
      });
    } else {
      checks.push(
        await measure(
          'Receiver contract',
          now,
          async (signal) => {
            const exists = deps.checkContract
              ? await deps.checkContract(
                  contractId,
                  network.sorobanRpc.url,
                  network.networkPassphrase,
                  signal,
                )
              : await contractExists(
                  fetchImpl,
                  contractId,
                  network.sorobanRpc.url,
                  network.networkPassphrase,
                  rpcHeaders,
                  signal,
                );
            if (!exists) throw new Error('contract instance was not found on this network');
            return `deployed on ${network.networkName}`;
          },
          `Verify the contract id and target network (${network.networkName}); deploy the receiver contract if needed.`,
        ),
      );
    }
  } catch (error) {
    checks.push({
      label: 'Configuration',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      suggestion: 'Review the Stellar endpoint and backend environment settings.',
    });
  }

  out('stellar_card doctor\n');
  for (const check of checks) out(formatCheck(check, color));
  return checks.every((check) => check.ok) ? 0 : 1;
}
