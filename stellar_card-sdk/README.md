# stellar_card

Virtual Visa cards for AI agents — pay with USDC or XLM on Stellar, get a card number, CVV, and expiry in ~60 seconds.

[stellar_card.com](https://stellar_card.com) issues prepaid Visa virtual cards on demand. This SDK lets AI agents create an order, pay the stellar_card Soroban receiver contract on Stellar, and receive card details programmatically — all in one call.

## Contents

- [Install](#install)
- [Quickstart: Node.js](#quickstart-nodejs)
- [Quickstart: React / Next.js](#quickstart-react--nextjs)
- [Quickstart: CLI](#quickstart-cli)
- [Funding your wallet](#funding-your-wallet)
- [Step-by-step API (for more control)](#step-by-step-api-for-more-control)
- [Constructor options](#constructor-options)
- [API reference](#api-reference)
- [Code recipes](#code-recipes)
- [Pagination helpers](#pagination-helpers)
- [Custom RPC endpoints](#custom-rpc-endpoints)
- [Retry tuning](#retry-tuning)
- [MCP server](#mcp-server--for-claude-desktop-cursor-and-other-mcp-clients)
- [Error handling](#error-handling)
- [Troubleshooting](#troubleshooting)
- [Bundle size](#bundle-size)
- [Keeping card details safe](#keeping-card-details-safe)

## Install

```bash
npm install stellar_card
```

Requires Node.js 18 or newer (the SDK uses native `fetch`, `ReadableStream`, and `WebCrypto`). Supported platforms via the bundled `@ctx.com/stellar-ows-core` native wallet bindings: macOS (arm64 + x64), Linux (arm64 + x64). Windows is not currently supported.

### A note on `npm audit`

You'll see 3 critical advisories on `axios <= 1.14.0` after installing. They come from `@stellar/stellar-sdk`, which hard-pins an older axios version that we can't override from inside this package. The SDK's own HTTP calls only talk to hardcoded Stellar RPC / Horizon endpoints, so neither advisory (NO_PROXY SSRF, header-injection metadata exfil) is reachable through stellar_card code — it's noise for our use, but noise you should still silence at your own project root.

Fix in your own `package.json`:

```json
{
  "overrides": {
    "axios": "^1.15.0"
  }
}
```

then `rm -rf node_modules package-lock.json && npm install`. `npm audit` returns clean. Upstream fix tracked at [stellar/js-stellar-sdk#1381](https://github.com/stellar/js-stellar-sdk/pull/1381); this note will be removed as soon as it merges and a new stellar-sdk ships.

## Quickstart: Node.js

```typescript
import { createOWSWallet, getOWSBalance, purchaseCardOWS } from 'stellar_card';

// 1. Create (or fetch existing) encrypted wallet. Idempotent.
const { publicKey } = createOWSWallet('my-agent');
console.log('Fund this Stellar address:', publicKey);

// 2. Pause here until the address has funds. Re-run to check:
const bal = await getOWSBalance('my-agent');
console.log(`XLM: ${bal.xlm}  USDC: ${bal.usdc}`);

// 3. Purchase a card — only do this when the user explicitly asks.
const card = await purchaseCardOWS({
  apiKey: process.env.CARDS402_API_KEY!,
  walletName: 'my-agent',
  amountUsdc: '10.00',
  paymentAsset: 'xlm', // or 'usdc' (trustline added automatically)
});

console.log(card.number, card.cvv, card.expiry);
```

`purchaseCardOWS` handles the whole flow:

1. `POST /v1/orders` with the amount
2. Sign + submit the Soroban payment from your OWS wallet
3. Subscribe to the SSE stream at `/v1/orders/:id/stream`
4. Return the card details as soon as the `ready` event arrives

No polling loops, no webhook endpoint required. `createOWSWallet`, `getOWSBalance`, and
`purchaseCardOWS` use Node's `fs`/native bindings for the encrypted wallet vault, so this
quickstart is Node-only — browser/React apps use `stellar_card/react` (below) and bring
their own wallet signer (a browser extension, WalletConnect, etc.).

## Quickstart: React / Next.js

```bash
npm install stellar_card react
```

`stellar_card/react` is a separate subpath export so apps that don't use React never pull
`react` into their bundle (it's an optional peer dependency — see [Bundle size](#bundle-size)).

```tsx
// app/providers.tsx — wrap your app once, near the root.
'use client';
import { StellarCardProvider } from 'stellar_card/react';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <StellarCardProvider apiKey={process.env.NEXT_PUBLIC_STELLAR_CARD_KEY!}>
      {children}
    </StellarCardProvider>
  );
}
```

```tsx
// components/OrderStatus.tsx — track one order and pay it.
'use client';
import { useCardOrder } from 'stellar_card/react';

export function OrderStatus({ orderId }: { orderId: string }) {
  const { order, loading, error, pay } = useCardOrder(orderId);

  if (loading) return <p>Loading…</p>;
  if (error) return <p>Error: {error.message}</p>;
  if (!order) return null;

  return (
    <div>
      <p>Status: {order.status}</p>
      {order.payment && (
        <button
          onClick={() =>
            pay(async (payment) => {
              // Submit payment.xlm / payment.usdc via your own wallet
              // signer (browser extension, WalletConnect, server relay,
              // etc.) and return the submitted transaction hash.
              return submitWithConnectedWallet(payment);
            })
          }
        >
          Pay {order.payment.usdc.amount} USDC
        </button>
      )}
    </div>
  );
}
```

```tsx
// components/WalletBalance.tsx — show the connected wallet's balances.
'use client';
import { useWallet } from 'stellar_card/react';

export function WalletBalance() {
  const { publicKey, balances, connect, disconnect } = useWallet();

  if (!publicKey) {
    return <button onClick={() => connect(myWalletPublicKey)}>Connect wallet</button>;
  }
  return (
    <div>
      <p>{publicKey}</p>
      <p>
        {balances?.xlm ?? '0'} XLM · {balances?.usdc ?? '0'} USDC
      </p>
      <button onClick={disconnect}>Disconnect</button>
    </div>
  );
}
```

All three hooks (`useStellarCard`, `useCardOrder`, `useWallet`) are SSR-safe: they never
read `window` or `localStorage` during the initial render, only inside `useEffect` after
mount, so Next.js/Remix server-rendered markup always matches the first client render —
no hydration mismatch warnings.

## Quickstart: CLI

```bash
npm install -g stellar_card
stellar_card onboard --claim <code-from-dashboard>   # one-time setup
stellar_card purchase --amount 10.00                 # buy a card
stellar_card status                                  # list recent orders
stellar_card logs --limit 20                         # recent audit events
stellar_card logs --tail                             # follow new events live
```

`stellar_card --help` lists every subcommand. All commands read
`~/.stellar_card/config.json` (written by `onboard`/`setup-wizard`) so you don't need to
pass an API key on every invocation — override with `STELLAR_CARD_API_KEY` /
`CARDS402_API_KEY` env vars when running in CI.

## Funding your wallet

Stellar accounts need a minimum balance to be activated on-chain:

- **Pay with XLM:** send ≥ 1 XLM to cover the base reserve, plus whatever XLM the card costs at the current spot rate (shown in `payment.xlm.amount` when you create an order).
- **Pay with USDC:** send ≥ 2 XLM (1 base reserve + 1 for the USDC trustline entry), plus the USDC card amount. The SDK will add the trustline automatically the first time you purchase with USDC, so you just need the ≥ 2 XLM on-chain before calling `purchaseCardOWS`.

## Step-by-step API (for more control)

```typescript
import { Stellar_CardClient } from 'stellar_card';

const client = new Stellar_CardClient({
  apiKey: process.env.CARDS402_API_KEY!,
  // baseUrl defaults to https://api.stellar_card.com/v1
});

// Create the order
const order = await client.createOrder({ amount_usdc: '10.00' });
console.log(`Pay ${order.payment.xlm.amount} XLM to contract ${order.payment.contract_id}`);

// ... submit the Soroban transaction yourself, or use the payViaContract helpers ...

// Wait for delivery (uses SSE under the hood, with polling fallback)
const card = await client.waitForCard(order.order_id, { timeoutMs: 120000 });
console.log(card.number, card.cvv, card.expiry);
```

## Constructor options

```typescript
new Stellar_CardClient({
  apiKey, // string — required unless CARDS402_API_KEY env var or
  // ~/.stellar_card/config.json resolves one.
  baseUrl, // string — defaults to https://api.stellar_card.com/v1
  network, // 'mainnet' | 'testnet' | 'futurenet' — defaults to 'mainnet'
  timeout, // number (ms) — per-request timeout, defaults to 30000
  retry: {
    // RetryOptions — see "Retry tuning" below
    attempts,
    baseDelayMs,
    maxDelayMs,
    jitter,
    onRetry,
  },
  headers, // Record<string, string> — extra headers on every request
  logger, // Logger — plug in Pino/Winston/console; defaults to SilentLogger
  logLevel, // 'debug' | 'info' | 'warn' | 'error' | 'silent'
  disableVersionCheck, // boolean — skip the npm-registry version check on startup
});
```

Credential resolution order: explicit constructor args → `CARDS402_API_KEY` /
`CARDS402_BASE_URL` env vars → `~/.stellar_card/config.json` (written by `stellar_card
onboard`). An `http://` (non-HTTPS) `baseUrl` is rejected unless
`CARDS402_ALLOW_INSECURE_BASE_URL=1` is set, which is only intended for local
integration tests.

## API reference

| Method                                    | Returns                         | Notes                                                                                               |
| ----------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `createOrder(opts)`                       | `Promise<OrderResponse>`        | Creates an order; `opts.amount_usdc` required.                                                      |
| `getOrder(orderId)`                       | `Promise<OrderStatus>`          | Current status + payment instructions + card once delivered.                                        |
| `listOrders(opts?)`                       | `Promise<OrderListItem[]>`      | One page; `status`/`limit`/`offset`/`since_created_at`/`since_updated_at` filters.                  |
| `listOrdersPage(opts?)`                   | `Promise<ListOrdersPage>`       | Adds `hasMore`/`nextOffset` continuation metadata.                                                  |
| `iterateOrders(opts?)`                    | `AsyncGenerator<OrderListItem>` | Walks every page; supports `maxItems`.                                                              |
| `waitForCard(orderId, opts?)`             | `Promise<CardDetails>`          | SSE with polling fallback; throws `WaitTimeoutError`.                                               |
| `waitForOrderFulfillment(orderId, opts?)` | `Promise<OrderStatus>`          | Like `waitForCard` but resolves on any terminal status, not just delivery.                          |
| `getUsage()`                              | `Promise<UsageSummary>`         | Spend/budget summary for the API key.                                                               |
| `getAuditLogs(opts?)`                     | `Promise<AuditLogEntry[]>`      | Recent audit events (API calls, authorizations, webhooks); `action`/`limit`/`since` filters (#731). |
| `getAccountBalances(publicKey)`           | `Promise<AccountBalances>`      | XLM/USDC/every trustline for a Stellar G-address, via Horizon. 3s cache.                            |
| `estimateXlmRequired(usdcAmount, opts?)`  | `Promise<XlmEstimateResult>`    | Quotes XLM needed for a USDC-denominated order via the DEX orderbook.                               |
| `reportStatus(state, opts?)`              | `Promise<void>`                 | Best-effort onboarding telemetry; swallows its own errors.                                          |

Event-style flows (SSE under the hood, no explicit `EventEmitter`):

- `waitForCard({ timeoutMs, pollIntervalMs })` resolves with `CardDetails` as soon as the
  order is delivered, or throws `WaitTimeoutError`.
- `waitForOrderFulfillment({ timeoutMs, intervalMs, onProgress })` resolves on _any_
  terminal status (delivered, failed, refunded, rejected, expired), and calls
  `onProgress(status)` on every observed state transition while it polls.
- The CLI's `stellar_card logs --tail` and the React `useCardOrder`/`useWallet` hooks poll
  on an interval rather than subscribing to a push stream — see their respective sections
  above for the exact polling contract.

## Code recipes

**Order a card paying with USDC:**

```typescript
import { Stellar_CardClient, addUsdcTrustline, payViaContract } from 'stellar_card';

const client = new Stellar_CardClient({ apiKey: process.env.CARDS402_API_KEY! });

const order = await client.createOrder({ amount_usdc: '10.00' });

// First-time USDC payers need the trustline open (no-op if it already is).
await addUsdcTrustline(process.env.STELLAR_SECRET_KEY!);

const { hash } = await payViaContract({
  walletSecret: process.env.STELLAR_SECRET_KEY!,
  payment: order.payment, // the whole PaymentInstructions object from createOrder
  paymentAsset: 'usdc',
});

const card = await client.waitForCard(order.order_id, { timeoutMs: 120_000 });
console.log(card.number, card.cvv, card.expiry, 'paid in', hash);
```

**Order a card paying with XLM:**

```typescript
import { Stellar_CardClient, payViaContract } from 'stellar_card';

const client = new Stellar_CardClient({ apiKey: process.env.CARDS402_API_KEY! });
const order = await client.createOrder({ amount_usdc: '10.00' });

// order.payment.xlm.amount is already the quoted XLM amount for this order —
// use estimateXlmRequired() separately only if you need to show a quote to a
// user *before* calling createOrder.
const { hash } = await payViaContract({
  walletSecret: process.env.STELLAR_SECRET_KEY!,
  payment: order.payment,
  paymentAsset: 'xlm',
});

const card = await client.waitForCard(order.order_id, { timeoutMs: 120_000 });
console.log(card.number, card.cvv, card.expiry, 'paid in', hash);
```

## Pagination helpers

```typescript
const firstPage = await client.listOrdersPage({ status: 'delivered', limit: 25 });
console.log(firstPage.items.length, firstPage.hasMore, firstPage.nextOffset);

for await (const order of client.iterateOrders({ status: 'delivered', limit: 50, maxItems: 200 })) {
  console.log(order.id, order.status);
}
```

`listOrdersPage` adds continuation metadata on top of the API's bare array response, and `iterateOrders` streams through pages one batch at a time so you do not have to manage offsets manually.

For paginating any other cursor-based source, the generic helpers `paginate`, `iteratePages`, `collectAllPages`, and `mapPaginated` work with any async page-fetching function:

```typescript
import { collectAllPages, mapPaginated } from 'stellar_card';

// Gather everything into one array (with an optional hard cap).
const all = await collectAllPages({
  fetchPage: (cur) => api.list({ limit: cur.limit, offset: cur.offset }),
  limit: 100,
  maxItems: 1000,
});

// Or stream a transform across every item, page by page.
for await (const id of mapPaginated({ fetchPage, limit: 50, transform: (o) => o.id })) {
  console.log(id);
}
```

## Custom RPC endpoints

Point the SDK at private validators, Futurenet, or a custom deployment via `resolveNetworkConfig`, or load the configuration straight from environment variables with `resolveNetworkConfigFromEnv`:

```typescript
import { resolveNetworkConfigFromEnv } from 'stellar_card';

// Reads STELLAR_SOROBAN_RPC_URL, STELLAR_HORIZON_URL, STELLAR_RPC_API_KEY,
// STELLAR_RPC_TIMEOUT, STELLAR_NETWORK_PASSPHRASE — falling back to the public
// defaults for anything unset. Explicit overrides win over the environment.
const net = resolveNetworkConfigFromEnv({ networkName: 'My Validator' });
console.log(net.sorobanRpc.url, net.horizon.url);
```

## Idempotency

Every call to `createOrder` automatically attaches an `Idempotency-Key` header to the outgoing HTTP request.  This guarantees that if the network drops a response or the SDK retries a `503`, the backend will deduplicate the request and return the **same order** rather than charging twice.

### Automatic key generation

When you call `createOrder` without supplying a key, the SDK generates a UUID v4 for you:

```typescript
const order = await client.createOrder({ amount_usdc: '10.00' });
// Idempotency-Key: 3f6c8a27-bc14-4ef2-8b00-3d2f9a1e0a77 (auto-generated)
```

The auto-generated key is stable across all retry attempts within that single `createOrder` call, so a transient `503` retry is safe by default.

### Caller-supplied key

Pass your own `idempotencyKey` when you want to control deduplication yourself — for example, to make re-runs of a script idempotent even across process restarts:

```typescript
const order = await client.createOrder({
  amount_usdc: '10.00',
  idempotencyKey: 'my-workflow-order-2026-01-15',
});
```

If you call `createOrder` again with the same key (in the same process or a fresh one), the backend returns the existing order instead of creating a new charge.

### Key format

- Auto-generated keys are [UUID v4](https://www.rfc-editor.org/rfc/rfc4122) strings.
- Caller-supplied keys can be any non-empty string that uniquely identifies the intent.
- The key is sent as the `Idempotency-Key` HTTP request header.
- The key is **not** included in the request body.

### Retry tuning
## Claimable balances (escrow with timelocks)

Escrow XLM or an asset on-chain for a claimant, optionally restricted by a before/after timestamp predicate, using `createClaimableBalance` / `claimBalance` from `stellar_card/stellar`:

```typescript
import { createClaimableBalance, claimBalance, getClaimableBalances } from 'stellar_card';

// Escrow 10 XLM, claimable only on/after 2027-01-01.
const txHash = await createClaimableBalance({
  sourceSecret: process.env.STELLAR_SECRET!,
  amount: '10.0000000',
  claimants: [
    {
      destination: 'GCLAIMANT...',
      predicate: { afterAbsoluteTime: '2027-01-01T00:00:00Z' },
    },
  ],
});

// The claimant finds and claims their balance once the predicate is satisfied.
const balances = await getClaimableBalances('GCLAIMANT...');
await claimBalance(balances[0].id, process.env.CLAIMANT_SECRET!);
```

`predicate` supports `beforeAbsoluteTime`, `afterAbsoluteTime`, both combined, or `unconditional` (the default when omitted).

## Transaction memos

`buildTransactionMemo` constructs a type-safe Stellar `Memo` for the `text`, `id`, `hash`, and `return` variants, validating constraints up front (e.g. `text` is checked against its real UTF-8 **byte** length, not character count) and throwing `InvalidMemoError` on violation:

```typescript
import { buildTransactionMemo } from 'stellar_card';

const memo = buildTransactionMemo('text', 'order-4821'); // max 28 UTF-8 bytes
const idMemo = buildTransactionMemo('id', 42);
const hashMemo = buildTransactionMemo('hash', Buffer.alloc(32)); // or a 64-char hex string

const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
  .addMemo(memo)
  .addOperation(/* ... */)
  .setTimeout(300)
  .build();
```

## Hardware wallet signing (Ledger)

`stellar_card/hardware` provides a `LedgerStellarSigner` abstraction for signing with a Ledger device over WebUSB, using the Stellar BIP-44 path `m/44'/148'/0'`. It's built against the documented API shape of `@ledgerhq/hw-transport-webusb` + `@ledgerhq/hw-app-str` without requiring either as a dependency — pass in real instances of those clients, or any object matching the same shape:

```typescript
import TransportWebUSB from '@ledgerhq/hw-transport-webusb';
import Str from '@ledgerhq/hw-app-str';
import { createLedgerStellarSigner, createWebUsbTransport } from 'stellar_card/hardware';

const transport = await createWebUsbTransport(() => TransportWebUSB.create());
const signer = createLedgerStellarSigner({ transport, app: new Str(transport) });

const address = await signer.getPublicKey({ display: true }); // shows + confirms on-device
const signedTx = await signer.signTransaction(unsignedTx); // user reviews treasury/amount/asset on-device
await signer.disconnect();
```

Connection failures, user rejection, a locked device, and timeouts each surface as a distinct `LedgerSignerError` with a typed `reason` (`'device_not_connected' | 'device_locked' | 'wrong_app' | 'user_rejected' | 'timeout' | 'transport_error' | 'unsupported_environment'`) so you can branch on the failure mode instead of parsing error strings.

> **Testing disclosure:** this signer is unit-tested only against a mocked Ledger transport/app (see `src/__tests__/hardware-signer.test.ts`). It has not been exercised against real Ledger hardware in this environment.

## Retry tuning

```typescript
const client = new Stellar_CardClient({
  apiKey: process.env.CARDS402_API_KEY!,
  retry: {
    attempts: 4,
    baseDelayMs: 250,
    maxDelayMs: 4000,
    jitter: 'full',
    onRetry: (error, attempt, delayMs) => {
      console.warn(`Retry ${attempt + 1} in ${delayMs}ms`, error);
    },
  },
});
```

The SDK uses exponential backoff with full jitter for transient API failures and honors `Retry-After` headers when the backend asks clients to slow down. Set `jitter: 'none'` for deterministic delays in tests; `onRetry` is called immediately before each retry delay.

## MCP server — for Claude Desktop, Cursor, and other MCP clients

Add to your client's `mcpServers` config:

```json
{
  "mcpServers": {
    "stellar_card": {
      "command": "npx",
      "args": ["-y", "stellar_card"],
      "env": { "CARDS402_API_KEY": "stellar_card_<your key>" }
    }
  }
}
```

The MCP server exposes four tools: `setup_wallet`, `check_budget`, `check_order`, and `purchase_vcc`.

## Error handling

All SDK errors inherit from `Stellar_CardError`. Typed subclasses let you react to specific failure modes:

```typescript
import {
  Stellar_CardError,
  AuthError,
  SpendLimitError,
  RateLimitError,
  ServiceUnavailableError,
  InvalidAmountError,
  OrderFailedError,
  WaitTimeoutError,
} from 'stellar_card';

try {
  const card = await purchaseCardOWS({ ... });
} catch (err) {
  if (err instanceof SpendLimitError) { /* cap reached — ask owner to raise */ }
  else if (err instanceof OrderFailedError) { /* check err.refund for refund tx */ }
  else if (err instanceof WaitTimeoutError) { /* network flake or stalled fulfillment */ }
  else if (err instanceof AuthError) { /* bad key */ }
}
```

## Troubleshooting

**`TimeoutError: ... did not finalize within ...` (Horizon timeout)**
The Soroban transaction submitted but Horizon didn't confirm it within the configured
window — usually network congestion, not a failed payment. Re-check with
`client.getOrder(orderId)`; the backend tracks the transaction independently of your
process. Raise `timeoutMs` on `waitForCard`/`waitForOrderFulfillment` if this is routine
on your network, and prefer `resolveNetworkConfig`/`resolveNetworkConfigFromEnv` to point
at a lower-latency RPC/Horizon provider.

**`SorobanRpcError` / "invalid XDR"**
Usually means the payment amount, asset code, or contract ID used to build the
transaction doesn't match what the order actually expects — always build the payment
from the live `order.payment` object (it's authoritative and order-specific), never from
a previous order or a hardcoded contract ID.

**Wrong network (mainnet vs. testnet)**
`new Stellar_CardClient({ network: 'testnet' })` only affects which Horizon/Soroban RPC
the _balance and payment helpers_ talk to — it does not change `baseUrl`. If you're
testing against a staging API, set `baseUrl` explicitly too. `detectNetworkFromPassphrase`
and `resolveNetworkConfigFromEnv` help keep the two in sync from one source of truth (an
env var) instead of hardcoding both.

**`AuthError` immediately on construction**
No API key was resolved from any of the three sources (constructor arg, env var,
`~/.stellar_card/config.json`). Run `stellar_card onboard` once, or pass `apiKey`
explicitly.

**`npm audit` flags `axios`**
See [the note under Install](#install) — it's a transitive pin inside
`@stellar/stellar-sdk` that isn't reachable through this SDK's code paths.

## Bundle size

`dist/browser.js` (the entry used by `stellar_card/browser` and by bundlers resolving the
package's `browser` field) is itself tiny — it only re-exports pure/browser-safe modules
and contains **no bundled dependencies**: Node built-ins (`fs`, `path`, `os`, `crypto`,
`child_process`, `worker_threads`) and Node-only modules (CLI, config loading, OWS wallet)
are stubbed to `false` via `package.json`'s `browser` field, and `npm run check:browser`
(`scripts/check-browser-deps.mjs`) asserts this on every PR.

The dependencies that matter for a consumer's _actual_ bundle size — `@stellar/stellar-sdk`
and `zod` — are regular `dependencies`, not bundled into `dist/browser.js`; your own
bundler (webpack/esbuild/Vite/Next.js) resolves and tree-shakes them from `node_modules`
the same way it would for any other npm package you import directly. `size-limit`
(`npm run size`, wired into CI) measures `dist/browser.js` bundled as a consumer's
bundler would, with those two externalized the same way a real app would de-dupe them if
it already depends on `@stellar/stellar-sdk` itself:

| Entry                                                              | Gzipped size | Budget |
| ------------------------------------------------------------------ | ------------ | ------ |
| `dist/browser.js` (`stellar_card/browser`)                         | **~20.2 KB** | 50 KB  |
| `dist/integrations/react.js` (`stellar_card/react`, excl. `react`) | **~17.2 KB** | 20 KB  |

For reference, bundling `dist/browser.js` _without_ externalizing `@stellar/stellar-sdk`
and `zod` measures ~313 KB gzipped — almost entirely `@stellar/stellar-sdk`'s own
pre-minified bundle (~1 MB raw) plus `zod`'s schema runtime (~165 KB raw). If your app
doesn't already depend on `@stellar/stellar-sdk` for other Stellar interactions, expect
that cost to land in your bundle once — it's unavoidable for a client that submits
Soroban transactions and parses Horizon responses, and is not duplicated if you already
import it yourself (your bundler de-dupes the same resolved module).

`react` is an optional peer dependency (see `peerDependencies`/`peerDependenciesMeta` in
`package.json`): importing from `stellar_card` or `stellar_card/browser` never pulls React
in; only `stellar_card/react` does, and only for apps that import it.

## Keeping card details safe

`purchaseCardOWS` returns the card PAN, CVV, and expiry as plain strings. **Treat them as secrets.** Don't log them, don't write them to disk, don't send them to observability pipelines unless those pipelines are explicitly PCI-compliant.

## Links

- [stellar_card.com](https://stellar_card.com) — dashboard and docs
- [stellar_card.com/docs](https://stellar_card.com/docs) — full API reference
- [stellar_card.com/skill.md](https://stellar_card.com/skill.md) — drop-in agent onboarding brief
- [stellar_card.com/llms.txt](https://stellar_card.com/llms.txt) — LLM-index of every docs surface
- [github.com/CTX-com/Stellar_Card](https://github.com/CTX-com/Stellar_Card) — source

## License

MIT — see [LICENSE](./LICENSE).
