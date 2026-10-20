# stellar_card

Virtual Visa cards for AI agents — pay with USDC or XLM on Stellar, get a card number, CVV, and expiry in ~60 seconds.

[stellar_card.com](https://stellar_card.com) issues prepaid Visa virtual cards on demand. This SDK lets AI agents create an order, pay the stellar_card Soroban receiver contract on Stellar, and receive card details programmatically — all in one call.

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

## Quick start

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

No polling loops, no webhook endpoint required.

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
