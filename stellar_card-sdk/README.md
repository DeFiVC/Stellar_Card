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
