# Stellar Card Receiver Contract — Deployment Runbook & Verification Guide

This document is the authoritative operational runbook for deploying, initializing,
verifying, and upgrading the `stellar_card_receiver` Soroban smart contract. It is
intended for maintainers and operators deploying to Stellar testnet and mainnet.

## Table of contents

1. [Prerequisites](#prerequisites)
2. [Build & optimise the WASM](#build--optimise-the-wasm)
3. [Deploy the contract](#deploy-the-contract)
4. [Initialise the contract](#initialise-the-contract)
5. [Post-deployment verification](#post-deployment-verification)
6. [Operational procedures](#operational-procedures)
7. [Upgrade the contract](#upgrade-the-contract)
8. [Emergency procedures](#emergency-procedures)
9. [Contract interface specification](#contract-interface-specification)
10. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Toolchain

Install the Rust toolchain and the Stellar CLI:

```bash
rustup target add wasm32v1-none
cargo install --locked stellar-cli
```

Verify the install:

```bash
cargo --version
stellar --version
```

### Identity / keys

- **Deployer** — the account that pays for deployment and calls `init`. Must hold
  enough XLM on the target network to cover rent and deployment fees.
- **Admin** — the account authorised to call `init`, `upgrade`, `set_withdraw_limits`,
  `pause`/`unpause` (Operator+), and `grant_role`/`revoke_role`.
- **Treasury** — the account that receives all USDC and XLM payments.
- **Rescue destination** — used only by `rescue_tokens` to recover mistakenly sent tokens.

Store secrets in a secrets manager or a password-encrypted keystore. Never commit
secret keys to version control.

---

## Build & optimise the WASM

From `stellar_card-contract/`:

```bash
# Build the release WASM (target: wasm32v1-none)
cargo build --target wasm32v1-none --release

# Optimise (shrinks the binary, reducing deployment and invocation rent)
stellar contract optimize \
  --wasm target/wasm32v1-none/release/stellar_card_receiver.wasm \
  --wasm-out target/wasm32v1-none/release/stellar_card_receiver.optimized.wasm
```

Or use the Makefile:

```bash
make build
```

The optimised WASM (`stellar_card_receiver.optimized.wasm`) is what you upload to
the network. The raw build is checked against a size budget (`make wasm-size`) to
guard against regressions that would approach Soroban's 64 KiB contract limit.

---

## Deploy the contract

### 1. Deploy the optimised WASM

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/stellar_card_receiver.optimized.wasm \
  --source <DEPLOYER_SECRET_KEY> \
  --network testnet   # or mainnet
```

The command prints the deployed contract ID (a `C…` address). Save it:

```bash
export RECEIVER_CONTRACT_ID=<C…>
```

### 2. Record the deployment

Persist the contract ID, WASM hash, deployer, and network to your deployment ledger
so you can verify the deployed code later (see [Contract interface specification](#contract-interface-specification)).

---

## Initialise the contract

`init` must be called **exactly once** after deployment. It stores the admin,
treasury, and token contract addresses and requires the admin signature.

### Mainnet token contracts

| Asset | Contract type | Contract ID |
|-------|---------------|-------------|
| USDC  | SAC (issued)  | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` |
| XLM   | SAC (native)  | `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA` |

### Testnet token contracts

Use the testnet USDC SAC (`CBIELTK6YBZJU5UP2WWQEUCYJLPU6QXNLTEXDJ5TYWKPONBHZXDVZAC2`)
and register the native XLM SAC on the network.

### Run init

```bash
stellar contract invoke \
  --id $RECEIVER_CONTRACT_ID \
  --source <ADMIN_SECRET_KEY> \
  --network testnet \
  -- init \
  --admin <ADMIN_PUBLIC_KEY> \
  --treasury <TREASURY_PUBLIC_KEY> \
  --usdc_contract <USDC_SAC_CONTRACT_ID> \
  --xlm_contract <XLM_SAC_CONTRACT_ID>
```

- `--admin`: authorised to call `init` and any future `upgrade`.
- `--treasury`: receives all USDC and XLM payments.
- `--usdc_contract`: the USDC Stellar Asset Contract on the target network.
- `--xlm_contract`: the native XLM SAC on the target network.

Calling `init` a second time panics with `already initialized`.

---

## Post-deployment verification

Run these checks after every deployment and after every upgrade.

### 1. Confirm the contract is live

```bash
stellar contract invoke \
  --id $RECEIVER_CONTRACT_ID \
  --source <ADMIN_SECRET_KEY> \
  --network testnet \
  -- admin
```

Expect the stored admin address to match.

### 2. Verify initialised addresses

```bash
stellar contract invoke \
  --id $RECEIVER_CONTRACT_ID \
  --source <ADMIN_SECRET_KEY> \
  --network testnet \
  -- treasury
stellar contract invoke \
  --id $RECEIVER_CONTRACT_ID \
  --source <ADMIN_SECRET_KEY> \
  --network testnet \
  -- usdc_contract
stellar contract invoke \
  --id $RECEIVER_CONTRACT_ID \
  --source <ADMIN_SECRET_KEY> \
  --network testnet \
  -- xlm_contract
```

Each must return the address passed during `init`.

### 3. Verify `init` cannot be replayed

```bash
stellar contract invoke \
  --id $RECEIVER_CONTRACT_ID \
  --source <ADMIN_SECRET_KEY> \
  --network testnet \
  -- init \
  --admin <ADMIN_PUBLIC_KEY> \
  --treasury <TREASURY_PUBLIC_KEY> \
  --usdc_contract <USDC_SAC_CONTRACT_ID> \
  --xlm_contract <XLM_SAC_CONTRACT_ID>
```

This must fail with `already initialized`.

### 4. Send a test payment

Fund a payer account with USDC on testnet, then invoke `pay_usdc`:

```bash
stellar contract invoke \
  --id $RECEIVER_CONTRACT_ID \
  --source <PAYER_SECRET_KEY> \
  --network testnet \
  -- pay_usdc \
  --from <PAYER_PUBLIC_KEY> \
  --amount 10000000 \
  --order_id <ORDER_UUID_BYTES>
```

Verify:
- The treasury's USDC balance increased by the amount.
- A `pay_usdc` event was emitted with `topic[1]` = the order UUID bytes.

### 5. Run the contract test suite

```bash
cd stellar_card-contract
cargo test
cargo test --test integration
```

### 6. Verify the WASM hash matches the build

Compare the deployed contract's WASM hash against the hash of your locally optimised
binary. Use the contract interface exporter (see #683) to dump the deployed interface

---

## Operational procedures

### Set / adjust withdraw limits

`rescue_tokens` is the only path that moves tokens out of the contract, and it is
bounded by optional per-call and per-day limits set with `set_withdraw_limits`:

```bash
stellar contract invoke \
  --id $RECEIVER_CONTRACT_ID \
  --source <ADMIN_SECRET_KEY> \
  --network testnet \
  -- set_withdraw_limits \
  --admin <ADMIN_PUBLIC_KEY> \
  --per_call 10000000 \
  --per_day 50000000
```

- Values are in the token's base units (stroops for XLM, 7-decimal for USDC).
- `per_call` must not exceed `per_day`.
- Check current usage with `withdrawn_today`; the daily accumulator resets at
  `00:00 UTC` (ledger `timestamp / 86400` day boundary).

### Pause / resume (incident response)

An `Operator` (or higher) can pause payments; only the admin can resume:

```bash
# Pause
stellar contract invoke \
  --id $RECEIVER_CONTRACT_ID \
  --source <OPERATOR_SECRET_KEY> \
  --network testnet \
  -- pause

# Resume (admin only)
stellar contract invoke \
  --id $RECEIVER_CONTRACT_ID \
  --source <ADMIN_SECRET_KEY> \
  --network testnet \
  -- unpause
```

While paused, `pay_usdc`/`pay_xlm` are rejected.

### Role management (RBAC)

Roles: `Admin > Operator > Viewer`. Grant, revoke, or renounce roles:

```bash
stellar contract invoke \
  --id $RECEIVER_CONTRACT_ID \
  --source <ADMIN_SECRET_KEY> \
  --network testnet \
  -- grant_role \
  --role Admin \
  --address <ADDRESS>
```

See `docs/RBAC.md` for the full authorisation model.

---

## Upgrade the contract

The admin can swap the contract WASM in place via `upgrade`:

```bash
stellar contract invoke \
  --id $RECEIVER_CONTRACT_ID \
  --source <ADMIN_SECRET_KEY> \
  --network testnet \
  -- upgrade \
  --new_wasm_hash <WASM_HASH>
```

Procedure:
1. Build and optimise the new WASM.
2. Upload the new WASM to obtain its hash (`stellar contract upload`).
3. Call `upgrade` with the new hash, signed by the admin.
4. Re-run [Post-deployment verification](#post-deployment-verification).

For a fully immutable deployment, transfer the admin key to a burn address after
`init` (or fork the contract with `upgrade` removed).

---

## Emergency procedures

### Incident pause

If a malicious or buggy payment flow is detected, pause the contract immediately
with an Operator key. This halts all new payments while you investigate.

### Resume after incident

Once the issue is resolved, the admin calls `unpause` to restore payments.

### Recover mistakenly sent tokens

Use `rescue_tokens` (Admin only, bounded by withdraw limits) to return tokens sent
to the contract by mistake:

```bash
stellar contract invoke \
  --id $RECEIVER_CONTRACT_ID \
  --source <ADMIN_SECRET_KEY> \
  --network testnet \
  -- rescue_tokens \
  --token_contract <TOKEN_CONTRACT_ID> \
  --to <DESTINATION_ADDRESS> \
  --amount <AMOUNT>
```

Rescue to the contract itself is rejected; per-call and daily caps apply.

### Lost admin key

There is no password reset. If the admin key is lost and not transferred to a burn
address, the contract cannot be upgraded or re-initialised. Store admin credentials
in a durable, backed-up secrets manager.

---

## Contract interface specification

The contract exposes a public interface documented in the source (`Stellar_CardReceiver`)
and embedded as a WASM custom section. Use the exporter script (Issue #683) to emit
the interface as a JSON schema:

```bash
./stellar_card-contract/scripts/export_contract_interface.sh \
  --wasm target/wasm32v1-none/release/stellar_card_receiver.optimized.wasm \
  --out contract-interface.json
```

The emitted schema describes each entrypoint (`init`, `pay_usdc`, `pay_xlm`,
`rescue_tokens`, `set_withdraw_limits`, `upgrade`, `pause`, `unpause`,
`grant_role`, `revoke_role`, …), its argument types, return types, and error codes.
Clients and indexers can validate calls against this schema before submission.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `init` panics with `already initialized` | `init` already called | Do not re-run `init`; the contract is live. |
| `set_withdraw_limits` panics | `per_call` > `per_day` | Lower `per_call` or raise `per_day`. |
| `rescue_tokens` rejects with `DailyWithdrawLimitExceeded` | Daily budget exhausted | Wait for the UTC day rollover or raise the daily limit. |
| Payment rejected `Contract paused` | Contract is paused | Admin calls `unpause`. |
| Deployment exceeds 64 KiB | WASM too large | Run `stellar contract optimize` or check `make wasm-size`. |
| `withdrawn_today` unexpectedly non-zero | New UTC day not yet rolled over | The accumulator resets at `timestamp / 86400` day boundary. |

---

## Security notes

- The contract never holds payment funds from `pay_usdc`/`pay_xlm`; tokens flow
  directly from payer to treasury.
- `rescue_tokens` is the only exit path and is Admin-gated, reentrancy-guarded,
  and capped by withdraw limits.
- `upgrade` is admin-only; transfer the admin key to a burn address for immutability.
- All privileged operations require real signatures (`require_auth`) — no blanket
  `mock_all_auths` in production.

---

*End of runbook.*
and diff it against the locally built one.