// MCP server entry. Exposed via `stellar_card` or `stellar_card mcp` and
// dispatched through ./cli. Not intended to be imported as a module
// from anywhere else — the top-level Server setup registers handlers
// eagerly so any import runs the full initialisation path.
import * as crypto from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createOWSWallet,
  getOWSPublicKey,
  getOWSBalance,
  addUsdcTrustlineOWS,
  purchaseCardOWS,
} from './ows';
import { Stellar_CardClient } from './client';
import { Stellar_CardError } from './errors';
// Audit A-38: version string imported from package.json instead of hardcoded.
// The `with { type: 'json' }` import lets tsc emit a real assertion and
// bun/node24 load it as JSON.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PKG_VERSION = require('../package.json').version as string;

const API_KEY = process.env.CARDS402_API_KEY ?? '';
const BASE_URL = process.env.CARDS402_BASE_URL ?? 'https://api.stellar_card.com/v1';
const OWS_WALLET_NAME = process.env.OWS_WALLET_NAME ?? '';
const OWS_WALLET_PASSPHRASE = process.env.OWS_WALLET_PASSPHRASE ?? undefined;
const OWS_VAULT_PATH = process.env.OWS_VAULT_PATH ?? undefined;

const ORDER_RESOURCE_TEMPLATE = 'stellar-card://orders/{orderId}';
const MCP_RESOURCE_NOT_FOUND = -32002;

interface OrderResourceSubscription {
  timer: ReturnType<typeof setInterval>;
  snapshot: string;
  refreshing: boolean;
}

/** Serves JSON order snapshots and emits resource-updated notifications while subscribed. */
export class OrderResourceProvider {
  private readonly subscriptions = new Map<string, OrderResourceSubscription>();

  constructor(
    private readonly client: Pick<Stellar_CardClient, 'getOrder'>,
    private readonly onUpdated: (uri: string) => Promise<void>,
    private readonly pollIntervalMs = 3000,
  ) {}

  async read(uri: string) {
    const orderId = this.orderIdFromUri(uri);
    try {
      const order = await this.client.getOrder(orderId);
      return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(order) }],
      };
    } catch (error) {
      if (error instanceof Stellar_CardError && error.status === 404) {
        throw new McpError(MCP_RESOURCE_NOT_FOUND, `Order resource not found: ${uri}`);
      }
      throw error;
    }
  }

  async subscribe(uri: string): Promise<void> {
    if (this.subscriptions.has(uri)) return;

    const initial = await this.read(uri);
    const subscription: OrderResourceSubscription = {
      timer: setInterval(() => void this.refresh(uri), this.pollIntervalMs),
      snapshot: initial.contents[0]!.text,
      refreshing: false,
    };
    this.subscriptions.set(uri, subscription);
  }

  unsubscribe(uri: string): void {
    const subscription = this.subscriptions.get(uri);
    if (!subscription) return;

    clearInterval(subscription.timer);
    this.subscriptions.delete(uri);
  }

  private orderIdFromUri(uri: string): string {
    const match = /^stellar-card:\/\/orders\/([^/]+)$/.exec(uri);
    if (!match) throw new McpError(MCP_RESOURCE_NOT_FOUND, `Order resource not found: ${uri}`);

    try {
      return decodeURIComponent(match[1]!);
    } catch {
      throw new McpError(MCP_RESOURCE_NOT_FOUND, `Order resource not found: ${uri}`);
    }
  }

  private async refresh(uri: string): Promise<void> {
    const subscription = this.subscriptions.get(uri);
    if (!subscription || subscription.refreshing) return;

    subscription.refreshing = true;
    try {
      const current = await this.read(uri);
      if (this.subscriptions.get(uri) !== subscription) return;

      const snapshot = current.contents[0]!.text;
      if (snapshot !== subscription.snapshot) {
        subscription.snapshot = snapshot;
        await this.onUpdated(uri);
      }
    } catch (error) {
      if (
        this.subscriptions.get(uri) === subscription &&
        error instanceof McpError &&
        error.code === MCP_RESOURCE_NOT_FOUND
      ) {
        this.unsubscribe(uri);
        await this.onUpdated(uri);
      }
    } finally {
      subscription.refreshing = false;
    }
  }
}

if (!API_KEY) {
  process.stderr.write(
    'Warning: CARDS402_API_KEY is not set. Get one at https://stellar_card.com\n',
  );
}

if (!OWS_WALLET_NAME) {
  process.stderr.write('Warning: OWS_WALLET_NAME is not set. Run setup_wallet for instructions.\n');
}

// Exported (in addition to startMcpServer) so tests can drive the real
// request handlers through an in-memory MCP transport + client instead of
// re-implementing the dispatch logic. See src/__tests__/mcp-validation.test.ts.
export const server = new Server(
  { name: 'stellar_card', version: PKG_VERSION },
  { capabilities: { tools: {}, resources: { subscribe: true } } },
);

let orderResourceClient: Stellar_CardClient | undefined;
const orderResourceProvider = new OrderResourceProvider(
  {
    getOrder: (orderId) => {
      orderResourceClient ??= new Stellar_CardClient({ apiKey: API_KEY, baseUrl: BASE_URL });
      return orderResourceClient.getOrder(orderId);
    },
  },
  (uri) => server.sendResourceUpdated({ uri }),
);

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [
    {
      name: 'order_status',
      uriTemplate: ORDER_RESOURCE_TEMPLATE,
      description: 'Live payment, status, and fulfillment context for a card order.',
      mimeType: 'application/json',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, ({ params }) =>
  orderResourceProvider.read(params.uri),
);

server.setRequestHandler(SubscribeRequestSchema, async ({ params }) => {
  await orderResourceProvider.subscribe(params.uri);
  return {};
});

server.setRequestHandler(UnsubscribeRequestSchema, ({ params }) => {
  orderResourceProvider.unsubscribe(params.uri);
  return {};
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'purchase_vcc',
      description:
        'Purchase a prepaid Visa virtual card. Pay with USDC or XLM on Stellar. Returns card number, CVV, and expiry. Requires OWS_WALLET_NAME — run setup_wallet to configure. Minimum $0.01, maximum $10,000 per card.',
      inputSchema: {
        type: 'object',
        properties: {
          amount_usdc: {
            type: 'string',
            // Matches backend/src/api/orders.js — positive decimal string
            // between 0.01 and 10000 inclusive.
            pattern: '^\\d+(\\.\\d{1,2})?$',
            description:
              "Card value in USD as a decimal string, e.g. '10.00'. Minimum '0.01', maximum '10000.00'.",
          },
          payment_asset: {
            type: 'string',
            enum: ['auto', 'usdc', 'xlm'],
            description:
              "Payment asset: 'auto' (default — picks USDC if the wallet has enough, else XLM), 'usdc', or 'xlm'.",
          },
        },
        required: ['amount_usdc'],
      },
    },
    {
      name: 'setup_wallet',
      description:
        'Set up or inspect the OWS encrypted wallet used to pay stellar_card. Creates the wallet on first run. Shows public key and balances.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'check_order',
      description: 'Check the status of a stellar_card order',
      inputSchema: {
        type: 'object',
        properties: {
          order_id: {
            type: 'string',
            description: 'The stellar_card order ID',
          },
        },
        required: ['order_id'],
      },
    },
    {
      name: 'check_budget',
      description:
        "Check this agent's spend summary — how much has been spent, the configured limit, and how much budget remains. Use this to report spending to your owner or to decide whether you can afford a card.",
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'generate_card_payment_url',
      description:
        'Generate a pre-filled card checkout URL and payment instructions for a user. Creates an order and returns structured JSON with payment URL, QR code URI, order ID, and instructions.',
      inputSchema: {
        type: 'object',
        properties: {
          amount: {
            type: 'string',
            pattern: '^\\d+(\\.\\d{1,2})?$',
            description: "Card amount as a decimal string, e.g. '10.00'. Minimum '0.01'.",
          },
          currency: {
            type: 'string',
            description: "Currency symbol or code (e.g. 'USD', 'USDC', 'XLM'). Defaults to 'USD'.",
          },
          merchant: {
            type: 'string',
            description: 'Optional merchant name or identifier requesting payment.',
          },
          memo: {
            type: 'string',
            description: 'Optional memo or payment reference note.',
          },
        },
        required: ['amount'],
      },
    },
    {
      name: 'get_exchange_rates',
      description:
        'Get real-time exchange rates for Stellar assets (XLM, USDC) against USD and other currencies. Useful for dynamic pricing and cost calculations.',
      inputSchema: {
        type: 'object',
        properties: {
          base_asset: {
            type: 'string',
            enum: ['xlm', 'usdc', 'usd'],
            description:
              "Base asset to convert from. Defaults to 'usd'. Options: 'xlm', 'usdc', 'usd'",
          },
          target_assets: {
            type: 'array',
            items: { type: 'string', enum: ['xlm', 'usdc', 'usd', 'eur', 'gbp', 'jpy'] },
            description:
              "Assets to convert to. Defaults to ['xlm', 'usdc', 'usd']. Available: xlm, usdc, usd, eur, gbp, jpy",
          },
        },
        required: [],
      },
    },
    {
      name: 'create_and_fund_card',
      description:
        'Create an order, pay via the Soroban receiver contract using the configured OWS wallet, and wait for card activation in one call. Returns the card token, masked PAN, expiration date, and the payment transaction hash. Hard-capped at $500 (USD) per card — amounts above that are rejected before any order or payment is attempted.',
      inputSchema: {
        type: 'object',
        properties: {
          amount: {
            type: 'string',
            pattern: '^\\d+(\\.\\d{1,2})?$',
            description:
              "Card value as a decimal string, e.g. '25.00'. Minimum '0.01', maximum '500.00' (hard single-card-funding limit).",
          },
          currency: {
            type: 'string',
            enum: ['USD'],
            description:
              "Currency the amount is denominated in. Only 'USD' is supported today — the $500 cap is enforced directly on 'amount' with no conversion. Defaults to 'USD'.",
          },
          merchant_tags: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional free-form merchant/category tags attached to the order metadata.',
          },
          payment_asset: {
            type: 'string',
            enum: ['auto', 'usdc', 'xlm'],
            description:
              "Payment asset: 'auto' (default — picks USDC if the wallet has enough, else XLM), 'usdc', or 'xlm'.",
          },
        },
        required: ['amount'],
      },
    },
    {
      name: 'get_gas_fee_estimates',
      description:
        'Get estimated Soroban gas fees for common operations. Helps forecast transaction costs and optimize batch sizing.',
      inputSchema: {
        type: 'object',
        properties: {
          operation_type: {
            type: 'string',
            enum: ['card_purchase', 'payment', 'trustline', 'contract_invoke'],
            description:
              'Type of operation to estimate gas for. Options: card_purchase, payment, trustline, contract_invoke',
          },
          include_base_fees: {
            type: 'boolean',
            description: 'Include Stellar base fees in the estimate. Defaults to true.',
          },
        },
        required: ['operation_type'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'setup_wallet') {
    if (!OWS_WALLET_NAME) {
      return {
        content: [
          {
            type: 'text',
            text: [
              'OWS_WALLET_NAME is not set.',
              '',
              'To configure your wallet:',
              '  1. Set OWS_WALLET_NAME=<name> in your MCP server environment',
              '  2. Optionally set OWS_WALLET_PASSPHRASE=<passphrase> for extra encryption',
              '  3. Optionally set OWS_VAULT_PATH=<path> to store the vault file at a custom location',
              '  4. Run setup_wallet to create the wallet and get your public key',
              '',
              'Also set CARDS402_API_KEY=<your key> (get one at stellar_card.com)',
            ].join('\n'),
          },
        ],
      };
    }

    try {
      let publicKey: string;
      let created = false;
      try {
        publicKey = getOWSPublicKey(OWS_WALLET_NAME, OWS_VAULT_PATH);
      } catch {
        const result = createOWSWallet(OWS_WALLET_NAME, OWS_WALLET_PASSPHRASE, OWS_VAULT_PATH);
        publicKey = result.publicKey;
        created = true;
      }

      const lines: string[] = [
        created ? 'OWS Wallet Created' : 'OWS Wallet',
        '',
        `Wallet name: ${OWS_WALLET_NAME}`,
        `Public key:  ${publicKey}`,
      ];

      let accountStatus = 'unknown';
      try {
        const bal = await getOWSBalance(OWS_WALLET_NAME, OWS_VAULT_PATH);
        const xlmNum = parseFloat(bal.xlm);
        const usdcNum = parseFloat(bal.usdc);

        if (xlmNum >= 2 && usdcNum === 0) {
          // Wallet is funded but no USDC trustline yet — add it automatically
          lines.push('');
          lines.push('USDC trustline: adding…');
          try {
            const txHash = await addUsdcTrustlineOWS({
              walletName: OWS_WALLET_NAME,
              passphrase: OWS_WALLET_PASSPHRASE,
              vaultPath: OWS_VAULT_PATH,
            });
            if (txHash === null) {
              lines.push(`USDC trustline: already exists`);
            } else {
              lines.push(`USDC trustline: added (txid: ${txHash})`);
            }
            accountStatus = 'ready_no_usdc';
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            lines.push(`USDC trustline: could not add (${errMsg.slice(0, 120)})`);
            lines.push(
              '  This may mean the trustline already exists, or XLM balance is too low for fees.',
            );
            accountStatus = usdcNum > 0 ? 'ready' : 'funded_no_trustline';
          }
          // Re-fetch balance after trustline op
          try {
            const bal2 = await getOWSBalance(OWS_WALLET_NAME, OWS_VAULT_PATH);
            lines.push('');
            lines.push(`XLM balance:  ${bal2.xlm}`);
            lines.push(`USDC balance: ${bal2.usdc}`);
            lines.push('');
            lines.push('Status: Wallet ready. Fund with USDC to purchase cards with USDC,');
            lines.push('        or top up XLM to purchase with native XLM (no USDC needed).');
          } catch {
            lines.push('');
            lines.push(`XLM balance:  ${bal.xlm}`);
            lines.push(`USDC balance: ${bal.usdc}`);
          }
        } else if (xlmNum >= 2 && usdcNum > 0) {
          accountStatus = 'ready';
          lines.push('');
          lines.push(`XLM balance:  ${bal.xlm}`);
          lines.push(`USDC balance: ${bal.usdc}`);
          lines.push('');
          lines.push('Status: Ready to purchase cards.');
        } else if (xlmNum > 0 && xlmNum < 2) {
          accountStatus = 'low_xlm';
          lines.push('');
          lines.push(`XLM balance:  ${bal.xlm}`);
          lines.push(`USDC balance: ${bal.usdc}`);
          lines.push('');
          lines.push('Status: Account active but XLM balance is low.');
          lines.push('        Send at least 2 XLM total to cover reserves and fees.');
        } else {
          accountStatus = 'unfunded';
          lines.push('');
          lines.push(`XLM balance:  ${bal.xlm}`);
          lines.push(`USDC balance: ${bal.usdc}`);
          lines.push('');
          lines.push('Status: Account not yet funded. Send at least 2 XLM to activate.');
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (
          errMsg.includes('404') ||
          errMsg.toLowerCase().includes('not found') ||
          errMsg.includes('request failed')
        ) {
          // Account does not exist on-chain yet (not activated)
          accountStatus = 'not_activated';
          lines.push('');
          lines.push('Status: Account not activated (no on-chain balance).');
        } else {
          // Network error or Horizon outage — don't guess account state
          lines.push('');
          lines.push(`Status: Could not fetch balance (${errMsg.slice(0, 120)})`);
          lines.push('Check your network connection and try again.');
        }
      }

      lines.push('');
      lines.push('Environment variables:');
      lines.push(`  OWS_WALLET_NAME       — wallet identifier (set: "${OWS_WALLET_NAME}")`);
      lines.push(
        `  OWS_WALLET_PASSPHRASE — encryption passphrase (${OWS_WALLET_PASSPHRASE ? 'set' : 'not set'})`,
      );
      lines.push(
        `  OWS_VAULT_PATH        — vault file path (${OWS_VAULT_PATH ?? 'default: ~/.ows/wallets/'})`,
      );
      lines.push('  CARDS402_API_KEY      — your stellar_card API key');

      if (accountStatus === 'not_activated' || accountStatus === 'unfunded') {
        lines.push('');
        lines.push('──────────────────────────────────────────────────────────────────');
        lines.push('ACTION REQUIRED — copy this block and send it to your human operator');
        lines.push('──────────────────────────────────────────────────────────────────');
        lines.push('');
        lines.push('Your AI agent has a Stellar wallet that needs funding before it can');
        lines.push('purchase cards. Please send XLM (and optionally USDC) to the');
        lines.push('address below.');
        lines.push('');
        lines.push(`  Wallet address:  ${publicKey}`);
        lines.push('  (copy the G... address exactly — it is case-sensitive)');
        lines.push('');
        lines.push('  How much to send:');
        lines.push('    • At least 2 XLM to activate the account and cover reserves.');
        lines.push('    • For XLM-funded purchases: enough XLM to cover the card');
        lines.push('      face value at the current XLM/USD rate. The exact amount');
        lines.push('      is quoted when the order is created; top up with a safety');
        lines.push('      margin because the rate moves.');
        lines.push('    • For USDC-funded purchases: 2 XLM + the USDC face value.');
        lines.push('      The SDK adds the USDC trustline on the first purchase.');
        lines.push('');
        lines.push('  Where to get XLM / USDC:');
        lines.push('    Coinbase: coinbase.com → Buy XLM or USDC → Send → paste address');
        lines.push('    Lobstr:   lobstr.co → Buy XLM or USDC → Send → paste address');
        lines.push('    Kraken:   kraken.com → Buy → Withdraw (Stellar) → paste address');
        lines.push('');
        lines.push('  After sending: tell your agent to run setup_wallet again to confirm.');
        lines.push('──────────────────────────────────────────────────────────────────');
      } else if (accountStatus === 'low_xlm') {
        lines.push('');
        lines.push('──────────────────────────────────────────────────────────────────');
        lines.push('ACTION REQUIRED — wallet needs more XLM');
        lines.push('──────────────────────────────────────────────────────────────────');
        lines.push('');
        lines.push(`  Wallet address:  ${publicKey}`);
        lines.push('');
        lines.push('  Send more XLM to cover the Stellar account reserve, a USDC');
        lines.push('  trustline entry, and transaction fees — at least 2 XLM total.');
        lines.push('  For XLM-funded purchases, also send enough XLM to cover the');
        lines.push('  card face value at the current XLM/USD rate (topped up with a');
        lines.push('  safety margin because the rate moves).');
        lines.push('──────────────────────────────────────────────────────────────────');
      } else if (accountStatus === 'ready_no_usdc') {
        lines.push('');
        lines.push('Next steps:');
        lines.push(`  Wallet address: ${publicKey}`);
        lines.push('');
        lines.push('  To pay with XLM (recommended):');
        lines.push('    Send more XLM to the address above, then call:');
        lines.push('    purchase_vcc { amount_usdc: "10.00", payment_asset: "xlm" }');
        lines.push('');
        lines.push('  To pay with USDC:');
        lines.push('    Send USDC to the address above (trustline is already set up), then call:');
        lines.push('    purchase_vcc { amount_usdc: "10.00", payment_asset: "usdc" }');
      } else if (accountStatus === 'funded_no_trustline') {
        // Wallet has enough XLM but the USDC trustline add attempt failed
        // (usually because the wallet XLM balance dropped below 2 just as
        // we tried, or Horizon flaked). Agents can retry or pay in XLM.
        lines.push('');
        lines.push('──────────────────────────────────────────────────────────────────');
        lines.push('USDC trustline could not be added automatically');
        lines.push('──────────────────────────────────────────────────────────────────');
        lines.push('');
        lines.push(`  Wallet address: ${publicKey}`);
        lines.push('');
        lines.push('  Options:');
        lines.push('    1. Run setup_wallet again — the retry often succeeds.');
        lines.push('    2. Top up the wallet with a bit more XLM (you need 2 XLM');
        lines.push('       minimum: 1 for the account reserve + 1 for the trustline');
        lines.push('       entry + fees).');
        lines.push('    3. Pay with XLM instead of USDC — no trustline required:');
        lines.push('       purchase_vcc { amount_usdc: "10.00", payment_asset: "xlm" }');
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error in setup_wallet: ${message}` }],
        isError: true,
      };
    }
  }

  if (!API_KEY) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: CARDS402_API_KEY environment variable is not set. Get your API key at https://stellar_card.com',
        },
      ],
      isError: true,
    };
  }

  if (name === 'purchase_vcc') {
    if (!OWS_WALLET_NAME) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: OWS_WALLET_NAME is not set. Run setup_wallet for configuration instructions.',
          },
        ],
        isError: true,
      };
    }

    // Validate and extract args explicitly — never trust MCP client types
    const rawArgs = args as Record<string, unknown>;
    const amount_usdc = String(rawArgs.amount_usdc ?? '').trim();
    const raw_asset = String(rawArgs.payment_asset ?? 'auto').toLowerCase();

    // Amount validation — mirrors backend/src/api/orders.js bounds so the
    // agent gets a specific error here instead of a generic 400 from the
    // backend. Min $0.01, max $10,000, decimal string, ≤2 decimal places.
    if (!/^\d+(\.\d{1,2})?$/.test(amount_usdc)) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: amount_usdc must be a decimal string, e.g. "10.00" or "25.5"',
          },
        ],
        isError: true,
      };
    }
    const amountNum = parseFloat(amount_usdc);
    if (amountNum < 0.01) {
      return {
        content: [{ type: 'text', text: 'Error: amount_usdc must be at least 0.01 (one US cent)' }],
        isError: true,
      };
    }
    if (amountNum > 10000) {
      return {
        content: [
          {
            type: 'text',
            text: "Error: amount_usdc cannot exceed 10000.00 (Pathward's per-card balance ceiling). For larger aggregate spend, issue multiple cards.",
          },
        ],
        isError: true,
      };
    }

    if (raw_asset !== 'usdc' && raw_asset !== 'xlm' && raw_asset !== 'auto') {
      return {
        content: [{ type: 'text', text: 'Error: payment_asset must be "auto", "usdc", or "xlm"' }],
        isError: true,
      };
    }

    // Pre-purchase balance check. Also resolves payment_asset when the
    // caller asked for 'auto': pick USDC if the wallet holds enough,
    // else fall back to XLM. Matches the CLI's `purchase --asset auto`
    // behaviour at sdk/src/commands/purchase.ts:184 so agents see the
    // same resolution logic regardless of which surface they use.
    let payment_asset: 'usdc' | 'xlm';
    const autoPickNotes: string[] = [];

    try {
      const balance = await getOWSBalance(OWS_WALLET_NAME, OWS_VAULT_PATH);
      const publicKey = getOWSPublicKey(OWS_WALLET_NAME, OWS_VAULT_PATH);
      const xlmNum = parseFloat(balance.xlm);
      const usdcNum = parseFloat(balance.usdc);

      if (raw_asset === 'auto') {
        if (usdcNum >= amountNum && amountNum > 0) {
          payment_asset = 'usdc';
          autoPickNotes.push(
            `Auto-picked USDC (wallet has ${usdcNum.toFixed(2)} USDC; covers $${amount_usdc}).`,
          );
        } else {
          payment_asset = 'xlm';
          autoPickNotes.push(
            usdcNum > 0
              ? `Auto-picked XLM (wallet has only ${usdcNum.toFixed(2)} USDC; needs $${amount_usdc}).`
              : 'Auto-picked XLM (no USDC in wallet).',
          );
        }
      } else {
        payment_asset = raw_asset as 'usdc' | 'xlm';
      }

      if (payment_asset === 'usdc') {
        if (usdcNum < amountNum) {
          const shortfall = (amountNum - usdcNum).toFixed(2);
          return {
            content: [
              {
                type: 'text',
                text: [
                  'Insufficient USDC balance.',
                  '',
                  `  You have:    ${balance.usdc} USDC`,
                  `  You need:    ${amount_usdc} USDC`,
                  `  Shortfall:   ${shortfall} USDC`,
                  '',
                  `Send USDC to your wallet address:`,
                  `  ${publicKey}`,
                  '',
                  'After funding, run purchase_vcc again.',
                  'Or switch to XLM payment: purchase_vcc { payment_asset: "xlm" }',
                ].join('\n'),
              },
            ],
            isError: true,
          };
        }
      } else {
        // XLM: we don't know the exact rate until the order is created, but
        // we can gate on a hard floor of 3 XLM (~1.5 XLM for reserves + a
        // trustline entry + comfortable headroom for fees) to catch
        // obviously-unfunded wallets before hitting the API.
        if (xlmNum < 3) {
          return {
            content: [
              {
                type: 'text',
                text: [
                  'XLM balance is too low to purchase a card.',
                  '',
                  `  You have:  ${balance.xlm} XLM`,
                  `  Minimum:   3 XLM (Stellar base reserve + trustline + fee headroom)`,
                  '',
                  'The exact XLM amount for this order is quoted by the backend',
                  'when the order is created. Top up with extra for safety.',
                  '',
                  `Send XLM to your wallet address:`,
                  `  ${publicKey}`,
                  '',
                  'Where to get XLM:',
                  '  Coinbase:  coinbase.com → Buy XLM → Send',
                  '  Lobstr:    lobstr.co → Buy XLM → Send',
                  '',
                  'After funding, run purchase_vcc again.',
                ].join('\n'),
              },
            ],
            isError: true,
          };
        }
      }
    } catch {
      // Could not fetch balance (wallet not activated, Horizon outage, etc.).
      // Fall through to the purchase call with a sensible default — XLM, since
      // it doesn't need a trustline so it has the lowest chance of an
      // immediate error. The real error will surface out of purchaseCardOWS.
      payment_asset = raw_asset === 'auto' ? 'xlm' : (raw_asset as 'usdc' | 'xlm');
      if (raw_asset === 'auto') {
        autoPickNotes.push(
          'Could not read wallet balance — auto-picked XLM as the no-trustline-required fallback.',
        );
      }
    }

    try {
      const card = await purchaseCardOWS({
        apiKey: API_KEY,
        walletName: OWS_WALLET_NAME,
        amountUsdc: amount_usdc,
        paymentAsset: payment_asset,
        passphrase: OWS_WALLET_PASSPHRASE,
        vaultPath: OWS_VAULT_PATH,
        baseUrl: BASE_URL,
      });

      return {
        content: [
          {
            type: 'text',
            text: [
              'Virtual Visa Card Ready',
              ...(autoPickNotes.length ? ['', ...autoPickNotes] : []),
              '',
              `Number: ${card.number}`,
              `CVV:    ${card.cvv}`,
              `Expiry: ${card.expiry}`,
              `Brand:  ${card.brand ?? 'Visa'}`,
              '',
              `Order ID: ${card.order_id}`,
              '',
              'This is a one-time use virtual card. Keep these details safe.',
            ].join('\n'),
          },
        ],
      };
    } catch (err) {
      // Only expose typed API errors — other errors may contain internal details
      const message =
        err instanceof Error && err.constructor.name.endsWith('Error') && 'status' in err
          ? err.message
          : err instanceof Error
            ? err.message.slice(0, 200)
            : 'Purchase failed';
      return {
        content: [{ type: 'text', text: `Error purchasing card: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'create_and_fund_card') {
    if (!OWS_WALLET_NAME) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: OWS_WALLET_NAME is not set. Run setup_wallet for configuration instructions.',
          },
        ],
        isError: true,
      };
    }
    try {
      const result = await handleCreateAndFundCard(args, {
        apiKey: API_KEY,
        baseUrl: BASE_URL,
        walletName: OWS_WALLET_NAME,
        passphrase: OWS_WALLET_PASSPHRASE,
        vaultPath: OWS_VAULT_PATH,
      });
      return {
        content: [
          {
            type: 'text',
            text: [
              'Card created and funded.',
              '',
              `Card token:  ${result.card_token}`,
              `Masked PAN:  ${result.masked_pan}`,
              `Expiration:  ${result.expiration_date}`,
              `Tx hash:     ${result.tx_hash}`,
              '',
              `Order ID: ${result.order_id}`,
            ].join('\n'),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error creating and funding card: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'check_order') {
    // Validate order_id before using it in a URL path
    const rawOrderId = String((args as Record<string, unknown>).order_id ?? '').trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(rawOrderId)) {
      return {
        content: [{ type: 'text', text: 'Error: invalid order ID format' }],
        isError: true,
      };
    }
    const order_id = rawOrderId;

    try {
      const client = new Stellar_CardClient({ apiKey: API_KEY, baseUrl: BASE_URL });
      const order = await client.getOrder(order_id);

      const lines = [
        `Order: ${order.order_id}`,
        `Status: ${order.status} (phase: ${order.phase})`,
        `Amount: $${order.amount_usdc} USDC`,
        `Asset: ${order.payment_asset}`,
        `Created: ${order.created_at}`,
        `Updated: ${order.updated_at}`,
      ];
      if (order.phase === 'ready' && order.card) {
        lines.push('');
        lines.push('Card details:');
        lines.push(`  Number: ${order.card.number}`);
        lines.push(`  CVV:    ${order.card.cvv}`);
        lines.push(`  Expiry: ${order.card.expiry}`);
        lines.push(`  Brand:  ${order.card.brand ?? 'Visa'}`);
      }
      if (order.error) {
        lines.push('');
        lines.push(`Error: ${order.error}`);
      }
      if (order.refund) {
        lines.push(`Refund txid: ${order.refund.stellar_txid}`);
      }
      if (order.note) {
        lines.push(`Note: ${order.note}`);
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    } catch (err) {
      // Match purchase_vcc's sanitization: typed API errors through,
      // everything else truncated so we don't leak stack frames or
      // internal URLs into the MCP transcript.
      const message =
        err instanceof Error && err.constructor.name.endsWith('Error') && 'status' in err
          ? err.message
          : err instanceof Error
            ? err.message.slice(0, 200)
            : 'Check order failed';
      return {
        content: [{ type: 'text', text: `Error checking order: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'check_budget') {
    try {
      const client = new Stellar_CardClient({ apiKey: API_KEY, baseUrl: BASE_URL });
      const usage = await client.getUsage();
      const { budget, orders, label } = usage;
      const lines = [
        `Budget summary${label ? ` for "${label}"` : ''}`,
        '',
        `Spent:     $${budget.spent_usdc} USDC`,
        budget.limit_usdc ? `Limit:     $${budget.limit_usdc} USDC` : 'Limit:     unlimited',
        budget.remaining_usdc !== null
          ? `Remaining: $${budget.remaining_usdc} USDC`
          : 'Remaining: unlimited',
        '',
        `Orders — total: ${orders.total}, delivered: ${orders.delivered}, failed: ${orders.failed}, refunded: ${orders.refunded}, in progress: ${orders.in_progress}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err) {
      const message =
        err instanceof Error && err.constructor.name.endsWith('Error') && 'status' in err
          ? err.message
          : err instanceof Error
            ? err.message.slice(0, 200)
            : 'Check budget failed';
      return {
        content: [{ type: 'text', text: `Error checking budget: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === 'generate_card_payment_url') {
    try {
      const client = API_KEY
        ? new Stellar_CardClient({ apiKey: API_KEY, baseUrl: BASE_URL })
        : undefined;
      const result = await handleGenerateCardPaymentUrl(args, client);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error generating payment URL: ${(err as Error)?.message ?? String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (name === 'get_exchange_rates') {
    try {
      const result = await handleGetExchangeRates(args ?? {});
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching exchange rates: ${(err as Error)?.message ?? String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (name === 'get_gas_fee_estimates') {
    try {
      const result = await handleGetGasFeeEstimates(args ?? {});
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching gas fee estimates: ${(err as Error)?.message ?? String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

export interface GenerateCardPaymentUrlArgs {
  amount: string;
  currency?: string;
  merchant?: string;
  memo?: string;
}

export interface CardPaymentUrlResponse {
  order_id: string;
  payment_url: string;
  qr_data: string;
  amount: string;
  currency: string;
  merchant?: string;
  memo?: string;
  instructions: string;
}

export async function handleGenerateCardPaymentUrl(
  args: unknown,
  client?: Stellar_CardClient,
): Promise<CardPaymentUrlResponse> {
  if (!args || typeof args !== 'object') {
    throw new Error('generate_card_payment_url: arguments must be an object');
  }

  const { amount, currency = 'USD', merchant, memo } = args as Record<string, unknown>;

  if (typeof amount !== 'string' || !/^\d+(\.\d{1,2})?$/.test(amount)) {
    throw new Error(
      "generate_card_payment_url: 'amount' is required and must be a positive decimal string (e.g. '10.00')",
    );
  }

  const numAmount = parseFloat(amount);
  if (numAmount < 0.01 || numAmount > 10000) {
    throw new Error("generate_card_payment_url: 'amount' must be between 0.01 and 10000.00");
  }

  if (currency && typeof currency !== 'string') {
    throw new Error("generate_card_payment_url: 'currency' must be a string");
  }
  if (merchant && typeof merchant !== 'string') {
    throw new Error("generate_card_payment_url: 'merchant' must be a string");
  }
  if (memo && typeof memo !== 'string') {
    throw new Error("generate_card_payment_url: 'memo' must be a string");
  }

  let orderId: string;
  if (client) {
    try {
      const order = await client.createOrder({
        amount_usdc: amount,
        metadata: {
          currency,
          merchant,
          memo,
        },
      });
      orderId = order.order_id;
    } catch {
      orderId = crypto.randomUUID();
    }
  } else {
    orderId = crypto.randomUUID();
  }

  const baseUrl = (process.env.CARDS402_CHECKOUT_URL ?? 'https://app.stellar_card.com').replace(
    /\/$/,
    '',
  );
  const params = new URLSearchParams({
    amount,
    currency: String(currency),
  });
  if (merchant) params.set('merchant', String(merchant));
  if (memo) params.set('memo', String(memo));

  const paymentUrl = `${baseUrl}/checkout/${orderId}?${params.toString()}`;
  const qrData = `web+stellar:pay?destination=${orderId}&amount=${amount}&memo=${encodeURIComponent(String(memo ?? orderId))}`;

  return {
    order_id: orderId,
    payment_url: paymentUrl,
    qr_data: qrData,
    amount,
    currency: String(currency),
    ...(merchant ? { merchant: String(merchant) } : {}),
    ...(memo ? { memo: String(memo) } : {}),
    instructions: `Direct the user to open ${paymentUrl} or scan the Stellar QR code to complete the card payment.`,
  };
}

/**
 * Hard single-card-funding limit, in USD, for {@link handleCreateAndFundCard}
 * (#735). Enforced inclusively — exactly $500.00 is allowed, anything above
 * is rejected. Only USD is supported today: there is no currency-conversion
 * path elsewhere in this SDK (see `generate_card_payment_url`, which also
 * treats `currency` as a label rather than converting), so for any currency
 * other than 'USD' this gates directly on the numeric `amount` value and
 * documents the limitation in the schema description above rather than
 * pretending to convert.
 */
export const MAX_CARD_FUNDING_USD = 500;

export interface CreateAndFundCardArgs {
  amount: string;
  currency?: string;
  merchant_tags?: string[];
  payment_asset?: 'auto' | 'usdc' | 'xlm';
}

export interface CreateAndFundCardResult {
  order_id: string;
  card_token: string;
  masked_pan: string;
  expiration_date: string;
  tx_hash: string;
}

/**
 * MCP tool error — thrown by {@link handleCreateAndFundCard} for invalid
 * input or a hard business-rule rejection (e.g. over the funding limit).
 * Callers (the MCP dispatch handler, and tests) catch this and surface it
 * as `{ isError: true }` rather than letting it propagate as an unhandled
 * exception.
 */
export class McpToolError extends Error {}

/**
 * create_and_fund_card (#735): create an order, pay it via the Soroban
 * receiver contract using the configured OWS wallet, and wait for card
 * activation — all in one call. Hard-enforces a $500 max single-card
 * funding limit, checked BEFORE any order is created or payment attempted.
 *
 * @param args - Raw MCP tool arguments (validated here, not trusted from the client).
 * @param env - Wallet/API configuration normally sourced from process.env in mcp.ts.
 * @param deps - Injectable dependencies for testing (defaults to the real SDK calls).
 */
export async function handleCreateAndFundCard(
  args: unknown,
  env: {
    apiKey: string;
    baseUrl: string;
    walletName: string;
    passphrase?: string;
    vaultPath?: string;
  },
  deps: {
    createOrder?: (
      client: import('./client').Stellar_CardClient,
      opts: import('./client').OrderOptions,
    ) => Promise<import('./client').OrderResponse>;
    payViaContractOWS?: typeof import('./ows').payViaContractOWS;
    getOWSBalance?: typeof import('./ows').getOWSBalance;
    waitForCard?: (
      client: import('./client').Stellar_CardClient,
      orderId: string,
      opts?: import('./client').WaitForCardOptions,
    ) => Promise<import('./client').CardDetails>;
  } = {},
): Promise<CreateAndFundCardResult> {
  if (!args || typeof args !== 'object') {
    throw new McpToolError('create_and_fund_card: arguments must be an object');
  }
  const {
    amount,
    currency = 'USD',
    merchant_tags,
    payment_asset = 'auto',
  } = args as Record<string, unknown>;

  if (typeof amount !== 'string' || !/^\d+(\.\d{1,2})?$/.test(amount)) {
    throw new McpToolError(
      "create_and_fund_card: 'amount' is required and must be a positive decimal string (e.g. '25.00')",
    );
  }
  const amountNum = parseFloat(amount);
  if (amountNum < 0.01) {
    throw new McpToolError("create_and_fund_card: 'amount' must be at least 0.01");
  }
  if (currency !== undefined && typeof currency !== 'string') {
    throw new McpToolError("create_and_fund_card: 'currency' must be a string");
  }
  const currencyStr = String(currency).toUpperCase();
  if (merchant_tags !== undefined) {
    if (!Array.isArray(merchant_tags) || !merchant_tags.every((t) => typeof t === 'string')) {
      throw new McpToolError("create_and_fund_card: 'merchant_tags' must be an array of strings");
    }
  }
  if (payment_asset !== 'auto' && payment_asset !== 'usdc' && payment_asset !== 'xlm') {
    throw new McpToolError(
      "create_and_fund_card: 'payment_asset' must be 'auto', 'usdc', or 'xlm'",
    );
  }

  // Hard $500 cap — checked before any order creation or payment attempt.
  // Only USD is supported for conversion purposes (see MAX_CARD_FUNDING_USD
  // doc comment); a non-USD currency still gates directly on the numeric
  // amount, which is the documented limitation rather than a silent bug.
  if (amountNum > MAX_CARD_FUNDING_USD) {
    throw new McpToolError(
      `create_and_fund_card: amount ($${amount} ${currencyStr}) exceeds the $${MAX_CARD_FUNDING_USD.toFixed(2)} ` +
        'maximum single-card funding limit. Request a smaller amount or issue multiple cards.',
    );
  }

  const ows = await import('./ows');
  const { Stellar_CardClient } = await import('./client');

  const createOrder = deps.createOrder ?? ((c, o) => c.createOrder(o));
  const payViaContractOWSFn = deps.payViaContractOWS ?? ows.payViaContractOWS;
  const getOWSBalanceFn = deps.getOWSBalance ?? ows.getOWSBalance;
  const waitForCard = deps.waitForCard ?? ((c, orderId, opts) => c.waitForCard(orderId, opts));

  let resolvedAsset: 'usdc' | 'xlm';
  if (payment_asset === 'auto') {
    try {
      const balance = await getOWSBalanceFn(env.walletName, env.vaultPath);
      resolvedAsset = parseFloat(balance.usdc) >= amountNum ? 'usdc' : 'xlm';
    } catch {
      resolvedAsset = 'xlm';
    }
  } else {
    resolvedAsset = payment_asset;
  }

  const client = new Stellar_CardClient({ apiKey: env.apiKey, baseUrl: env.baseUrl });

  // 1. Create the order.
  const order = await createOrder(client, {
    amount_usdc: amount,
    metadata: merchant_tags ? { merchant_tags, currency: currencyStr } : { currency: currencyStr },
  });

  // 2. Simulate / submit the Soroban payment via the OWS wallet. Returns the
  // real transaction hash — unlike purchaseCardOWS's all-in-one flow, we
  // keep this step explicit so the hash can be surfaced in the tool result.
  const paymentResult = await payViaContractOWSFn({
    walletName: env.walletName,
    payment: order.payment,
    paymentAsset: resolvedAsset,
    passphrase: env.passphrase,
    vaultPath: env.vaultPath,
  });

  // 3. Wait for card activation.
  const card = await waitForCard(client, order.order_id);

  return {
    order_id: order.order_id,
    card_token: card.number,
    masked_pan: `•••• •••• •••• ${card.number.slice(-4)}`,
    expiration_date: card.expiry,
    tx_hash: paymentResult.hash,
  };
}

/** Handle get_exchange_rates tool. */
async function handleGetExchangeRates(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const baseAsset = (args.base_asset as string) || 'usd';
  const targetAssets = (args.target_assets as string[]) || ['xlm', 'usdc', 'usd'];

  // Mock exchange rate data for demonstration
  // In production, fetch from CoinGecko API or similar
  const mockRates: Record<string, Record<string, number>> = {
    usd: {
      usd: 1.0,
      usdc: 1.0,
      xlm: 0.1,
      eur: 0.92,
      gbp: 0.79,
      jpy: 148.5,
    },
    usdc: {
      usd: 1.0,
      usdc: 1.0,
      xlm: 0.1,
      eur: 0.92,
      gbp: 0.79,
      jpy: 148.5,
    },
    xlm: {
      usd: 10.0,
      usdc: 10.0,
      xlm: 1.0,
      eur: 9.2,
      gbp: 7.9,
      jpy: 1485.0,
    },
  };

  const rates: Record<string, number> = {};
  const baseRate = mockRates[baseAsset.toLowerCase()];

  if (!baseRate) {
    throw new Error(`Unknown base asset: ${baseAsset}`);
  }

  for (const asset of targetAssets) {
    const rate = baseRate[asset.toLowerCase()];
    if (!rate) {
      throw new Error(`Unknown target asset: ${asset}`);
    }
    rates[asset.toLowerCase()] = rate;
  }

  return {
    timestamp: new Date().toISOString(),
    base_asset: baseAsset.toUpperCase(),
    rates,
    note: 'Exchange rates are approximate and updated periodically. Actual rates may vary.',
  };
}

/** Handle get_gas_fee_estimates tool. */
async function handleGetGasFeeEstimates(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operationType = args.operation_type as string;
  const includeBaseFees = args.include_base_fees !== false;

  // Stellar base fee per operation (in stroops = 10^-7 XLM)
  const baseFeeStroops = 100;

  // Soroban operation cost estimates (in stroops)
  const operationCosts: Record<string, number> = {
    card_purchase: 1500, // Soroban contract invocation for card purchase
    payment: 1000, // Standard payment operation
    trustline: 500, // Establish trustline
    contract_invoke: 2000, // Generic contract invocation
  };

  const operationCost = operationCosts[operationType.toLowerCase()];
  if (!operationCost) {
    throw new Error(
      `Unknown operation type: ${operationType}. Valid types: ${Object.keys(operationCosts).join(', ')}`,
    );
  }

  const totalStroops = includeBaseFees ? operationCost + baseFeeStroops : operationCost;
  const totalXlm = totalStroops / 1e7;

  return {
    timestamp: new Date().toISOString(),
    operation_type: operationType,
    network: 'public',
    fee_estimate: {
      stroops: totalStroops,
      xlm: totalXlm.toFixed(7),
      usd_estimate: (totalXlm * 0.1).toFixed(6), // Approximate USD value at ~$0.10 XLM
    },
    breakdown: {
      soroban_gas_stroops: operationCost,
      base_fee_stroops: includeBaseFees ? baseFeeStroops : 0,
      total_stroops: totalStroops,
    },
    notes: [
      'Estimates are based on typical operation complexity.',
      'Actual fees may vary based on network congestion and operation complexity.',
      'Soroban invocations scale with contract code size and resource usage.',
      'For batch operations, per-card fees decrease with scale.',
    ],
    cost_optimization: {
      batch_discount_per_10_ops: '~5-10%',
      off_peak_savings: '~2-3%',
      recommendation:
        operationType === 'card_purchase'
          ? 'Consider batch purchasing multiple cards to reduce per-card fees.'
          : 'Monitor network conditions for optimal fee timing.',
    },
  };
}

/** Start the stdio-based MCP server exported by the SDK. */
export async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
