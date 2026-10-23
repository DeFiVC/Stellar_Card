# Storage Layout & Packing Benchmarks

Issue #636 packs the frequently accessed configuration (`admin`,
`treasury`, `paused`) into a single [`Config`](../src/lib.rs) struct under
one `DataKey::Config` instance-storage slot. This document records the
layout before and after, the upgrade-migration path, and how to measure
the footprint and CPU-fee delta.

## Background

Soroban **instance storage is a single ledger entry**: a `ScMap` from key
`ScVal` to value `ScVal` stored inside the contract instance. Rent and the
CPU cost of loading/serializing the entry scale with that map's total
serialized size — not with the number of logical "slots" in some other
sense. Every contract invocation deserializes the whole entry.

Two consequences:

1. Splitting state across more map entries costs extra bytes for each
   key encoding plus each value wrapper, even though it is still one
   ledger entry.
2. Anything that grows unbounded inside the instance entry taxes every
   call forever. (That is why roles, blacklist flags, and payment-rate
   counters live in persistent/temporary storage — see the crate-level
   storage table.)

## Layout before Issue #636

| Map key | Value | When present |
|---------|-------|--------------|
| `Admin` | `Address` | always, after `init` |
| `Treasury` | `Address` | always, after `init` |
| `Paused` | `bool` | only while paused (absent = unpaused) |
| `UsdcContract` | `Address` | always, after `init` |
| `XlmContract` | `Address` | always, after `init` |
| … | … | limits, `DailyWithdrawn`, … |

## Layout after Issue #636

| Map key | Value | When present |
|---------|-------|--------------|
| `Config` | `Config { admin, treasury, paused }` | always, after `init` |
| `UsdcContract` | `Address` | always, after `init` |
| `XlmContract` | `Address` | always, after `init` |
| … | … | unchanged |

`paused` is now an explicit `bool` field rather than an opt-in key. The
"absent means unpaused" byte-saving trick is given up deliberately: one
`bool` inside the packed struct is cheaper overall than a separate map
entry that has to appear and disappear across pause/unpause.

Token contracts are **not** packed into `Config`: they change through
independent update entrypoints (`update_usdc_contract`,
`update_xlm_contract`) and keeping them out avoids rewriting the packed
block when a token is rotated.

## Footprint comparison

Structural estimate of the instance-entry delta (XDR `ScMap` encoding):

| | Legacy (3 entries) | Packed (1 entry) |
|--|--------------------|------------------|
| Map entries for the config block | 3 | 1 |
| Key encodings (`Admin`/`Treasury`/`Paused` vs `Config`) | 3 | 1 |
| Value encodings | 2 × `Address` + 1 × `bool` | 1 × struct wrapping 2 × `Address` + 1 × `bool` |
| Pause/unpause rewrites the whole block | yes (add/remove key) | yes (field flip) |
| Unpaused steady state | 2 entries | 1 entry |

The win is the removal of two map entries' key + wrapper overhead. The
value payload itself is unchanged (two addresses and a bool either way),
so this is a constant-size saving on every load of the instance entry —
i.e. on every invocation.

> **Measured numbers.** The table above is a structural accounting, not a
> ledger-footprint measurement. To record real byte and fee figures,
> follow the recipe below and paste the results here.

## Measurement recipe

```bash
# 1. Build both versions of the WASM
git stash            # or check out the pre-#636 commit
stellar contract build --wasm-opt-for size
cp target/wasm32v1-none/release/stellar_card.wasm /tmp/before.wasm
git stash pop

stellar contract build --wasm-opt-for size
cp target/wasm32v1-none/release/stellar_card.wasm /tmp/after.wasm

# 2. Deploy both to a local network / testnet and call init on each

# 3. Compare the instance entry size and CPU budget
stellar contract invoke --id <BEFORE_ID> -- \
  ...   # any read; then inspect the ledger entry via RPC
stellar contract invoke --id <AFTER_ID> -- ...

# 4. Or let the unit-test budget printer report the delta
cargo test test_init_packs_config_into_single_slot -- --nocapture
```

Suggested metrics to record:

| Metric | Before | After |
|--------|--------|-------|
| WASM size (bytes) | | |
| `ContractData` instance entry size (bytes) | | |
| CPU instructions for `admin()` | | |
| CPU instructions for `is_paused_view()` | | |
| CPU instructions for `pause()` | | |
| CPU instructions for `pay_usdc()` (loads config) | | |

## Upgrade migration

Live instances deployed before this change still hold the legacy
per-key layout. Migration is **lazy and automatic**:

1. `load_config` returns the packed `DataKey::Config` value when present.
2. If it is absent, it assembles a `Config` from the legacy `Admin` /
   `Treasury` / `Paused` keys (`Paused` absent ⇒ `paused = false`).
   This path is read-only — no extra write on a pure query.
3. The first mutating call (`init` on a fresh deploy, or `pause` /
   `unpause` / `transfer_admin` / `update_treasury` on an upgraded
   instance) goes through `save_config`, which writes `DataKey::Config`
   **and removes** the three legacy keys.

After that first write the instance entry has shed the legacy overhead.
There is no separate migration entrypoint and no admin action required;
upgrading the WASM is sufficient.

Rollback note: reverting to a pre-#636 WASM after the first write would
find neither `Admin` nor `Treasury` keys and would panic on `init`
checks. Take a state snapshot before upgrading, or revert the upgrade
via the contract's own `upgrade` entrypoint *before* any mutating call
touches the new layout.

## Integrity tests

Unit tests in [`src/lib.rs`](../src/lib.rs) covering this change:

| Test | Asserts |
|------|---------|
| `test_init_packs_config_into_single_slot` | `Config` present; legacy keys absent; values match |
| `test_pause_and_unpause_write_packed_config` | pause/unpause flip `Config.paused` only |
| `test_config_reads_legacy_layout_until_first_write` | fallback reads work; first write migrates |
| `test_update_treasury_and_transfer_admin_write_packed_config` | admin/treasury mutations update the packed block |
