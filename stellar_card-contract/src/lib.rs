//! # stellar_card Card Receiver Contract
//!
//! A Soroban smart contract that receives USDC and native XLM payments on behalf
//! of the stellar_card card platform and forwards them to a configured treasury
//! address.
//!
//! ## Overview
//! Payers authorize a transfer of USDC or XLM to the contract, which routes the
//! funds to the treasury and emits a payment event tagged with an order identifier
//! so off-chain systems can reconcile card top-ups.
//!
//! ## Security features
//! * **Reentrancy guard** — a storage-backed guard (`_enter` / `_exit`, wrapped
//!   by `with_reentrancy_guard`) surrounds every external token call —
//!   `pay_usdc`, `pay_xlm` and `rescue_tokens` — so a token contract calling
//!   back into any of them is blocked.
//! * **Pause mechanism** — an `Operator` (or higher) can pause the contract to
//!   halt all payments during an incident; only the admin can resume them.
//! * **Role-based access control (RBAC)** — a hierarchical role model
//!   (`Admin > Operator > Viewer`) gates privileged operations. Roles are
//!   granted/revoked by the admin (`grant_role`/`grant_roles`/`revoke_role`)
//!   or given up voluntarily by their holder (`renounce_role`). See
//!   [Authorization model](#authorization-model) for which entrypoint needs
//!   which role.
//! * **Upgradeability** — the admin can swap the contract WASM in place.
//! * **Custody-free payments** — `pay_usdc`/`pay_xlm` forward funds directly
//!   from the payer to `DataKey::Treasury` in the same call; the contract never
//!   holds a balance from a payment. The only way funds leave the contract's
//!   own address is `rescue_tokens`, which recovers tokens sent to it by
//!   mistake and is capped by the optional per-call / per-day limits set with
//!   `set_withdraw_limits`.
//! * **No custody of payments** — `pay_usdc`/`pay_xlm` forward funds
//!   directly from payer to `DataKey::Treasury` in the same call, so the
//!   contract never holds payment funds itself.
//! * **Administrative withdraw limits (issues #401, #391)** — the only way
//!   to move tokens out of the contract is `rescue_tokens`, which recovers
//!   tokens sent to the contract by mistake. It is Admin-gated and bounded
//!   by optional per-call and per-day limits (`set_withdraw_limits`), whose
//!   progress is visible through `withdrawn_today`. Limits must be positive
//!   and the per-call limit can't exceed the daily one; rescuing to the
//!   contract itself is rejected so it can't burn the day's budget; and the
//!   daily total lives in a single storage slot, keeping the instance
//!   entry's size constant however many days see a rescue.
//!
//! ## Events
//! Every entrypoint that changes contract state emits exactly one event per
//! change (Issue #398 - Part 2), and calls that turn out to be no-ops (pausing
//! an already-paused contract, renouncing a role that isn't held, re-granting
//! the role an address already has) emit nothing, so an indexer can treat
//! each event as a real state transition. The first topic is always the
//! event name:
//!
//! | Event                    | Topics                                        | Data                                      |
//! |--------------------------|-----------------------------------------------|-------------------------------------------|
//! | `init`                   | `admin`                                       | `(treasury, usdc_contract, xlm_contract)` |
//! | `pay_usdc`               | `order_id`, `from`                            | `amount`                                  |
//! | `pay_xlm`                | `order_id`, `from`                            | `amount`                                  |
//! | `paused`                 | `caller`                                      | `true`                                    |
//! | `unpaused`               | `admin`                                       | `false`                                   |
//! | `upgraded`               | `admin`                                       | `new_wasm_hash`                           |
//! | `tokens_rescued`         | `token_contract`, `to`                        | `(caller, amount)`                        |
//! | `withdraw_limits_set`    | `caller`                                      | `(per_call, per_day)`                     |
//! | `treasury_updated`       | `old_treasury`, `new_treasury`                | `admin`                                   |
//! | `token_contract_updated` | `asset_symbol`, `old_contract`, `new_contract`| `admin`                                   |
//! | `admin_transferred`      | `old_admin`, `new_admin`                      | `()`                                      |
//! | `role_granted`           | `address`, `role`                             | `role`                                    |
//! | `role_revoked`           | `address`, `role`                             | `()`                                      |
//! | `role_renounced`         | `caller`, `role`                              | `()`                                      |
//!
//! `transfer_admin` also moves the `Admin` role, so it is preceded by a
//! `role_revoked` for the old admin (when it held `Admin`) and a
//! `role_granted` for the new one (when its role changed).
//!
//! ## Authorization model
//! `init` and every state-mutating administrative entrypoint require the caller
//! to authorize via Soroban's `require_auth`. Payment entrypoints require the
//! paying address to authorize the transfer.
//!
//! The contract has two layers of authority (Issue #394 - Part 2):
//! * **The stored admin** (`DataKey::Admin`) — the single address set by
//!   `init` and moved by `transfer_admin`. It is always treated as holding
//!   `Role::Admin`, even if its role entry was renounced or revoked, so the
//!   contract can never be locked out of its own administration.
//! * **Roles** (`DataKey::UserRole`) — per-address grants checked
//!   hierarchically, so a higher role satisfies any lower requirement.
//!
//! | Entrypoint                                   | Required authority        |
//! |----------------------------------------------|---------------------------|
//! | `pay_usdc`, `pay_xlm`                        | the payer (`from`)        |
//! | `pause`                                      | `Operator` or higher      |
//! | `rescue_tokens`, `set_withdraw_limits`       | `Admin` role              |
//! | `unpause`, `upgrade`, `grant_role(s)`, `revoke_role` | the stored admin  |
//! | `transfer_admin`                             | stored admin + new admin  |
//! | `renounce_role`                              | the role holder itself    |
//!
//! ## Storage layout (Issue #395 - Part 2, Issue #636)
//! Every call loads the whole instance-storage entry, so it is kept small and
//! bounded — nothing in it grows with usage:
//!
//! | Key                    | Storage    | Present when                                  |
//! |------------------------|------------|-----------------------------------------------|
//! | `Config`               | instance   | always, after `init` — packs admin, treasury, paused (Issue #636) |
//! | `UsdcContract`, `XlmContract` | instance | always, after `init`                  |
//! | `WithdrawLimitPerCall` | instance   | only while a per-call limit is set             |
//! | `WithdrawLimitPerDay`  | instance   | only while a daily limit is set                |
//! | `DailyWithdrawn`       | instance   | after the first `rescue_tokens`; one slot, reused every day |
//! | `PaymentRateLimitConfig`| instance   | only when the admin overrides the default payment rate |
//! | `UserRole(address)`    | persistent | while `address` holds a role                   |
//! | `Blacklist(address)`   | persistent | only while `address` is blacklisted (absent means allowed) |
//! | `PaymentRateLimit(address)` | temporary | recent payment ledgers within the configured window |
//! | `ReentrancyGuard`      | temporary  | only during a guarded external call            |
//!
//! The legacy `Admin`/`Treasury`/`Paused` slots still readable through
//! `load_config` for instances deployed before the packing change — see
//! `stellar_card-contract/docs/storage.md`.

#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Bytes,
    BytesN, Env, String, Symbol, Vec,
};

/// Instance storage is extended to this many ledgers (~1000 days at 5s
/// close time — the value the original code already requested) once its
/// remaining TTL drops below `INSTANCE_TTL_THRESHOLD`. Note: a live network
/// may cap the achievable TTL below this (its `max_entry_ttl` setting), in
/// which case the actual extension is clamped — that ceiling is a network
/// property, unrelated to the threshold/max split below.
const INSTANCE_TTL_MAX: u32 = 17_280_000;
/// Half of `INSTANCE_TTL_MAX`. Deliberately lower than the max, not equal
/// to it: with threshold == extend_to (the contract's original pattern),
/// *any* decrease below the max retriggers a full extend — effectively a
/// ledger write on nearly every call. A threshold at half the max means an
/// extension only fires roughly once every ~500 days' worth of calls
/// instead of on (almost) every single one.
const INSTANCE_TTL_THRESHOLD: u32 = INSTANCE_TTL_MAX / 2;
const DEFAULT_PAYMENT_LIMIT: u32 = 10;
const DEFAULT_PAYMENT_WINDOW: u32 = 100;
const MAX_PAYMENT_LIMIT: u32 = 1_000;

/// Default escrow timelock: after this many seconds from deposit, anyone may
/// call `refund_escrow` without the Admin role (Issue #649). Seven days.
const ESCROW_TIMELOCK_SECS: u64 = 604_800;

/// Decimal precision `init` requires of both token contracts (Issue #399 -
/// Part 2). Every Stellar Asset Contract — including the USDC and native XLM
/// SACs this contract is built for — uses 7, and `pay_usdc`/`pay_xlm`
/// document their `amount` in 7-decimal base units.
const TOKEN_DECIMALS: u32 = 7;

/// `name()` reported by the native XLM Stellar Asset Contract. Issued
/// assets' SACs report `"CODE:ISSUER"` instead, so this identifies the
/// native asset unambiguously (Issue #389 - Part 1).
const NATIVE_ASSET_NAME: &str = "native";

/// User roles with hierarchical permissions (`Admin > Operator > Viewer`).
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    /// Full admin control: pause/unpause, upgrade, role management.
    Admin,
    /// Operational role. Satisfies `Operator` and `Viewer` requirements.
    Operator,
    /// Lowest-privilege role. Read/observer level access only.
    Viewer,
}

/// Treasury recipient and its percentage share of payments (Issue #679).
#[contracttype]
#[derive(Clone, Debug)]
pub struct TreasurySplit {
    pub address: Address,
    pub percentage: u32,
}

/// Token an escrow record is denominated in (Issue #649).
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Asset {
    /// USDC Stellar Asset Contract.
    Usdc,
    /// Native XLM Stellar Asset Contract.
    Xlm,
}

/// A held order escrow (Issue #649). Funds sit in the contract until
/// released to the treasury or refunded to the payer.
#[contracttype]
#[derive(Clone, Debug)]
pub struct EscrowRecord {
    /// Address that funded the escrow; refund target.
    pub payer: Address,
    /// Amount held, in 7-decimal base units.
    pub amount: i128,
    /// Ledger timestamp when the escrow was deposited.
    pub deposited_at: u64,
    /// Ledger timestamp after which anyone may refund without the Admin role.
    pub expires_at: u64,
}

/// Consolidated read-only view of the contract's configuration (Issue #651).
///
/// Returned by [`Stellar_CardReceiver::get_config`] so a client can load the
/// full deployment context in one call instead of five separate getters.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ContractConfig {
    /// Contract administrator (`DataKey::Admin`).
    pub admin: Address,
    /// Treasury that receives forwarded payments (`DataKey::Treasury`).
    pub treasury: Address,
    /// USDC Stellar Asset Contract (`DataKey::UsdcContract`).
    pub usdc_contract: Address,
    /// Native XLM Stellar Asset Contract (`DataKey::XlmContract`).
    pub xlm_contract: Address,
    /// Whether payments are currently paused (`DataKey::Paused`).
    pub is_paused: bool,
}

/// Storage keys. Most live in instance storage; `UserRole` is persistent
/// and `ReentrancyGuard` is temporary.
#[contracttype]
pub enum DataKey {
    /// Payment recipient. Set once by `init`.
    Treasury,
    /// Treasury splits for payment distribution (Issue #679). Absent means
    /// single-treasury mode.
    TreasurySplits,
    /// USDC SAC address. Set once by `init`.
    UsdcContract,
    /// Native XLM SAC address. Set once by `init`.
    XlmContract,
    /// Contract administrator. Set by `init`, moved by `transfer_admin`.
    /// Always treated as holding `Role::Admin`.
    Admin,
    /// Per-address role assignment. A per-address key keeps each grant/revoke
    /// touching only its own entry.
    UserRole(Address),
    /// Marks a guarded external call. Temporary; written by `_enter` and
    /// removed by `_exit`.
    ReentrancyGuard,
    /// Circuit breaker. Only stored while paused; absent means unpaused
    /// (Issue #395 - Part 2).
    Paused,
    /// Per-call `rescue_tokens` cap. Absent means uncapped.
    WithdrawLimitPerCall,
    /// Daily `rescue_tokens` cap. Absent means uncapped.
    WithdrawLimitPerDay,
    /// Per-payer payment counter for the current window. Temporary storage.
    PaymentRateLimit(Address),
    /// Optional `(max_payments, window_ledgers)` payment-rate configuration.
    PaymentRateLimitConfig,
    /// `(day, total)`: running `rescue_tokens` total for `day`. Single
    /// overwritten slot (Issue #395 - Part 2).
    DailyWithdrawn,
    /// Marks `address` as sanctions-flagged. Only stored while blacklisted.
    /// Per-address persistent key, like `UserRole`.
    Blacklist(Address),
    /// Emergency killswitch (Issue #671). Never cleared once set.
    Decommissioned,
    /// Per-address fee discount in basis points (1 bps = 0.01%). Max 10000.
    /// Absent means no discount. Persistent, per-address like `UserRole`.
    Discounts(Address),
    /// Held order escrow (Issue #649), keyed by `(Asset, OrderId)`.
    /// Temporary storage, TTL extended past `expires_at` on deposit.
    Escrow(Asset, Bytes),
}

/// Errors returned by the fallible (`Result`-returning) entrypoints.
///
/// The discriminants are part of the contract's public ABI — clients match on
/// the numeric code — so existing values must never be renumbered.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Amount must be positive
    InvalidAmount = 1,
    /// Token transfer operation failed
    TransferFailed = 2,
    /// The contract is paused; no new payments are accepted until unpaused
    ContractPaused = 3,
    /// `rescue_tokens` amount exceeds the configured per-call withdraw limit
    WithdrawLimitExceeded = 4,
    /// `rescue_tokens` amount would push today's cumulative withdrawals past
    /// the configured daily withdraw limit
    DailyWithdrawLimitExceeded = 5,
    /// `rescue_tokens` recipient is the contract itself, which would move
    /// nothing while still spending the day's withdraw budget
    InvalidRecipient = 6,
    /// Treasury split percentages must total 100
    InvalidTreasurySplits = 7,
    /// Payment metadata exceeds the 64-byte limit
    InvalidMetadata = 8,
    /// A financial calculation exceeded the range of its integer type
    ArithmeticOverflow = 9,
    /// Payer exceeded the configured payment rate
    RateLimitExceeded = 10,
    /// Payment rate parameters are zero or exceed supported bounds
    InvalidRateLimit = 11,
    /// The payer address is blacklisted and may not fund cards
    AddressBlacklisted = 12,
    /// The contract has been permanently decommissioned (Issue #671)
    ContractDecommissioned = 13,
    /// Discount value exceeds the maximum allowed (10000 basis points = 100%)
    InvalidDiscount = 14,
    /// No escrow record exists for the given (asset, order_id) (Issue #649)
    EscrowNotFound = 15,
    /// Refund attempted before the escrow timelock expired by a non-admin
    EscrowNotExpired = 16,
    /// An escrow already exists for the given (asset, order_id)
    EscrowAlreadyExists = 17,
}

/// The stellar_card card receiver contract.
///
/// Holds no in-memory state; all data lives in contract storage keyed by
/// [`DataKey`]. All contract entrypoints are implemented on this type.
/// Holds no in-memory state; all persistent data lives in instance storage keyed
/// by [`DataKey`]. All contract entrypoints are implemented on this type.
#[contract]
#[allow(non_camel_case_types)]
pub struct Stellar_CardReceiver;

// Post-init storage reads of the four config keys are infallible (`init`
// writes them before any entrypoint can observe them). `unwrap_used` stays
// enabled crate-wide; this impl is the one place that pattern is allowed.
#[allow(clippy::unwrap_used)]
#[contractimpl]
impl Stellar_CardReceiver {
    /// Initializes the contract with essential configuration.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `admin` - The admin address (must authorize this call)
    /// * `treasury` - The treasury address where payments are received
    /// * `usdc_contract` - The USDC SAC contract address
    /// * `xlm_contract` - The native XLM SAC contract address
    ///
    /// # Validation
    /// All parameters are checked by `validate_init_params` before any state
    /// is written (Issue #399 - Part 2): the receiver contract can't be used
    /// for any role; the admin can't be a token contract;
    /// the token contracts must differ and not double as the treasury; and
    /// both must implement the token interface with 7 decimals; and the
    /// native XLM asset can't be passed as `usdc_contract` (Issue #389 -
    /// Part 1), which would mean the two token arguments are swapped.
    ///
    /// # Storage (Issue #636)
    /// Writes `Config` (admin, treasury, paused) as one packed instance
    /// slot, the two token contracts on their own slots, and grants
    /// `admin` the `Admin` role (persistent). The contract starts unpaused.
    ///
    /// # Events (Issue #428 - Part 5)
    /// Emits: topics=[Symbol("init"), admin], value=(treasury, usdc_contract, xlm_contract)
    ///
    /// # Panics
    /// Panics if already initialized, if admin authorization fails, or if any
    /// validation check fails (see `validate_init_params`).
    /// validation check fails.
    ///
    /// # Notes
    /// One-time initialization. The admin must authorize to prevent front-running on deployment.
    /// Expected mainnet values (C-3, C-7):
    ///   usdc_contract : CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75  (USDC SAC)
    ///   xlm_contract  : native XLM SAC address (varies by network)
    ///   treasury      : stellar_card treasury G-address — verify before deployment
    pub fn init(
        env: Env,
        admin: Address,
        treasury: Address,
        usdc_contract: Address,
        xlm_contract: Address,
    ) {
        admin.require_auth();

        // Both the packed (#636) and legacy per-key layouts mark an
        // initialized instance.
        if env.storage().instance().has(&DataKey::Config)
            || env.storage().instance().has(&DataKey::Admin)
        {
            panic!("already initialized");
        }

        Self::validate_init_params(&env, &admin, &treasury, &usdc_contract, &xlm_contract);

        // Issue #636: admin, treasury, and the paused flag are packed into
        // a single `DataKey::Config` slot. Token contracts stay on their own
        // keys — they change independently via the update entrypoints.
        Self::save_config(
            &env,
            &Config {
                admin: admin.clone(),
                treasury,
                paused: false,
            },
        );
        env.storage()
            .instance()
            .set(&DataKey::UsdcContract, &usdc_contract);
        env.storage()
            .instance()
            .set(&DataKey::XlmContract, &xlm_contract);
        // `DataKey::Paused` is deliberately not written: an absent key reads
        // as unpaused (Issue #395 - Part 2).

        // Grant the Admin role to the admin address itself. Without this,
        // the deploying admin (the DataKey::Admin address) would satisfy
        // admin-only checks but NOT role-based checks like has_role(...,
        // Role::Admin) until someone remembered to self-grant it — a real
        // gap a fresh deployment could otherwise silently hit.
        let admin_role_key = DataKey::UserRole(admin.clone());
        env.storage()
            .persistent()
            .set(&admin_role_key, &Role::Admin);
        Self::extend_role_ttl(&env, &admin_role_key);

        Self::extend_instance_ttl(&env);

        // Emit initialization event (Issue #428 - Part 5)
        env.events().publish(
            (Symbol::new(&env, "init"), admin.clone()),
            (
                treasury.clone(),
                usdc_contract.clone(),
                xlm_contract.clone(),
            ),
        );
    }

    /// Validates `init`'s parameters before anything is written to storage
    /// (Issue #399 - Part 2).
    ///
    /// Kept separate from `init` so every rule lives in one place and is
    /// applied in a fixed order: cheap address-equality checks first, then
    /// the token-interface probes, which make cross-contract calls.
    ///
    /// # Rules
    /// * No role (admin, treasury, USDC, XLM) may be the receiver contract
    ///   itself.
    /// * The admin must not be either token contract (a token contract can't
    ///   sign admin actions,
    ///   so the contract would be unmanageable).
    /// * USDC and XLM must be different contracts, and the treasury must not
    ///   be either of them.
    /// * Both token contracts must answer `decimals()` (Issue #409 - Part 3)
    ///   and report [`TOKEN_DECIMALS`], the precision `pay_usdc`/`pay_xlm`
    ///   amounts are documented in. A token with any other precision would
    ///   silently mis-scale every payment by a power of ten.
    /// * `usdc_contract` must not be the native XLM asset contract (Issue
    ///   #389 - Part 1), which catches the USDC/XLM arguments being passed
    ///   in swapped order.
    ///
    /// # Panics
    /// Panics with a message naming the offending parameter on the first
    /// rule that fails.
    fn validate_init_params(
        env: &Env,
        admin: &Address,
        treasury: &Address,
        usdc_contract: &Address,
        xlm_contract: &Address,
    ) {
        let contract_address = env.current_contract_address();

        // No parameter may point back at this contract.
        if *admin == contract_address {
            panic!("admin cannot be the contract itself");
        }
        if *treasury == contract_address {
            panic!("treasury cannot be the contract itself");
        }
        if *usdc_contract == contract_address {
            panic!("usdc_contract cannot be the contract itself");
        }
        if *xlm_contract == contract_address {
            panic!("xlm_contract cannot be the contract itself");
        }

        if admin == usdc_contract || admin == xlm_contract {
            panic!("admin cannot be a configured token contract");
        }

        // Validate token contracts are different (prevents misconfiguration)
        if usdc_contract == xlm_contract {
            panic!("usdc_contract and xlm_contract must be different");
        }
        if treasury == usdc_contract || treasury == xlm_contract {
            panic!("treasury cannot be a configured token contract");
        }

        // Issue #409 (Part 3): probe both token addresses against the SAC
        // interface before storing them. Without this, a plain non-token
        // address (or a typo'd contract ID) would pass every check above and
        // only surface as a failure the first time a payer calls pay_usdc /
        // pay_xlm — by then the contract is already live and misconfigured.
        // `decimals()` is a read-only call with no side effects, so probing
        // it here costs nothing beyond the call itself and fails fast, at
        // deploy time, instead of at the first payment.
        match token::Client::new(env, usdc_contract).try_decimals() {
            Ok(Ok(TOKEN_DECIMALS)) => {}
            Ok(Ok(_)) => panic!("usdc_contract must use 7 decimals"),
            _ => panic!("usdc_contract does not implement the token interface"),
        }
        match token::Client::new(env, xlm_contract).try_decimals() {
            Ok(Ok(TOKEN_DECIMALS)) => {}
            Ok(Ok(_)) => panic!("xlm_contract must use 7 decimals"),
            _ => panic!("xlm_contract does not implement the token interface"),
        }

        // Issue #389 (Part 1): the decimals probe can't tell USDC and XLM
        // apart — both SACs report 7 — so swapping the two arguments would
        // pass every check above and silently route every `pay_usdc` through
        // native XLM. The native asset's SAC is the only one whose `name()`
        // is "native" (issued assets report "CODE:ISSUER"), so it identifies
        // the swap exactly. `name()` is only consulted, not required: the
        // decimals probe above is what establishes the token interface.
        if Self::is_native_asset(env, usdc_contract) {
            panic!("usdc_contract cannot be the native XLM asset contract");
        }
    }

    /// Returns whether `token_contract` is the native XLM Stellar Asset
    /// Contract, i.e. answers `name()` with `NATIVE_ASSET_NAME`.
    fn is_native_asset(env: &Env, token_contract: &Address) -> bool {
        matches!(
            token::Client::new(env, token_contract).try_name(),
            Ok(Ok(name)) if name == String::from_str(env, NATIVE_ASSET_NAME)
        )
    }

    /// Acquires the reentrancy guard to prevent reentrant calls.
    ///
    /// # Security (Issue #427 - Part 5)
    /// The reentrancy guard implements the Checks-Effects-Interactions pattern
    /// for payment callbacks. It prevents an attacker from calling back into
    /// `pay_usdc` or `pay_xlm` during a token transfer and draining funds.
    ///
    /// The guard is set at the start of payment functions and cleared on exit,
    /// ensuring that any attempt to re-enter will be detected and blocked.
    ///
    /// # Storage
    /// Stored in `temporary` storage, not `instance`. The guard only needs
    /// to exist for the span of a single call (set on entry, cleared before
    /// return) — it has no reason to persist across ledger closes or count
    /// toward the contract's `instance` storage footprint, which every
    /// `pay_usdc`/`pay_xlm` call already reads and rent-extends.
    ///
    /// # Panics
    /// Panics if the guard is already held, indicating a reentrant call attempt.
    ///
    /// # Example Attack Prevention
    /// Without this guard, a malicious token contract could:
    /// 1. Be called by `pay_usdc` to transfer tokens
    /// 2. Call back into `pay_usdc` before the first call completes
    /// 3. Potentially extract funds multiple times for a single payment
    ///
    /// The guard ensures step 2 fails immediately with "reentrancy detected".
    fn _enter(env: &Env) {
        let key = DataKey::ReentrancyGuard;
        if env
            .storage()
            .temporary()
            .get::<_, bool>(&key)
            .unwrap_or(false)
        {
            panic!("reentrancy detected");
        }
        env.storage().temporary().set(&key, &true);
    }

    /// Releases the reentrancy guard after a guarded operation completes.
    ///
    /// # Security (Issue #427 - Part 5)
    /// Must run on every non-panicking exit from a guarded call;
    /// `with_reentrancy_guard` guarantees this. A panic rolls back the whole
    /// invocation, guard write included, so it needs no release.
    ///
    /// # Storage (Issue #395 - Part 2)
    /// Removes the entry instead of writing `false`, so no temporary entry
    /// (and no rent for one) is left behind after the call. `_enter` already
    /// treats an absent key as "not held".
    ///
    /// # Security (Issue #427 - Part 5)
    /// Must be called in every exit path from a guarded function (success,
    /// error, or panic recovery via Drop) to ensure the guard doesn't remain
    /// locked if an early return occurs.
    fn _exit(env: &Env) {
        env.storage().temporary().remove(&DataKey::ReentrancyGuard);
    }

    /// Runs `f` while holding the reentrancy guard (Issue #397 - Part 2).
    ///
    /// Every external call into a token contract goes through this helper,
    /// so acquiring and releasing the guard lives in exactly one place
    /// instead of being repeated (and potentially forgotten) on every early
    /// return inside each entrypoint. `f` returns normally on both its
    /// success and error paths, and the guard is released before its result
    /// is handed back. If `f` panics, the whole invocation is rolled back by
    /// the host, which also discards the guard write, so there is no path
    /// that leaves the guard stuck on.
    ///
    /// # Panics
    /// Panics with "reentrancy detected" if the guard is already held.
    fn with_reentrancy_guard<T>(env: &Env, f: impl FnOnce() -> T) -> T {
        Self::_enter(env);
        let result = f();
        Self::_exit(env);
        result
    }

    /// Loads the packed configuration block (Issue #636).
    ///
    /// Falls back to the pre-#636 per-key layout (`DataKey::Admin`,
    /// `DataKey::Treasury`, `DataKey::Paused`) when `DataKey::Config` is
    /// absent so a live instance survives a WASM upgrade without an
    /// explicit migration call. The fallback is read-only: nothing is
    /// rewritten until the next `save_config`.
    ///
    /// # Panics
    /// Panics if called before `init` (neither layout is present).
    fn load_config(env: &Env) -> Config {
        if let Some(cfg) = env.storage().instance().get(&DataKey::Config) {
            return cfg;
        }
        // Legacy layout (pre-#636). `Paused` was opt-in: absent meant
        // unpaused, so `unwrap_or(false)` preserves that.
        Config {
            admin: env.storage().instance().get(&DataKey::Admin).unwrap(),
            treasury: env
                .storage()
                .instance()
                .get(&DataKey::Treasury)
                .unwrap(),
            paused: env
                .storage()
                .instance()
                .get::<_, bool>(&DataKey::Paused)
                .unwrap_or(false),
        }
    }

    /// Writes the packed configuration block and retires the legacy
    /// per-key slots (Issue #636).
    ///
    /// Removing `Admin`/`Treasury`/`Paused` shrinks the instance entry on
    /// the first write after an upgrade, which is when the packing win
    /// actually lands on-chain.
    fn save_config(env: &Env, cfg: &Config) {
        env.storage().instance().set(&DataKey::Config, cfg);
        env.storage().instance().remove(&DataKey::Admin);
        env.storage().instance().remove(&DataKey::Treasury);
        env.storage().instance().remove(&DataKey::Paused);
    }

    /// Returns whether the contract is currently paused.
    fn is_paused(env: &Env) -> bool {
        Self::load_config(env).paused
    }

    /// Returns `true` if `account` is currently blacklisted.
    fn is_blacklisted(env: &Env, account: &Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Blacklist(account.clone()))
    }

    /// Adds or removes `account` from the payer blacklist.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `caller` - The compliance operator or admin (must authorize this call)
    /// * `account` - The address to flag or clear
    /// * `status` - `true` to blacklist, `false` to remove from the blacklist
    ///
    /// # Authorization
    /// Requires `caller` to hold at least the `Operator` role (the stored
    /// admin always qualifies), like `pause`: flagging a sanctioned address
    /// is an operational response and should not wait for the admin.
    ///
    /// # Events
    /// Emits: topics=[Symbol("address_blacklisted"), account], value=caller
    /// when an address is newly blacklisted, or
    /// topics=[Symbol("address_unblacklisted"), account], value=caller when
    /// one is cleared. Re-applying the current status is a no-op with no event.
    ///
    /// # Panics
    /// Panics if called before `init`, if `caller.require_auth()` fails, or if
    /// `caller` does not hold at least the `Operator` role.
    pub fn set_blacklisted(env: Env, caller: Address, account: Address, status: bool) {
        caller.require_auth();
        if !Self::has_authority(&env, &caller, Role::Operator) {
            panic!("set_blacklisted requires at least the Operator role");
        }
        let key = DataKey::Blacklist(account.clone());
        let currently = env.storage().persistent().has(&key);
        if currently == status {
            return;
        }
        if status {
            env.storage().persistent().set(&key, &true);
            Self::extend_role_ttl(&env, &key);
            env.events()
                .publish((Symbol::new(&env, "address_blacklisted"), account), caller);
        } else {
            env.storage().persistent().remove(&key);
            env.events()
                .publish((Symbol::new(&env, "address_unblacklisted"), account), caller);
        }
    }

    /// Returns `true` if `account` is blacklisted and therefore cannot pay.
    pub fn is_blacklisted_view(env: Env, account: Address) -> bool {
        Self::is_blacklisted(&env, &account)
    }

    /// Pauses the contract, blocking all token transfers.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `caller` - The address invoking pause (must authorize this call)
    ///
    /// # Authorization (Issue #426 - Part 5 - Complete NatSpec)
    /// Requires `caller` to hold at least the `Operator` role (the stored
    /// admin always qualifies, see `has_authority`). Pausing is an
    /// operational response to an incident, so it's granted to Operators
    /// (not Admin-only) — the faster an incident responder can halt
    /// payments, the smaller the blast radius. Resuming is stricter; see
    /// `unpause`.
    ///
    /// # Events (Issue #428 - Part 5)
    /// Emits: topics=[Symbol("paused"), caller], value=true
    ///
    /// # Notes
    /// Idempotent — calling when already paused is a no-op.
    ///
    /// # Panics
    /// Panics if `caller` does not hold at least the `Operator` role, or if
    /// `caller.require_auth()` fails.
    pub fn pause(env: Env, caller: Address) {
        caller.require_auth();
        Self::require_not_decommissioned(&env);
        if !Self::has_authority(&env, &caller, Role::Operator) {
            panic!("pause requires at least the Operator role");
        }
        if Self::is_paused(&env) {
            return;
        }
        let mut cfg = Self::load_config(&env);
        cfg.paused = true;
        Self::save_config(&env, &cfg);
        Self::extend_instance_ttl(&env);

        // Emit pause event (Issue #428 - Part 5)
        env.events()
            .publish((symbol_short!("paused"), caller), true);
    }

    /// Unpauses the contract, re-enabling token transfers.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    ///
    /// # Authorization (Issue #426 - Part 5 - Complete NatSpec)
    /// Only the admin can call this function. Unpausing is more sensitive
    /// than pausing because it reopens the payment flow after an incident,
    /// so it requires admin approval.
    ///
    /// # Events (Issue #428 - Part 5)
    /// Emits: topics=[Symbol("unpaused"), admin], value=false
    ///
    /// # Notes
    /// Idempotent — calling when already unpaused is a no-op.
    ///
    /// # Panics
    /// Panics if called before `init`, or if `admin.require_auth()` fails.
    pub fn unpause(env: Env) {
        let mut cfg = Self::load_config(&env);
        let admin = cfg.admin.clone();
        admin.require_auth();
        Self::require_not_decommissioned(&env);
        if !cfg.paused {
            return;
        }
        // Packed flag flips to false (Issue #636); the legacy per-key
        // representation removed the key entirely to save bytes.
        cfg.paused = false;
        Self::save_config(&env, &cfg);
        Self::extend_instance_ttl(&env);

        // Emit unpause event (Issue #428 - Part 5)
        env.events()
            .publish((symbol_short!("unpaused"), admin), false);
    }

    /// Extends instance storage's TTL, but only performs the (fee-costing)
    /// ledger write once the remaining TTL drops below
    /// `INSTANCE_TTL_THRESHOLD` — see that constant's doc comment for why
    /// threshold and extend-to are deliberately different values.
    fn extend_instance_ttl(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_MAX);
    }

    /// Extends a single per-address role storage entry's TTL, but only
    /// performs the (fee-costing) ledger write once its remaining TTL drops
    /// below `INSTANCE_TTL_THRESHOLD` (Issue #415 - Part 4).
    ///
    /// # Storage footprint
    /// `grant_role`/`grant_roles` previously called `extend_ttl` on every
    /// single grant unconditionally, re-billing the entry's rent even when
    /// its TTL was already close to the maximum. Gating the extension
    /// behind a threshold — mirroring `extend_instance_ttl`'s existing
    /// pattern for instance storage — turns most repeat grants to the same
    /// address into a no-op write, cutting the average gas cost of RBAC
    /// administration.
    fn extend_role_ttl(env: &Env, key: &DataKey) {
        env.storage()
            .persistent()
            .extend_ttl(key, INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_MAX);
    }

    /// Configures the maximum payments per payer and the rolling ledger window.
    /// The window is bounded so temporary storage can retain each payer's
    /// counter through the full configured period.
    pub fn set_payment_rate_limit(
        env: Env,
        caller: Address,
        max_payments: u32,
        window_ledgers: u32,
    ) -> Result<(), Error> {
        caller.require_auth();
        Self::require_not_decommissioned(&env);
        if !Self::has_admin_authority(&env, &caller) {
            panic!("set_payment_rate_limit requires the Admin role");
        }
        if max_payments == 0
            || max_payments > MAX_PAYMENT_LIMIT
            || window_ledgers == 0
            || window_ledgers > INSTANCE_TTL_MAX / 2
        {
            return Err(Error::InvalidRateLimit);
        }

        env.storage()
            .instance()
            .set(&DataKey::PaymentRateLimitConfig, &(max_payments, window_ledgers));
        Self::extend_instance_ttl(&env);
        env.events().publish(
            (Symbol::new(&env, "payment_rate_limit_set"), caller),
            (max_payments, window_ledgers),
        );
        Ok(())
    }

    /// Returns the configured `(max_payments, window_ledgers)` policy.
    pub fn payment_rate_limit(env: Env) -> (u32, u32) {
        env.storage()
            .instance()
            .get(&DataKey::PaymentRateLimitConfig)
            .unwrap_or((DEFAULT_PAYMENT_LIMIT, DEFAULT_PAYMENT_WINDOW))
    }

    fn next_payment_rate_limit(env: &Env, payer: &Address) -> Result<Vec<u32>, Error> {
        let (max_payments, window_ledgers) = Self::payment_rate_limit(env.clone());
        let ledger = env.ledger().sequence();
        let key = DataKey::PaymentRateLimit(payer.clone());
        let previous = env
            .storage()
            .temporary()
            .get::<_, Vec<u32>>(&key)
            .unwrap_or(Vec::new(env));
        let mut active = Vec::new(env);
        for payment_ledger in previous.iter() {
            if ledger
                .checked_sub(payment_ledger)
                .is_some_and(|elapsed| elapsed < window_ledgers)
            {
                active.push_back(payment_ledger);
            }
        }
        if active.len() >= max_payments {
            return Err(Error::RateLimitExceeded);
        }
        active.push_back(ledger);
        Ok(active)
    }

    fn record_payment_rate_limit(
        env: &Env,
        payer: &Address,
        payment_ledgers: &Vec<u32>,
        window_ledgers: u32,
    ) {
        let key = DataKey::PaymentRateLimit(payer.clone());
        env.storage().temporary().set(&key, payment_ledgers);
        env.storage().temporary().extend_ttl(
            &key,
            window_ledgers,
            window_ledgers.saturating_mul(2),
        );
    }

    /// Transfers USDC tokens from a payer to the contract treasury.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `from` - The payer address (must authorize this transfer)
    /// * `amount` - Amount in micro-USDC (7 decimal places)
    /// * `order_id` - Order identifier for event tracking
    ///
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `from` - The payer address (must authorize this transfer)
    /// * `amount` - Amount in micro-USDC (7 decimal places)
    /// * `order_id` - Order identifier for event tracking
    ///
    /// # Returns
    /// `Ok(())` on successful transfer, `Err(Error)` otherwise.
    ///
    /// # Errors
    /// * `InvalidAmount` - If amount is <= 0
    /// * `TransferFailed` - If the underlying token transfer fails
    /// * `ContractPaused` - If the contract is currently paused
    /// * `AddressBlacklisted` - If `from` is on the payer blacklist
    ///
    /// # Authorization
    /// Requires `from.require_auth()`. The check runs after the pause and
    /// amount checks, so a rejected payment never consumes a signature.
    ///
    /// # Events
    /// Emits: topics=[Symbol("pay_usdc"), order_id, from], value=amount —
    /// only after the transfer succeeds.
    ///
    /// # Panics
    /// Panics if called before `init`, if `from.require_auth()` fails, or
    /// with "reentrancy detected" if invoked from inside another guarded call.
    pub fn pay_usdc(env: Env, from: Address, amount: i128, order_id: Bytes) -> Result<(), Error> {
        if Self::is_decommissioned(&env) {
            return Err(Error::ContractDecommissioned);
        }
        if Self::is_paused(&env) {
            return Err(Error::ContractPaused);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if Self::is_blacklisted(&env, &from) {
            return Err(Error::AddressBlacklisted);
        }
        from.require_auth();
        let payment_ledgers = Self::next_payment_rate_limit(&env, &from)?;
        let (_, window_ledgers) = Self::payment_rate_limit(env.clone());

        let treasury: Address = Self::load_config(&env).treasury;
        let usdc_contract: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcContract)
            .unwrap();

        // Apply discount if the payer has one
        let net_amount = Self::apply_discount(&env, &from, amount)?;

        // The token contract is the only external call in this function, so
        // it is the only step that needs to run under the guard.
        let transferred = Self::with_reentrancy_guard(&env, || {
            token::Client::new(&env, &usdc_contract)
                .try_transfer(&from, &treasury, &net_amount)
                .is_ok()
        });
        if !transferred {
            return Err(Error::TransferFailed);
        }

        Self::record_payment_rate_limit(
            &env,
            &from,
            &payment_ledgers,
            window_ledgers,
        );

        env.events()
            .publish((symbol_short!("pay_usdc"), order_id, from), amount);

        Self::extend_instance_ttl(&env);
        Ok(())
    }

    /// Transfers USDC and emits optional routing metadata with the payment event.
    /// Metadata limited to 64 bytes; `pay_usdc` event unchanged.
    pub fn pay_usdc_with_memo(
        env: Env,
        from: Address,
        amount: i128,
        order_id: Bytes,
        metadata: Bytes,
    ) -> Result<(), Error> {
        if metadata.len() > 64 {
            return Err(Error::InvalidMetadata);
        }
        if Self::is_decommissioned(&env) {
            return Err(Error::ContractDecommissioned);
        }
        if Self::is_paused(&env) {
            return Err(Error::ContractPaused);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if Self::is_blacklisted(&env, &from) {
            return Err(Error::AddressBlacklisted);
        }
        from.require_auth();

        let treasury: Address = Self::load_config(&env).treasury;
        let usdc_contract: Address = env
            .storage()
            .instance()
            .get(&DataKey::UsdcContract)
            .unwrap();
        let net_amount = Self::apply_discount(&env, &from, amount)?;
        let transferred = Self::with_reentrancy_guard(&env, || {
            token::Client::new(&env, &usdc_contract)
                .try_transfer(&from, &treasury, &net_amount)
                .is_ok()
        });
        if !transferred {
            return Err(Error::TransferFailed);
        }

        env.events().publish(
            (symbol_short!("pay_usdc"), order_id, from),
            (amount, metadata),
        );
        Self::extend_instance_ttl(&env);
        Ok(())
    }

    /// Transfers XLM tokens from a payer to the contract treasury.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `from` - The payer address (must authorize this transfer)
    /// * `amount` - Amount in stroops (7 decimal places)
    /// * `order_id` - Order identifier for event tracking
    ///
    /// # Returns
    /// `Ok(())` on successful transfer, `Err(Error)` otherwise.
    ///
    /// # Errors
    /// * `InvalidAmount` - If amount is <= 0
    /// * `TransferFailed` - If the underlying token transfer fails
    /// * `ContractPaused` - If the contract is currently paused
    /// * `AddressBlacklisted` - If `from` is on the payer blacklist
    ///
    /// # Authorization
    /// Requires `from.require_auth()`, checked after the pause and amount
    /// checks exactly as in `pay_usdc`.
    ///
    /// # Events
    /// Emits: topics=[Symbol("pay_xlm"), order_id, from], value=amount —
    /// only after the transfer succeeds.
    ///
    /// # Panics
    /// Panics if called before `init`, if `from.require_auth()` fails, or
    /// with "reentrancy detected" if invoked from inside another guarded call.
    pub fn pay_xlm(env: Env, from: Address, amount: i128, order_id: Bytes) -> Result<(), Error> {
        if Self::is_decommissioned(&env) {
            return Err(Error::ContractDecommissioned);
        }
        if Self::is_paused(&env) {
            return Err(Error::ContractPaused);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if Self::is_blacklisted(&env, &from) {
            return Err(Error::AddressBlacklisted);
        }
        from.require_auth();
        let payment_ledgers = Self::next_payment_rate_limit(&env, &from)?;
        let (_, window_ledgers) = Self::payment_rate_limit(env.clone());

        let treasury: Address = Self::load_config(&env).treasury;
        let xlm_contract: Address = env.storage().instance().get(&DataKey::XlmContract).unwrap();

        // Apply discount if the payer has one
        let net_amount = Self::apply_discount(&env, &from, amount)?;

        // The token contract is the only external call in this function, so
        // it is the only step that needs to run under the guard.
        let transferred = Self::with_reentrancy_guard(&env, || {
            token::Client::new(&env, &xlm_contract)
                .try_transfer(&from, &treasury, &net_amount)
                .is_ok()
        });
        if !transferred {
            return Err(Error::TransferFailed);
        }

        Self::record_payment_rate_limit(
            &env,
            &from,
            &payment_ledgers,
            window_ledgers,
        );

        env.events()
            .publish((symbol_short!("pay_xlm"), order_id, from), amount);

        Self::extend_instance_ttl(&env);
        Ok(())
    }

    /// Transfers XLM and emits optional routing metadata with the payment event.
    /// Metadata limited to 64 bytes; `pay_xlm` event unchanged.
    pub fn pay_xlm_with_memo(
        env: Env,
        from: Address,
        amount: i128,
        order_id: Bytes,
        metadata: Bytes,
    ) -> Result<(), Error> {
        if metadata.len() > 64 {
            return Err(Error::InvalidMetadata);
        }
        if Self::is_decommissioned(&env) {
            return Err(Error::ContractDecommissioned);
        }
        if Self::is_paused(&env) {
            return Err(Error::ContractPaused);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if Self::is_blacklisted(&env, &from) {
            return Err(Error::AddressBlacklisted);
        }
        from.require_auth();

        let treasury: Address = Self::load_config(&env).treasury;
        let xlm_contract: Address = env.storage().instance().get(&DataKey::XlmContract).unwrap();
        let net_amount = Self::apply_discount(&env, &from, amount)?;
        let transferred = Self::with_reentrancy_guard(&env, || {
            token::Client::new(&env, &xlm_contract)
                .try_transfer(&from, &treasury, &net_amount)
                .is_ok()
        });
        if !transferred {
            return Err(Error::TransferFailed);
        }

        env.events().publish(
            (symbol_short!("pay_xlm"), order_id, from),
            (amount, metadata),
        );
        Self::extend_instance_ttl(&env);
        Ok(())
    }

    // ── order escrow (Issue #649) ───────────────────────────────────────────

    /// Deposits `amount` of `asset` from `from` into contract escrow for
    /// `order_id`, held until fulfillment or refund (Issue #649).
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `from` - The payer funding the escrow (must authorize the transfer)
    /// * `amount` - Positive amount in 7-decimal base units
    /// * `order_id` - Order identifier; combined with `asset` forms the key
    /// * `asset` - Which configured token to hold (`Usdc` or `Xlm`)
    ///
    /// # Authorization
    /// Requires `from.require_auth()`.
    ///
    /// # Storage
    /// Records an [`EscrowRecord`] under `DataKey::Escrow(asset, order_id)`
    /// in temporary storage and extends its TTL past `expires_at`.
    ///
    /// # Events
    /// Emits: topics=[Symbol("escrow_deposited"), asset, order_id, from],
    /// value=amount
    ///
    /// # Errors
    /// * `InvalidAmount` - amount is not positive
    /// * `ContractPaused` / `ContractDecommissioned` - contract not accepting
    /// * `AddressBlacklisted` - `from` is on the payer blacklist
    /// * `EscrowAlreadyExists` - an active escrow already covers this key
    /// * `TransferFailed` - token transfer failed
    pub fn deposit_escrow(
        env: Env,
        from: Address,
        amount: i128,
        order_id: Bytes,
        asset: Asset,
    ) -> Result<(), Error> {
        if Self::is_decommissioned(&env) {
            return Err(Error::ContractDecommissioned);
        }
        if Self::is_paused(&env) {
            return Err(Error::ContractPaused);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if Self::is_blacklisted(&env, &from) {
            return Err(Error::AddressBlacklisted);
        }
        from.require_auth();

        let key = DataKey::Escrow(asset, order_id.clone());
        if env.storage().temporary().has(&key) {
            return Err(Error::EscrowAlreadyExists);
        }

        // Payer -> contract: the only escrow transfer whose source is not
        // the contract itself, so it cannot share `transfer_escrow_tokens`.
        let token_contract = Self::token_for_asset(&env, asset);
        let contract_address = env.current_contract_address();
        let transferred = Self::with_reentrancy_guard(&env, || {
            token::Client::new(&env, &token_contract)
                .try_transfer(&from, &contract_address, &amount)
                .is_ok()
        });
        if !transferred {
            return Err(Error::TransferFailed);
        }

        let now = env.ledger().timestamp();
        let record = EscrowRecord {
            payer: from.clone(),
            amount,
            deposited_at: now,
            expires_at: now.saturating_add(ESCROW_TIMELOCK_SECS),
        };
        env.storage().temporary().set(&key, &record);
        // Keep the record alive at least until the refund timelock elapses.
        let live_ledgers = u32::try_from(ESCROW_TIMELOCK_SECS / 5).unwrap_or(u32::MAX);
        env.storage().temporary().extend_ttl(
            &key,
            live_ledgers,
            live_ledgers.saturating_mul(2),
        );

        env.events().publish(
            (
                Symbol::new(&env, "escrow_deposited"),
                Self::asset_symbol(asset),
                order_id,
                from,
            ),
            amount,
        );
        Self::extend_instance_ttl(&env);
        Ok(())
    }

    /// Releases a held escrow to the treasury once the order is fulfilled
    /// (Issue #649).
    ///
    /// # Authorization
    /// Requires `caller` to hold at least the `Operator` role (or be the
    /// stored admin).
    ///
    /// # Events
    /// Emits: topics=[Symbol("escrow_released"), asset, order_id, caller],
    /// value=(payer, amount)
    ///
    /// # Errors
    /// * `EscrowNotFound` - no active escrow for this key
    ///
    /// # Panics
    /// Panics if `caller` lacks the Operator role.
    pub fn release_escrow(
        env: Env,
        caller: Address,
        order_id: Bytes,
        asset: Asset,
    ) -> Result<(), Error> {
        caller.require_auth();
        if !Self::has_authority(&env, &caller, Role::Operator) {
            panic!("release_escrow requires at least the Operator role");
        }

        let key = DataKey::Escrow(asset, order_id.clone());
        let record: EscrowRecord = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::EscrowNotFound)?;
        env.storage().temporary().remove(&key);

        let treasury: Address = env.storage().instance().get(&DataKey::Treasury).unwrap();
        if !Self::transfer_escrow_tokens(&env, asset, &treasury, record.amount) {
            return Err(Error::TransferFailed);
        }

        env.events().publish(
            (
                Symbol::new(&env, "escrow_released"),
                Self::asset_symbol(asset),
                order_id,
                caller,
            ),
            (record.payer, record.amount),
        );
        Self::extend_instance_ttl(&env);
        Ok(())
    }

    /// Refunds a held escrow to its original payer (Issue #649).
    ///
    /// Callable by the stored admin (or an `Admin` role holder) at any time,
    /// or by anyone once the escrow's timelock has expired.
    ///
    /// # Authorization
    /// Requires `caller.require_auth()`.
    ///
    /// # Events
    /// Emits: topics=[Symbol("escrow_refunded"), asset, order_id, caller],
    /// value=(payer, amount)
    ///
    /// # Errors
    /// * `EscrowNotFound` - no active escrow for this key
    /// * `EscrowNotExpired` - timelock still running and caller is not admin
    /// * `TransferFailed` - token transfer failed
    pub fn refund_escrow(
        env: Env,
        caller: Address,
        order_id: Bytes,
        asset: Asset,
    ) -> Result<(), Error> {
        caller.require_auth();

        let key = DataKey::Escrow(asset, order_id.clone());
        let record: EscrowRecord = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::EscrowNotFound)?;

        let expired = env.ledger().timestamp() >= record.expires_at;
        if !expired && !Self::has_admin_authority(&env, &caller) {
            return Err(Error::EscrowNotExpired);
        }

        env.storage().temporary().remove(&key);

        if !Self::transfer_escrow_tokens(&env, asset, &record.payer, record.amount) {
            return Err(Error::TransferFailed);
        }

        env.events().publish(
            (
                Symbol::new(&env, "escrow_refunded"),
                Self::asset_symbol(asset),
                order_id,
                caller,
            ),
            (record.payer, record.amount),
        );
        Self::extend_instance_ttl(&env);
        Ok(())
    }

    /// Returns the escrow record for `(asset, order_id)`, if one is active.
    pub fn get_escrow(env: Env, order_id: Bytes, asset: Asset) -> Option<EscrowRecord> {
        env.storage().temporary().get(&DataKey::Escrow(asset, order_id))
    }

    /// Moves `amount` of `asset` from the contract's own balance to `to`.
    ///
    /// Shared by `release_escrow` and `refund_escrow` (Issue #649).
    fn transfer_escrow_tokens(env: &Env, asset: Asset, to: &Address, amount: i128) -> bool {
        let token_contract = Self::token_for_asset(env, asset);
        let contract_address = env.current_contract_address();
        Self::with_reentrancy_guard(env, || {
            token::Client::new(env, &token_contract)
                .try_transfer(&contract_address, to, &amount)
                .is_ok()
        })
    }

    /// Resolves the configured token contract for an [`Asset`].
    fn token_for_asset(env: &Env, asset: Asset) -> Address {
        match asset {
            Asset::Usdc => env
                .storage()
                .instance()
                .get(&DataKey::UsdcContract)
                .unwrap(),
            Asset::Xlm => env
                .storage()
                .instance()
                .get(&DataKey::XlmContract)
                .unwrap(),
        }
    }

    /// Short event topic symbol for an [`Asset`] (fits `symbol_short!`).
    fn asset_symbol(asset: Asset) -> Symbol {
        match asset {
            Asset::Usdc => symbol_short!("USDC"),
            Asset::Xlm => symbol_short!("XLM"),
        }
    }

    /// Returns the treasury address where payments are received.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    ///
    /// # Returns
    /// The treasury address
    ///
    /// # Panics
    /// Panics if called before `init`. Callers who need to distinguish
    /// "not yet initialized" from a real error should use the
    /// auto-generated `try_treasury` instead.
    pub fn treasury(env: Env) -> Address {
        Self::load_config(&env).treasury
    }

    /// Returns the USDC SAC contract address.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    ///
    /// # Returns
    /// The USDC contract address
    ///
    /// # Panics
    /// Panics if called before `init` (see `try_usdc_contract` to avoid this).
    pub fn usdc_contract(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::UsdcContract)
            .unwrap()
    }

    /// Returns the native XLM SAC contract address.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    ///
    /// # Returns
    /// The XLM contract address
    ///
    /// # Panics
    /// Panics if called before `init` (see `try_xlm_contract` to avoid this).
    pub fn xlm_contract(env: Env) -> Address {
        env.storage().instance().get(&DataKey::XlmContract).unwrap()
    }

    /// Returns the admin address.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    ///
    /// # Returns
    /// The admin address
    ///
    /// # Panics
    /// Panics if called before `init` (see `try_admin` to avoid this).
    pub fn admin(env: Env) -> Address {
        Self::load_config(&env).admin
    }

    /// Returns whether the contract is currently paused.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    ///
    /// # Returns
    /// `true` if paused, `false` otherwise
    pub fn is_paused_view(env: Env) -> bool {
        Self::is_paused(&env)
    }

    /// Returns the full contract configuration in a single read-only call
    /// (Issue #651).
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    ///
    /// # Returns
    /// A [`ContractConfig`] holding `admin`, `treasury`, `usdc_contract`,
    /// `xlm_contract` and `is_paused`, identical to what the individual
    /// getters (`admin`, `treasury`, `usdc_contract`, `xlm_contract`,
    /// `is_paused_view`) report.
    ///
    /// # Authorization
    /// None required. View function: it only reads instance storage and never
    /// writes state, so it consumes no state-write fees and cannot be used to
    /// mutate the contract.
    ///
    /// # Panics
    /// Panics if called before `init` (see `try_get_config` to avoid this).
    pub fn get_config(env: Env) -> ContractConfig {
        ContractConfig {
            admin: Self::admin(env.clone()),
            treasury: Self::treasury(env.clone()),
            usdc_contract: Self::usdc_contract(env.clone()),
            xlm_contract: Self::xlm_contract(env.clone()),
            is_paused: Self::is_paused(&env),
        }
    }

    /// Updates the treasury address.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `new_treasury` - The new treasury address
    ///
    /// # Authorization
    /// Only the admin can call this function.
    ///
    /// # Events
    /// Emits: [treasury_updated, old, new] = admin
    ///
    /// # Panics
    /// Panics if called before `init` or if `admin.require_auth()` fails.
    pub fn update_treasury(env: Env, new_treasury: Address) {
        let mut cfg = Self::load_config(&env);
        let admin = cfg.admin.clone();
        admin.require_auth();

        let old_treasury = cfg.treasury.clone();
        cfg.treasury = new_treasury.clone();
        Self::save_config(&env, &cfg);
        Self::extend_instance_ttl(&env);

        // Emit treasury update event
        env.events().publish(
            (
                Symbol::new(&env, "treasury_updated"),
                old_treasury,
                new_treasury,
            ),
            admin,
        );
    }

    /// Updates the USDC token contract address.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `new_contract` - The new USDC contract address
    ///
    /// # Authorization
    /// Only the admin can call this function.
    ///
    /// # Events
    /// Emits: [token_contract_updated, USDC, old, new] = admin
    ///
    /// # Panics
    /// Panics if called before `init` or if `admin.require_auth()` fails.
    pub fn update_usdc_contract(env: Env, new_contract: Address) {
        let admin: Address = Self::load_config(&env).admin;
        admin.require_auth();

        let old_contract: Address = env.storage().instance().get(&DataKey::UsdcContract).unwrap();
        env.storage().instance().set(&DataKey::UsdcContract, &new_contract);
        Self::extend_instance_ttl(&env);

        // Emit token contract update event
        env.events().publish(
            (
                Symbol::new(&env, "token_contract_updated"),
                symbol_short!("USDC"),
                old_contract,
                new_contract,
            ),
            admin,
        );
    }

    /// Updates the XLM token contract address.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `new_contract` - The new XLM contract address
    ///
    /// # Authorization
    /// Only the admin can call this function.
    ///
    /// # Events
    /// Emits: [token_contract_updated, XLM, old, new] = admin
    ///
    /// # Panics
    /// Panics if called before `init` or if `admin.require_auth()` fails.
    pub fn update_xlm_contract(env: Env, new_contract: Address) {
        let admin: Address = Self::load_config(&env).admin;
        admin.require_auth();

        let old_contract: Address = env.storage().instance().get(&DataKey::XlmContract).unwrap();
        env.storage().instance().set(&DataKey::XlmContract, &new_contract);
        Self::extend_instance_ttl(&env);

        // Emit token contract update event
        env.events().publish(
            (
                Symbol::new(&env, "token_contract_updated"),
                symbol_short!("XLM"),
                old_contract,
                new_contract,
            ),
            admin,
        );
    }

    /// Upgrades the contract WASM code.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `new_wasm_hash` - The hash of the new WASM code
    ///
    /// # Authorization
    /// Only the admin can call this function.
    ///
    /// # Events
    /// Emits: topics=[Symbol("upgraded"), admin], value=new_wasm_hash
    ///
    /// # Panics
    /// Panics if called before `init` (no admin address stored yet), if
    /// `admin.require_auth()` fails, or if `new_wasm_hash` does not
    /// correspond to a previously uploaded WASM blob.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = Self::load_config(&env).admin;
        admin.require_auth();
        Self::require_not_decommissioned(&env);
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        env.events()
            .publish((symbol_short!("upgraded"), admin), new_wasm_hash);
    }

    /// Recovers tokens sent to the contract by mistake — a direct transfer
    /// to the contract's own address, bypassing `pay_usdc`/`pay_xlm` (which
    /// forward straight to the treasury and never leave a balance on the
    /// contract itself). Works for any SAC-compatible token, not just the
    /// configured USDC/XLM contracts, since a mistaken send could be any
    /// asset.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `caller` - The address invoking the rescue (must authorize this call)
    /// * `token_contract` - The token contract to rescue a balance from
    /// * `to` - Where to send the recovered tokens
    /// * `amount` - Amount to recover, in the token's base units
    ///
    /// # Authorization
    /// Requires `caller` to either be the stored `DataKey::Admin` address,
    /// or hold the `Admin` role via `grant_role` — recovering funds is
    /// powerful enough that it stays Admin-only, unlike `pause` (see
    /// `Stellar_CardReceiver::pause`'s doc comment for the contrast). Both
    /// forms are accepted because the deploying admin is never
    /// auto-granted the `Admin` role (`grant_role`/`has_role` are a
    /// separate system from `DataKey::Admin`) — requiring only the role
    /// would lock out a fresh deployment until someone remembered to grant
    /// it to themselves.
    ///
    /// # Errors
    /// * `InvalidAmount` - If `amount` is <= 0
    /// * `InvalidRecipient` - If `to` is the contract itself
    /// * `WithdrawLimitExceeded` - If a per-call limit is configured and
    ///   `amount` exceeds it
    /// * `DailyWithdrawLimitExceeded` - If a daily limit is configured and
    ///   this withdrawal would push today's cumulative total past it
    /// * `TransferFailed` - If the underlying token transfer fails (e.g. the
    ///   contract's balance is lower than `amount`)
    ///
    /// # Security (Issue #397 - Part 2)
    /// The transfer runs under the reentrancy guard, and the daily
    /// accumulator is written before the transfer (Checks-Effects-
    /// Interactions), because `token_contract` is caller-supplied and may
    /// call back into this contract.
    ///
    /// # Events (Issue #398 - Part 2)
    /// Emits: topics=[Symbol("tokens_rescued"), token_contract, to],
    /// value=(caller, amount). Not emitted when the call returns an error.
    ///
    /// # Panics
    /// Panics if `caller` does not hold the `Admin` role, if
    /// `caller.require_auth()` fails, or with "reentrancy detected" if
    /// invoked while another guarded operation is in progress.
    pub fn rescue_tokens(
        env: Env,
        caller: Address,
        token_contract: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), Error> {
        caller.require_auth();
        Self::require_not_decommissioned(&env);
        if !Self::has_admin_authority(&env, &caller) {
            panic!("rescue_tokens requires the Admin role");
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        // Issue #391 (Part 1): a self-transfer leaves the balance where it
        // is but would still be counted against the daily limit, letting a
        // mistaken (or compromised) caller exhaust the day's budget and
        // block a genuine rescue.
        let contract_address = env.current_contract_address();
        if to == contract_address {
            return Err(Error::InvalidRecipient);
        }

        if let Some(per_call_limit) = env
            .storage()
            .instance()
            .get::<DataKey, i128>(&DataKey::WithdrawLimitPerCall)
        {
            if amount > per_call_limit {
                return Err(Error::WithdrawLimitExceeded);
            }
        }

        let day = Self::current_day(&env);
        let withdrawn_today = Self::withdrawn_on(&env, day);
        // Record only exact totals; saturating here could silently undercount
        // withdrawals and bypass a configured daily limit.
        let new_total = withdrawn_today
            .checked_add(amount)
            .ok_or(Error::ArithmeticOverflow)?;

        if let Some(daily_limit) = env
            .storage()
            .instance()
            .get::<DataKey, i128>(&DataKey::WithdrawLimitPerDay)
        {
            if new_total > daily_limit {
                return Err(Error::DailyWithdrawLimitExceeded);
            }
        }

        // Checks-Effects-Interactions (Issue #397 - Part 2): `token_contract`
        // is caller-supplied and may be any contract, not just a trusted SAC,
        // which makes this the contract's only call into potentially
        // untrusted code. Record the withdrawal against today's accumulator
        // *before* the transfer, so a callback made from inside the
        // transfer can never observe a stale total and slip a second
        // withdrawal under the daily limit.
        Self::set_withdrawn(&env, day, new_total);

        let transferred = Self::with_reentrancy_guard(&env, || {
            token::Client::new(&env, &token_contract)
                .try_transfer(&contract_address, &to, &amount)
                .is_ok()
        });
        if !transferred {
            // The transfer didn't happen, so it mustn't count against the
            // day's budget: restore the accumulator to its previous value.
            Self::set_withdrawn(&env, day, withdrawn_today);
            return Err(Error::TransferFailed);
        }

        Self::extend_instance_ttl(&env);

        // Issue #398 (Part 2): moving funds out of the contract is the most
        // sensitive state change it can make, so it must be visible to
        // off-chain monitoring like every other admin action. Only emitted
        // once the transfer has succeeded.
        env.events().publish(
            (Symbol::new(&env, "tokens_rescued"), token_contract, to),
            (caller, amount),
        );
        Ok(())
    }

    /// Configures `rescue_tokens`'s withdraw limits (Admin-role gated).
    ///
    /// # Limits
    /// * `per_call` - Maximum amount a single `rescue_tokens` call may move,
    ///   or `None` to remove the per-call cap.
    /// * `per_day` - Maximum cumulative amount `rescue_tokens` may move
    ///   within a single day, or `None` to remove the daily cap.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `caller` - The address configuring the limits (must authorize this call)
    ///
    /// # Storage
    /// A `None` limit removes its key rather than storing a sentinel, so an
    /// unconfigured limit costs no instance-storage bytes.
    ///
    /// # Events
    /// Emits: topics=[Symbol("withdraw_limits_set"), caller],
    /// value=(per_call, per_day)
    ///
    /// # Panics
    /// Panics if `caller` does not hold the `Admin` role (or is not the
    /// stored admin), if `caller.require_auth()` fails, if either limit
    /// is provided as <= 0, or if both are set and `per_call` exceeds
    /// `per_day`.
    pub fn set_withdraw_limits(
        env: Env,
        caller: Address,
        per_call: Option<i128>,
        per_day: Option<i128>,
    ) {
        caller.require_auth();
        Self::require_not_decommissioned(&env);
        if !Self::has_admin_authority(&env, &caller) {
            panic!("set_withdraw_limits requires the Admin role");
        }
        if per_call.is_some_and(|v| v <= 0) || per_day.is_some_and(|v| v <= 0) {
            panic!("withdraw limits must be positive when set");
        }
        // Issue #391 (Part 1): a per-call cap above the daily cap can never
        // be reached, so such a pair is almost certainly a typo (e.g. the
        // two arguments swapped) and would leave the admin believing a
        // larger single rescue is allowed than actually is.
        if let (Some(call), Some(day)) = (per_call, per_day) {
            if call > day {
                panic!("per-call withdraw limit cannot exceed the daily limit");
            }
        }

        match per_call {
            Some(v) => env
                .storage()
                .instance()
                .set(&DataKey::WithdrawLimitPerCall, &v),
            None => env
                .storage()
                .instance()
                .remove(&DataKey::WithdrawLimitPerCall),
        }
        match per_day {
            Some(v) => env
                .storage()
                .instance()
                .set(&DataKey::WithdrawLimitPerDay, &v),
            None => env
                .storage()
                .instance()
                .remove(&DataKey::WithdrawLimitPerDay),
        }
        Self::extend_instance_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "withdraw_limits_set"), caller),
            (per_call, per_day),
        );
    }

    /// Returns the currently configured `(per_call, per_day)` withdraw
    /// limits for `rescue_tokens`.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    ///
    /// # Returns
    /// `(per_call, per_day)`; `None` in either position means that limit is
    /// not configured.
    pub fn withdraw_limits(env: Env) -> (Option<i128>, Option<i128>) {
        let per_call = env.storage().instance().get(&DataKey::WithdrawLimitPerCall);
        let per_day = env.storage().instance().get(&DataKey::WithdrawLimitPerDay);
        (per_call, per_day)
    }

    /// Returns the amount already withdrawn via `rescue_tokens` on `day`.
    ///
    /// Reads the single `DataKey::DailyWithdrawn` slot; a slot recorded for
    /// an earlier day (or no slot at all) means nothing was withdrawn on
    /// `day`, which is what resets the daily limit at each day boundary.
    /// Whether `caller` may use the withdraw entrypoints: either the stored
    /// `DataKey::Admin` address or a holder of the `Admin` role. The stored
    /// admin was not always auto-granted the Admin *role* (grant_role /
    /// has_role are a separate system), so both forms of admin authority
    /// are accepted. Shared by `rescue_tokens` and `set_withdraw_limits`
    /// so the rule, and its code, exist once (Issue #392 - Part 1).
    fn has_admin_authority(env: &Env, caller: &Address) -> bool {
        let stored_admin: Address = Self::load_config(&env).admin;
        *caller == stored_admin || Self::has_role(env.clone(), caller.clone(), Role::Admin)
    }

    /// Returns how much `rescue_tokens` has moved so far during the current
    /// day (Issue #391 - Part 1), so monitoring can see how much of the
    /// daily withdraw limit is left before attempting a rescue.
    pub fn withdrawn_today(env: Env) -> i128 {
        Self::withdrawn_on(&env, Self::current_day(&env))
    }

    /// The current day index used for the daily withdraw limit: ledger
    /// timestamp / 86400, so days roll over at 00:00 UTC.
    fn current_day(env: &Env) -> u64 {
        env.ledger().timestamp() / 86_400
    }

    /// Total recorded against `day` in [`DataKey::DailyWithdrawn`]; 0 when
    /// nothing has been withdrawn yet or the stored total is for an
    /// earlier day.
    fn withdrawn_on(env: &Env, day: u64) -> i128 {
        match env
            .storage()
            .instance()
            .get::<_, (u64, i128)>(&DataKey::DailyWithdrawn)
        {
            Some((stored_day, total)) if stored_day == day => total,
            _ => 0,
        }
    }

    /// Records `total` as the amount withdrawn on `day`, overwriting the
    /// single `DataKey::DailyWithdrawn` slot.
    ///
    /// # Storage (Issue #395 - Part 2)
    /// A zero total removes the slot instead of writing `(day, 0)` — the two
    /// read back identically through `withdrawn_on` — so a failed first
    /// withdrawal of the day leaves no entry behind.
    fn set_withdrawn(env: &Env, day: u64, total: i128) {
        if total == 0 {
            env.storage().instance().remove(&DataKey::DailyWithdrawn);
        } else {
            env.storage()
                .instance()
                .set(&DataKey::DailyWithdrawn, &(day, total));
        }
    }

    /// Begins a two-step handover of the admin address. Unlike a naive
    /// single-step reassignment, this requires the *proposed new admin* to
    /// also authorize the call — a typo'd or unreachable address can never
    /// silently become admin, since it would have to co-sign its own
    /// appointment.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `new_admin` - The address to become the new admin
    ///
    /// # Authorization (Issue #426 - Part 5 - Complete NatSpec)
    /// Requires auth from BOTH the current admin (`DataKey::Admin`) and
    /// `new_admin` itself — matching `grant_role`/`revoke_role`'s pattern of
    /// panicking (via `require_auth`) on an authorization failure, rather
    /// than returning a `Result`.
    ///
    /// # Role handover (Issue #394 - Part 2)
    /// `init` grants the admin `Role::Admin`, so the handover moves that role
    /// too: the outgoing admin's `Admin` role is revoked and `new_admin` is
    /// granted it. Previously the old admin kept `Role::Admin` after the
    /// transfer and could still pause, rescue tokens and change withdraw
    /// limits. A non-`Admin` role the outgoing admin holds is left alone,
    /// and transferring to the current admin changes nothing.
    ///
    /// # Events (Issue #428 - Part 5)
    /// Emits `role_revoked` for the old admin (if it held `Admin`),
    /// `role_granted` for `new_admin` (if its role changed), then
    /// topics=[Symbol("admin_transferred"), old_admin, new_admin], value=()
    ///
    /// # Security
    /// Two-step authorization prevents accidental admin lockout from typos or
    /// unreachable addresses.
    ///
    /// # Panics
    /// Panics if called before `init`, or if either `require_auth()` fails.
    pub fn transfer_admin(env: Env, new_admin: Address) {
        let current_admin: Address = Self::load_config(&env).admin;
        current_admin.require_auth();
        new_admin.require_auth();
        Self::require_not_decommissioned(&env);

        if current_admin != new_admin
            && Self::get_role(env.clone(), current_admin.clone()) == Some(Role::Admin)
        {
            Self::remove_role(&env, current_admin.clone(), "role_revoked");
        }
        Self::store_role(&env, new_admin.clone(), Role::Admin);

        let mut cfg = Self::load_config(&env);
        cfg.admin = new_admin.clone();
        Self::save_config(&env, &cfg);
        Self::extend_instance_ttl(&env);

        // Emit admin transfer event (Issue #428 - Part 5)
        env.events().publish(
            (
                Symbol::new(&env, "admin_transferred"),
                current_admin,
                new_admin,
            ),
            (),
        );
    }

    /// Grants a role to an address.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `address` - The address to grant the role to
    /// * `role` - The role to grant (Admin, Operator, or Viewer)
    ///
    /// # Authorization (Issue #426 - Part 5 - Complete NatSpec)
    /// Only the admin can call this function.
    ///
    /// # Storage (Issue #415 - Part 4)
    /// Stored under a per-address persistent key (`DataKey::UserRole`)
    /// rather than in a single growing `Map` — see the `DataKey::UserRole`
    /// doc comment for why. The entry's TTL is extended via
    /// `extend_role_ttl`, which only performs the write when the entry's
    /// remaining TTL has actually dropped below the threshold, so
    /// re-granting a role to the same address repeatedly doesn't re-bill
    /// rent on every call.
    ///
    /// # Events (Issue #428 - Part 5, Issue #635)
    /// Emits: topics=[Symbol("role_granted"), address, role], value=role —
    /// only when the address's stored role actually changes (Issue #398 - Part 2).
    ///
    /// # Panics
    /// Panics if called before `init`, or if `admin.require_auth()` fails.
    pub fn grant_role(env: Env, address: Address, role: Role) {
        let admin: Address = Self::load_config(&env).admin;
        admin.require_auth();
        Self::require_not_decommissioned(&env);

        Self::store_role(&env, address, role);
    }

    /// Grants the same role to several addresses in a single call.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `addresses` - The addresses to grant the role to
    /// * `role` - The role to grant (Admin, Operator, or Viewer)
    ///
    /// # Authorization
    /// Only the admin can call this function.
    ///
    /// # Notes
    /// Equivalent to calling `grant_role` once per address. Each address
    /// still gets its own per-address persistent write (see
    /// `DataKey::UserRole`), but instance storage's TTL is extended once
    /// for the whole batch instead of once per address. An empty
    /// `addresses` list is a no-op.
    ///
    /// # Events
    /// Emits one `role_granted` event per address whose role actually
    /// changed, matching `grant_role`.
    pub fn grant_roles(env: Env, addresses: Vec<Address>, role: Role) {
        let admin: Address = Self::load_config(&env).admin;
        admin.require_auth();
        Self::require_not_decommissioned(&env);

        for address in addresses.iter() {
            Self::store_role(&env, address, role);
        }

        Self::extend_instance_ttl(&env);
    }

    /// Assigns `role` to `address` and emits `role_granted` — shared by
    /// `grant_role` and `grant_roles` so both follow the same rules.
    ///
    /// # Events (Issue #398 - Part 2)
    /// The event is only emitted when the stored role actually changes.
    /// Re-granting the role an address already holds still refreshes the
    /// entry's TTL, but is not reported as a new grant.
    ///
    /// # Storage (Issue #395 - Part 2)
    /// Re-granting an unchanged role skips the `set`: rewriting an identical
    /// value is a full ledger-entry write (billed per entry and per byte) for
    /// no state change. Only the threshold-gated TTL extension runs.
    fn store_role(env: &Env, address: Address, role: Role) {
        let key = DataKey::UserRole(address.clone());
        let previous: Option<Role> = env.storage().persistent().get(&key);
        if previous != Some(role) {
            env.storage().persistent().set(&key, &role);
        }
        Self::extend_role_ttl(env, &key);

        if previous != Some(role) {
            // Emit role granted event (Issue #428 - Part 5, Issue #635).
            // Topics carry the role so indexers can filter grants by role
            // without decoding the data payload; the data payload keeps the
            // role as well for existing consumers.
            env.events()
                .publish((Symbol::new(env, "role_granted"), address, role), role);
        }
    }

    /// Deletes `address`'s role entry and emits `event` (`role_revoked` or
    /// `role_renounced`) — shared by `revoke_role`, `renounce_role` and
    /// `transfer_admin` so all three apply the same no-op rule.
    ///
    /// # Returns
    /// `true` if a role was removed; `false` (and no event) if `address`
    /// held no role.
    fn remove_role(env: &Env, address: Address, event: &str) -> bool {
        let key = DataKey::UserRole(address.clone());
        let role: Role = match env.storage().persistent().get(&key) {
            Some(r) => r,
            None => return false,
        };
        env.storage().persistent().remove(&key);
        // Issue #635: the revoked role is a topic so the on-chain audit
        // trail records which role was taken away, not just that one was.
        env.events()
            .publish((Symbol::new(env, event), address, role), ());
        true
    }

    /// Revokes a role from an address.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `address` - The address to revoke the role from
    ///
    /// # Authorization (Issue #426 - Part 5 - Complete NatSpec)
    /// Only the admin can call this function.
    ///
    /// # Events (Issue #428 - Part 5, Issue #635)
    /// Emits: topics=[Symbol("role_revoked"), address, role], value=()
    ///
    /// # Panics
    /// Panics if called before `init`, or if `admin.require_auth()` fails.
    /// Revoking a role from an address that never had one is a no-op, not
    /// a panic (see `test_revoke_nonexistent_role_is_noop`).
    pub fn revoke_role(env: Env, address: Address) {
        let admin: Address = Self::load_config(&env).admin;
        admin.require_auth();
        Self::require_not_decommissioned(&env);

        // Emit role revoked event (Issue #428 - Part 5)
        Self::remove_role(&env, address, "role_revoked");
    }

    /// Allows the caller to give up their own role, without requiring the
    /// admin to call `revoke_role` on their behalf.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `caller` - The address renouncing its own role (must authorize this call)
    ///
    /// # Authorization (Issue #414 - Part 4)
    /// Requires only `caller.require_auth()` — no admin approval, since an
    /// account can always give up a privilege it already holds. This is
    /// the standard access-control self-service primitive: it lets an
    /// address that suspects its key is compromised, or that is
    /// deliberately stepping down, drop its own role immediately instead
    /// of waiting on the admin to call `revoke_role`.
    ///
    /// # Events
    /// Emits: topics=[Symbol("role_renounced"), caller], value=() — only
    /// when the caller actually held a role (Issue #398 - Part 2).
    ///
    /// # Notes
    /// Renouncing a role the caller doesn't hold is a no-op, matching
    /// `revoke_role`'s behaviour for an address with no assigned role.
    /// Because the contract's ultimate authority (`DataKey::Admin`) is a
    /// separate, independent identity from the `Role` system (see
    /// `rescue_tokens`'s doc comment), an address renouncing `Role::Admin`
    /// can never lock the contract out of RBAC administration — the
    /// stored admin can always call `grant_role` again.
    ///
    /// # Panics
    /// Panics if `caller.require_auth()` fails.
    pub fn renounce_role(env: Env, caller: Address) {
        caller.require_auth();

        // Issue #398 (Part 2): renouncing a role that isn't held changes
        // nothing, so — like `revoke_role` — it must not emit an event that
        // an indexer would record as a real role change.
        Self::remove_role(&env, caller, "role_renounced");
    }

    /// Retrieves the role assigned to an address.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `address` - The address to query
    ///
    /// # Returns
    /// `Some(role)` if a role is assigned, `None` otherwise
    pub fn get_role(env: Env, address: Address) -> Option<Role> {
        env.storage().persistent().get(&DataKey::UserRole(address))
    }

    /// Checks if an address has at least the specified role or higher.
    ///
    /// This is a pure query of the role entries. Access checks inside the
    /// contract go through `has_authority`, which additionally treats the
    /// stored admin as `Admin`; so `has_role(admin, ..)` can be `false`
    /// after the admin renounced its role while the admin can still act.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `address` - The address to check
    /// * `required_role` - The minimum required role
    ///
    /// # Returns
    /// `true` if the address has the required role or higher
    ///
    /// # Hierarchy
    /// Admin > Operator > Viewer
    pub fn has_role(env: Env, address: Address, required_role: Role) -> bool {
        match env
            .storage()
            .persistent()
            .get::<_, Role>(&DataKey::UserRole(address))
        {
            Some(user_role) => Self::is_role_sufficient(&user_role, &required_role),
            None => false,
        }
    }

    /// Checks whether a user role satisfies a required role level.
    ///
    /// # Arguments
    /// * `user_role` - The role assigned to the user
    /// * `required_role` - The minimum role being checked against
    ///
    /// # Returns
    /// `true` if `user_role` meets or exceeds `required_role` in the hierarchy
    ///
    /// # Hierarchy
    /// Admin > Operator > Viewer
    fn is_role_sufficient(user_role: &Role, required_role: &Role) -> bool {
        Self::role_rank(user_role) >= Self::role_rank(required_role)
    }

    /// Returns a role's privilege level; a higher number is more privileged.
    ///
    /// Keeping the hierarchy as one ordered table means a future role only
    /// needs a rank here, instead of a new arm in every pairwise match.
    fn role_rank(role: &Role) -> u32 {
        match role {
            Role::Viewer => 1,
            Role::Operator => 2,
            Role::Admin => 3,
        }
    }

    /// Sets treasury splits for payment routing (Issue #679).
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `caller` - The address setting the splits (must authorize and be admin)
    /// * `splits` - Vector of TreasurySplit entries; percentages must sum to 100
    ///
    /// # Authorization
    /// Requires `caller` to hold the `Admin` role.
    ///
    /// # Errors
    /// * `InvalidTreasurySplits` - If percentages don't sum to 100 or list is empty
    ///
    /// # Events
    /// Emits: topics=[Symbol("treasury_splits_set"), caller], value=splits
    pub fn set_treasury_splits(env: Env, caller: Address, splits: Vec<TreasurySplit>) -> Result<(), Error> {
        caller.require_auth();
        if !Self::has_admin_authority(&env, &caller) {
            panic!("set_treasury_splits requires the Admin role");
        }

        if splits.is_empty() {
            return Err(Error::InvalidTreasurySplits);
        }

        let total_percentage: u32 = splits
            .iter()
            .fold(0u32, |acc, split| acc.saturating_add(split.percentage));
        if total_percentage != 100 {
            return Err(Error::InvalidTreasurySplits);
        }

        env.storage().instance().set(&DataKey::TreasurySplits, &splits);
        Self::extend_instance_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "treasury_splits_set"), caller),
            splits,
        );
        Ok(())
    }

    /// Clears treasury splits, returning to single treasury mode (Issue #679).
    ///
    /// # Authorization
    /// Requires `caller` to hold the `Admin` role.
    ///
    /// # Events
    /// Emits: topics=[Symbol("treasury_splits_cleared"), caller], value=()
    pub fn clear_treasury_splits(env: Env, caller: Address) {
        caller.require_auth();
        if !Self::has_admin_authority(&env, &caller) {
            panic!("clear_treasury_splits requires the Admin role");
        }

        env.storage().instance().remove(&DataKey::TreasurySplits);
        Self::extend_instance_ttl(&env);

        env.events().publish(
            (Symbol::new(&env, "treasury_splits_cleared"), caller),
            (),
        );
    }

    /// Returns the treasury splits, or None in single-treasury mode (Issue #679).
    pub fn get_treasury_splits(env: Env) -> Option<Vec<TreasurySplit>> {
        env.storage().instance().get(&DataKey::TreasurySplits)
    }

    /// Permanently decommissions the contract — the emergency killswitch
    /// (Issue #671).
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `extra_tokens` - Additional token contracts (beyond the configured
    ///   USDC and XLM SACs) whose residual balance should also be swept
    ///
    /// # Authorization
    /// Only the stored admin can call this function.
    ///
    /// # Effects
    /// 1. Writes `DataKey::Decommissioned` and `DataKey::Paused`; neither is
    ///    ever cleared, so the pause becomes irreversible (`unpause` panics).
    /// 2. Sweeps the contract's full balance of USDC, XLM and every
    ///    `extra_tokens` entry to the configured treasury. Zero balances are
    ///    skipped. The sweep runs under the reentrancy guard and ignores
    ///    `rescue_tokens`'s withdraw limits, since this is a one-time exit.
    ///
    /// After this call `pay_usdc`/`pay_xlm` return `ContractDecommissioned`
    /// and every administrative entrypoint panics.
    ///
    /// # Events
    /// Emits: topics=[Symbol("contract_decommissioned"), admin],
    /// value=ledger timestamp
    ///
    /// # Panics
    /// Panics if called before `init`, if `admin.require_auth()` fails, if
    /// the contract is already decommissioned, or if a sweep transfer fails.
    pub fn decommission(env: Env, extra_tokens: Vec<Address>) {
        let admin: Address = Self::load_config(&env).admin;
        admin.require_auth();
        Self::require_not_decommissioned(&env);

        // Effects before interactions: lock the contract first so a token
        // callback during the sweep can't reach any live entrypoint.
        env.storage().instance().set(&DataKey::Decommissioned, &true);
        let mut cfg = Self::load_config(&env);
        cfg.paused = true;
        Self::save_config(&env, &cfg);
        Self::extend_instance_ttl(&env);

        let treasury: Address = Self::load_config(&env).treasury;
        let mut tokens: Vec<Address> = Vec::new(&env);
        tokens.push_back(env.storage().instance().get(&DataKey::UsdcContract).unwrap());
        tokens.push_back(env.storage().instance().get(&DataKey::XlmContract).unwrap());
        for token_contract in extra_tokens.iter() {
            if !tokens.contains(&token_contract) {
                tokens.push_back(token_contract);
            }
        }

        let contract_address = env.current_contract_address();
        Self::with_reentrancy_guard(&env, || {
            for token_contract in tokens.iter() {
                let client = token::Client::new(&env, &token_contract);
                let balance = client.balance(&contract_address);
                if balance > 0 {
                    client.transfer(&contract_address, &treasury, &balance);
                }
            }
        });

        env.events().publish(
            (Symbol::new(&env, "contract_decommissioned"), admin),
            env.ledger().timestamp(),
        );
    }

    /// Returns whether the contract has been permanently decommissioned.
    pub fn is_decommissioned_view(env: Env) -> bool {
        Self::is_decommissioned(&env)
    }

    fn is_decommissioned(env: &Env) -> bool {
        env.storage()
            .instance()
            .get::<_, bool>(&DataKey::Decommissioned)
            .unwrap_or(false)
    }

    /// Panics once `decommission` has run, locking out every admin action.
    fn require_not_decommissioned(env: &Env) {
        if Self::is_decommissioned(env) {
            panic!("contract is decommissioned");
        }
    }

    /// Returns whether `caller` has at least `required` authority (Issue #394
    /// - Part 2).
    ///
    /// The single access check used by every role-gated entrypoint
    /// (`pause`, `rescue_tokens`, `set_withdraw_limits`). The stored admin
    /// (`DataKey::Admin`) always passes: it is the contract's root of trust,
    /// so renouncing or losing its role entry must not lock it out of
    /// operations the role system otherwise grants to `Admin`.
    ///
    /// Does not call `require_auth`; callers do that first so an
    /// unauthenticated call fails on the signature, not the role.
    ///
    /// # Panics
    /// Panics if called before `init` (no stored admin yet).
    fn has_authority(env: &Env, caller: &Address, required: Role) -> bool {
        let stored_admin: Address = Self::load_config(&env).admin;
        *caller == stored_admin || Self::has_role(env.clone(), caller.clone(), required)
    }

    /// Sets a fee discount for an account.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `caller` - The address setting the discount (must authorize this call)
    /// * `account` - The address to receive the discount
    /// * `discount_bps` - Discount in basis points (0-10000, where 10000 = 100%)
    ///
    /// # Authorization
    /// Requires `caller` to hold at least the `Operator` role (or be the stored admin).
    ///
    /// # Errors
    /// * `InvalidDiscount` - If `discount_bps` exceeds 10000 (100%)
    ///
    /// # Storage
    /// Stored under `DataKey::Discounts`; a zero discount removes the entry.
    ///
    /// # Panics
    /// Panics if `caller` does not hold at least the `Operator` role, or if
    /// `caller.require_auth()` fails.
    pub fn set_discount(
        env: Env,
        caller: Address,
        account: Address,
        discount_bps: u32,
    ) -> Result<(), Error> {
        caller.require_auth();
        if !Self::has_authority(&env, &caller, Role::Operator) {
            panic!("set_discount requires at least the Operator role");
        }
        if discount_bps > 10000 {
            return Err(Error::InvalidDiscount);
        }

        let key = DataKey::Discounts(account.clone());
        if discount_bps == 0 {
            // Remove entry to save storage when discount is zero
            env.storage().persistent().remove(&key);
        } else {
            env.storage().persistent().set(&key, &discount_bps);
            // Extend TTL following the same pattern as role entries
            env.storage()
                .persistent()
                .extend_ttl(&key, INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_MAX);
        }
        Self::extend_instance_ttl(&env);
        Ok(())
    }

    /// Retrieves the discount assigned to an account.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `account` - The address to query
    ///
    /// # Returns
    /// Discount in basis points (0-10000), or 0 if no discount is assigned
    pub fn get_discount(env: Env, account: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::Discounts(account))
            .unwrap_or(0)
    }

    /// Calculates the payment amount after applying the account's discount.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `account` - The payer address
    /// * `amount` - The original payment amount
    ///
    /// # Returns
    /// Net amount after discount (amount - (amount * discount_bps / 10000)).
    /// Splitting amount into quotient and remainder avoids overflowing the
    /// intermediate product for large, otherwise valid payment amounts.
    fn apply_discount(env: &Env, account: &Address, amount: i128) -> Result<i128, Error> {
        let discount_bps = env
            .storage()
            .persistent()
            .get::<DataKey, u32>(&DataKey::Discounts(account.clone()))
            .unwrap_or(0);

        if discount_bps == 0 {
            return Ok(amount);
        }

        let basis_points = i128::from(discount_bps);
        let discount = (amount / 10_000)
            .checked_mul(basis_points)
            .and_then(|whole| {
                (amount % 10_000)
                    .checked_mul(basis_points)
                    .and_then(|fraction| whole.checked_add(fraction / 10_000))
            })
            .ok_or(Error::ArithmeticOverflow)?;
        amount
            .checked_sub(discount)
            .ok_or(Error::ArithmeticOverflow)
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::{
        testutils::{
            Address as _, AuthorizedFunction, AuthorizedInvocation, Events, IssuerFlags,
            Ledger as _, MockAuth, MockAuthInvoke,
        },
        token, Bytes, Env, IntoVal, Symbol, TryIntoVal,
    };

    // ── Test fixture ──────────────────────────────────────────────────────────

    struct Fixture {
        env: Env,
        contract_id: Address,
        admin: Address,
        treasury: Address,
        payer: Address,
        usdc: Address,
        xlm_sac: Address,
    }

    impl Fixture {
        fn new() -> Self {
            let env = Env::default();
            env.mock_all_auths();

            let admin = Address::generate(&env);
            let treasury = Address::generate(&env);
            let payer = Address::generate(&env);

            // Register mock SAC token contracts for USDC and XLM
            let usdc = env
                .register_stellar_asset_contract_v2(admin.clone())
                .address();
            let xlm_sac = env
                .register_stellar_asset_contract_v2(admin.clone())
                .address();

            let contract_id = env.register(Stellar_CardReceiver, ());

            Fixture {
                env,
                contract_id,
                admin,
                treasury,
                payer,
                usdc,
                xlm_sac,
            }
        }

        fn client(&self) -> Stellar_CardReceiverClient<'_> {
            Stellar_CardReceiverClient::new(&self.env, &self.contract_id)
        }

        fn init(&self) {
            self.client()
                .init(&self.admin, &self.treasury, &self.usdc, &self.xlm_sac);
        }

        fn mint_usdc(&self, to: &Address, amount: i128) {
            token::StellarAssetClient::new(&self.env, &self.usdc).mint(to, &amount);
        }

        fn mint_xlm(&self, to: &Address, amount: i128) {
            token::StellarAssetClient::new(&self.env, &self.xlm_sac).mint(to, &amount);
        }

        fn usdc_balance(&self, addr: &Address) -> i128 {
            token::Client::new(&self.env, &self.usdc).balance(addr)
        }

        fn xlm_balance(&self, addr: &Address) -> i128 {
            token::Client::new(&self.env, &self.xlm_sac).balance(addr)
        }
    }

    fn order_bytes(env: &Env, s: &str) -> Bytes {
        Bytes::from_slice(env, s.as_bytes())
    }

    fn contract_event_count(env: &Env, contract_id: &Address, name: &str) -> u32 {
        let symbol = Symbol::new(env, name);
        let mut count = 0;
        for (event_contract, topics, _) in env.events().all().iter() {
            if event_contract != *contract_id {
                continue;
            }
            let event_symbol: Symbol = topics.get(0).unwrap().try_into_val(env).unwrap();
            if event_symbol == symbol {
                count += 1;
            }
        }
        count
    }

    // ── blacklist tests (#661) ────────────────────────────────────────────────

    #[test]
    fn test_blacklisted_payer_cannot_pay_usdc_or_xlm() {
        let f = Fixture::new();
        f.init();
        f.mint_usdc(&f.payer, 1_000);
        f.mint_xlm(&f.payer, 1_000);

        f.client().set_blacklisted(&f.admin, &f.payer, &true);
        assert!(f.client().is_blacklisted_view(&f.payer));

        assert_eq!(
            f.client()
                .try_pay_usdc(&f.payer, &100, &order_bytes(&f.env, "o1")),
            Err(Ok(Error::AddressBlacklisted))
        );
        assert_eq!(
            f.client()
                .try_pay_xlm(&f.payer, &100, &order_bytes(&f.env, "o2")),
            Err(Ok(Error::AddressBlacklisted))
        );
        assert_eq!(f.usdc_balance(&f.payer), 1_000);
        assert_eq!(f.xlm_balance(&f.payer), 1_000);
        assert_eq!(f.usdc_balance(&f.treasury), 0);
    }

    #[test]
    fn test_blacklist_only_blocks_the_flagged_address() {
        let f = Fixture::new();
        f.init();
        let other = Address::generate(&f.env);
        f.mint_usdc(&other, 500);

        f.client().set_blacklisted(&f.admin, &f.payer, &true);
        f.client()
            .pay_usdc(&other, &200, &order_bytes(&f.env, "ok"));
        assert_eq!(f.usdc_balance(&f.treasury), 200);
    }

    #[test]
    fn test_unblacklisted_payer_can_pay_again() {
        let f = Fixture::new();
        f.init();
        f.mint_usdc(&f.payer, 1_000);

        f.client().set_blacklisted(&f.admin, &f.payer, &true);
        f.client().set_blacklisted(&f.admin, &f.payer, &false);
        assert!(!f.client().is_blacklisted_view(&f.payer));

        f.client()
            .pay_usdc(&f.payer, &300, &order_bytes(&f.env, "again"));
        assert_eq!(f.usdc_balance(&f.treasury), 300);
    }

    #[test]
    fn test_operator_can_set_blacklisted() {
        let f = Fixture::new();
        f.init();
        let operator = Address::generate(&f.env);
        f.client().grant_role(&operator, &Role::Operator);

        f.client().set_blacklisted(&operator, &f.payer, &true);
        assert!(f.client().is_blacklisted_view(&f.payer));
    }

    #[test]
    #[should_panic(expected = "set_blacklisted requires at least the Operator role")]
    fn test_viewer_cannot_set_blacklisted() {
        let f = Fixture::new();
        f.init();
        let viewer = Address::generate(&f.env);
        f.client().grant_role(&viewer, &Role::Viewer);
        f.client().set_blacklisted(&viewer, &f.payer, &true);
    }

    #[test]
    #[should_panic(expected = "set_blacklisted requires at least the Operator role")]
    fn test_address_without_role_cannot_set_blacklisted() {
        let f = Fixture::new();
        f.init();
        let stranger = Address::generate(&f.env);
        f.client().set_blacklisted(&stranger, &f.payer, &true);
    }

    #[test]
    fn test_blacklist_events_only_on_state_changes() {
        // `env.events().all()` reflects the most recent invocation only, so
        // each call is checked on its own.
        let f = Fixture::new();
        f.init();
        let count = |name: &str| contract_event_count(&f.env, &f.contract_id, name);

        f.client().set_blacklisted(&f.admin, &f.payer, &true);
        assert_eq!(count("address_blacklisted"), 1);
        f.client().set_blacklisted(&f.admin, &f.payer, &true);
        assert_eq!(count("address_blacklisted"), 0);

        f.client().set_blacklisted(&f.admin, &f.payer, &false);
        assert_eq!(count("address_unblacklisted"), 1);
        f.client().set_blacklisted(&f.admin, &f.payer, &false);
        assert_eq!(count("address_unblacklisted"), 0);
    }

    #[test]
    fn test_pause_takes_precedence_over_blacklist() {
        let f = Fixture::new();
        f.init();
        f.client().set_blacklisted(&f.admin, &f.payer, &true);
        f.client().pause(&f.admin);
        assert_eq!(
            f.client()
                .try_pay_usdc(&f.payer, &1, &order_bytes(&f.env, "p")),
            Err(Ok(Error::ContractPaused))
        );
    }

    // ── init tests ────────────────────────────────────────────────────────────

    #[test]
    fn test_init_stores_all_addresses() {
        let f = Fixture::new();
        f.init();

        let client = f.client();
        assert_eq!(client.treasury(), f.treasury);
        assert_eq!(client.usdc_contract(), f.usdc);
        assert_eq!(client.xlm_contract(), f.xlm_sac);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_init_twice_panics() {
        let f = Fixture::new();
        f.init();
        f.init(); // must panic
    }

    #[test]
    fn test_init_requires_admin_authorization() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let xlm_sac = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let contract_id = env.register(Stellar_CardReceiver, ());
        let client = Stellar_CardReceiverClient::new(&env, &contract_id);

        assert!(client
            .try_init(&admin, &treasury, &usdc, &xlm_sac)
            .is_err());
        assert!(client.try_admin().is_err());
        assert_eq!(contract_event_count(&env, &contract_id, "init"), 0);
    }

    #[test]
    fn test_init_rejects_invalid_address_combinations_without_writing_state() {
        let f = Fixture::new();
        let client = f.client();

        assert!(client
            .try_init(&f.contract_id, &f.treasury, &f.usdc, &f.xlm_sac)
            .is_err());
        assert!(client
            .try_init(&f.admin, &f.contract_id, &f.usdc, &f.xlm_sac)
            .is_err());
        assert!(client
            .try_init(&f.admin, &f.treasury, &f.usdc, &f.usdc)
            .is_err());
        assert!(client
            .try_init(&f.admin, &f.usdc, &f.usdc, &f.xlm_sac)
            .is_err());

        assert!(client.try_admin().is_err());
    }

    // ── init parameter validation (issue #399) ────────────────────────────────

    /// A contract that answers `decimals()` like a token but with a precision
    /// other than the 7 every Stellar Asset Contract uses.
    mod six_decimal_token {
        use soroban_sdk::{contract, contractimpl, Env};

        #[contract]
        pub struct SixDecimalToken;

        #[contractimpl]
        impl SixDecimalToken {
            pub fn decimals(_env: Env) -> u32 {
                6
            }
        }
    }

    /// A contract with no token interface at all.
    mod not_a_token {
        use soroban_sdk::{contract, contractimpl, Env};

        #[contract]
        pub struct NotAToken;

        #[contractimpl]
        impl NotAToken {
            pub fn hello(_env: Env) -> u32 {
                1
            }
        }
    }

    #[test]
    #[should_panic(expected = "admin cannot be the contract itself")]
    fn test_init_rejects_contract_as_admin() {
        let f = Fixture::new();
        f.client()
            .init(&f.contract_id, &f.treasury, &f.usdc, &f.xlm_sac);
    }

    #[test]
    #[should_panic(expected = "treasury cannot be the contract itself")]
    fn test_init_rejects_contract_as_treasury() {
        let f = Fixture::new();
        f.client()
            .init(&f.admin, &f.contract_id, &f.usdc, &f.xlm_sac);
    }

    #[test]
    #[should_panic(expected = "usdc_contract cannot be the contract itself")]
    fn test_init_rejects_contract_as_usdc() {
        let f = Fixture::new();
        f.client()
            .init(&f.admin, &f.treasury, &f.contract_id, &f.xlm_sac);
    }

    #[test]
    #[should_panic(expected = "xlm_contract cannot be the contract itself")]
    fn test_init_rejects_contract_as_xlm() {
        let f = Fixture::new();
        f.client()
            .init(&f.admin, &f.treasury, &f.usdc, &f.contract_id);
    }

    #[test]
    fn test_init_accepts_admin_as_treasury() {
        let f = Fixture::new();
        f.client().init(&f.admin, &f.admin, &f.usdc, &f.xlm_sac);
        assert_eq!(f.client().admin(), f.admin);
        assert_eq!(f.client().treasury(), f.admin);
    }

    #[test]
    #[should_panic(expected = "admin cannot be a configured token contract")]
    fn test_init_rejects_usdc_contract_as_admin() {
        let f = Fixture::new();
        f.client().init(&f.usdc, &f.treasury, &f.usdc, &f.xlm_sac);
    }

    #[test]
    #[should_panic(expected = "admin cannot be a configured token contract")]
    fn test_init_rejects_xlm_contract_as_admin() {
        let f = Fixture::new();
        f.client()
            .init(&f.xlm_sac, &f.treasury, &f.usdc, &f.xlm_sac);
    }

    #[test]
    #[should_panic(expected = "usdc_contract and xlm_contract must be different")]
    fn test_init_rejects_same_token_for_usdc_and_xlm() {
        let f = Fixture::new();
        f.client().init(&f.admin, &f.treasury, &f.usdc, &f.usdc);
    }

    #[test]
    #[should_panic(expected = "treasury cannot be a configured token contract")]
    fn test_init_rejects_usdc_contract_as_treasury() {
        let f = Fixture::new();
        f.client().init(&f.admin, &f.usdc, &f.usdc, &f.xlm_sac);
    }

    #[test]
    #[should_panic(expected = "treasury cannot be a configured token contract")]
    fn test_init_rejects_xlm_contract_as_treasury() {
        let f = Fixture::new();
        f.client().init(&f.admin, &f.xlm_sac, &f.usdc, &f.xlm_sac);
    }

    #[test]
    #[should_panic(expected = "usdc_contract does not implement the token interface")]
    fn test_init_rejects_usdc_contract_without_token_interface() {
        let f = Fixture::new();
        let not_token = f.env.register(not_a_token::NotAToken, ());
        f.client()
            .init(&f.admin, &f.treasury, &not_token, &f.xlm_sac);
    }

    #[test]
    #[should_panic(expected = "xlm_contract does not implement the token interface")]
    fn test_init_rejects_xlm_contract_without_token_interface() {
        let f = Fixture::new();
        let not_token = f.env.register(not_a_token::NotAToken, ());
        f.client().init(&f.admin, &f.treasury, &f.usdc, &not_token);
    }

    #[test]
    #[should_panic(expected = "usdc_contract does not implement the token interface")]
    fn test_init_rejects_account_address_as_usdc_contract() {
        // Soroban Address has no null sentinel. A plain account address is
        // rejected here because token parameters must identify token contracts.
        let f = Fixture::new();
        let account = Address::generate(&f.env);
        f.client().init(&f.admin, &f.treasury, &account, &f.xlm_sac);
    }

    #[test]
    #[should_panic(expected = "usdc_contract must use 7 decimals")]
    fn test_init_rejects_usdc_contract_with_wrong_decimals() {
        let f = Fixture::new();
        let token = f.env.register(six_decimal_token::SixDecimalToken, ());
        f.client().init(&f.admin, &f.treasury, &token, &f.xlm_sac);
    }

    #[test]
    #[should_panic(expected = "xlm_contract must use 7 decimals")]
    fn test_init_rejects_xlm_contract_with_wrong_decimals() {
        let f = Fixture::new();
        let token = f.env.register(six_decimal_token::SixDecimalToken, ());
        f.client().init(&f.admin, &f.treasury, &f.usdc, &token);
    }

    #[test]
    fn test_failed_init_leaves_contract_uninitialized_and_retryable() {
        let f = Fixture::new();
        let client = f.client();
        let token = f.env.register(six_decimal_token::SixDecimalToken, ());

        // Rejections from both phases: an address check and a token probe.
        assert!(client
            .try_init(&f.usdc, &f.treasury, &f.usdc, &f.xlm_sac)
            .is_err());
        assert!(client
            .try_init(&f.admin, &f.treasury, &f.usdc, &token)
            .is_err());

        // Nothing was written: no admin, no role, no init event.
        assert!(client.try_admin().is_err());
        assert!(client.try_treasury().is_err());
        assert_eq!(client.get_role(&f.admin), None);
        assert_eq!(contract_event_count(&f.env, &f.contract_id, "init"), 0);

        // A corrected call still succeeds, since "already initialized" was
        // never tripped.
        f.init();
        assert_eq!(client.admin(), f.admin);
        assert_eq!(client.get_role(&f.admin), Some(Role::Admin));
    }

    // ── native-asset validation (issue #389) ──────────────────────────────────

    /// Deploys the native XLM Stellar Asset Contract. XDR `Asset::Native` is
    /// its 4-byte discriminant, 0.
    fn register_native_sac(env: &Env) -> Address {
        env.deployer()
            .with_stellar_asset(Bytes::from_array(env, &[0u8; 4]))
            .deploy()
    }

    /// A 7-decimal token that doesn't implement `name()`.
    mod seven_decimal_token_without_name {
        use soroban_sdk::{contract, contractimpl, Env};

        #[contract]
        pub struct NamelessToken;

        #[contractimpl]
        impl NamelessToken {
            pub fn decimals(_env: Env) -> u32 {
                7
            }
        }
    }

    #[test]
    #[should_panic(expected = "usdc_contract cannot be the native XLM asset contract")]
    fn test_init_rejects_native_xlm_sac_as_usdc_contract() {
        // Both SACs report 7 decimals, so only the native-asset check can
        // catch USDC and XLM being passed in swapped order.
        let f = Fixture::new();
        let native = register_native_sac(&f.env);
        f.client().init(&f.admin, &f.treasury, &native, &f.usdc);
    }

    #[test]
    fn test_init_accepts_native_xlm_sac_as_xlm_contract() {
        let f = Fixture::new();
        let native = register_native_sac(&f.env);
        f.client().init(&f.admin, &f.treasury, &f.usdc, &native);
        assert_eq!(f.client().xlm_contract(), native);
        assert_eq!(f.client().usdc_contract(), f.usdc);
    }

    #[test]
    fn test_init_accepts_usdc_contract_without_name() {
        // `name()` is only consulted to spot the native asset; the decimals
        // probe alone decides whether an address is a token.
        let f = Fixture::new();
        let token = f
            .env
            .register(seven_decimal_token_without_name::NamelessToken, ());
        f.client().init(&f.admin, &f.treasury, &token, &f.xlm_sac);
        assert_eq!(f.client().usdc_contract(), token);
    }

    #[test]
    fn test_swapped_token_init_leaves_contract_uninitialized_and_retryable() {
        let f = Fixture::new();
        let client = f.client();
        let native = register_native_sac(&f.env);

        assert!(client
            .try_init(&f.admin, &f.treasury, &native, &f.usdc)
            .is_err());
        assert!(client.try_admin().is_err());
        assert_eq!(contract_event_count(&f.env, &f.contract_id, "init"), 0);

        client.init(&f.admin, &f.treasury, &f.usdc, &native);
        assert_eq!(client.xlm_contract(), native);
    }

    #[test]
    fn test_init_accepts_a_contract_address_as_treasury() {
        // The treasury only receives transfers, so a contract (e.g. a
        // multisig or vault) is a valid treasury as long as it isn't one
        // of the configured tokens or this contract.
        let f = Fixture::new();
        let vault = f.env.register(not_a_token::NotAToken, ());
        f.client().init(&f.admin, &vault, &f.usdc, &f.xlm_sac);
        assert_eq!(f.client().treasury(), vault);
    }

    // ── pay_usdc tests ────────────────────────────────────────────────────────
    // Issue #423 (Part 5): Comprehensive unit tests for Soroban token transfer
    // functionality. Tests cover successful transfers, authorization, error
    // handling, reentrancy protection, pause behavior, and edge cases.

    #[test]
    fn test_pay_usdc_transfers_to_treasury() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 25_000_000; // 25.00 USDC (7 d.p.)
        f.mint_usdc(&f.payer, amount);

        let oid = order_bytes(&f.env, "a3f7c2d1-4e8b-4f0a-9c2d");
        f.client().pay_usdc(&f.payer, &amount, &oid);

        assert_eq!(f.usdc_balance(&f.treasury), amount);
        assert_eq!(f.usdc_balance(&f.payer), 0);
    }

    #[test]
    fn test_payment_rate_limit_is_configurable_and_defaults_to_ten_per_hundred_ledgers() {
        let f = Fixture::new();
        f.init();
        assert_eq!(f.client().payment_rate_limit(), (10, 100));

        f.client().set_payment_rate_limit(&f.admin, &3, &25);
        assert_eq!(f.client().payment_rate_limit(), (3, 25));
        assert_eq!(
            f.client().try_set_payment_rate_limit(&f.admin, &0, &25),
            Err(Ok(Error::InvalidRateLimit))
        );
    }

    #[test]
    fn test_payment_rate_limit_is_shared_across_assets_and_resets_after_window() {
        let f = Fixture::new();
        f.init();
        f.client().set_payment_rate_limit(&f.admin, &2, &3);
        f.mint_usdc(&f.payer, 2);
        f.mint_xlm(&f.payer, 1);

        f.client()
            .pay_usdc(&f.payer, &1, &order_bytes(&f.env, "rate-usdc-1"));
        f.client()
            .pay_xlm(&f.payer, &1, &order_bytes(&f.env, "rate-xlm-1"));
        assert_eq!(
            f.client()
                .try_pay_usdc(&f.payer, &1, &order_bytes(&f.env, "rate-blocked")),
            Err(Ok(Error::RateLimitExceeded))
        );

        f.env.ledger().with_mut(|ledger| {
            ledger.sequence_number += 3;
        });
        f.client()
            .pay_usdc(&f.payer, &1, &order_bytes(&f.env, "rate-reset"));
        assert_eq!(f.usdc_balance(&f.treasury), 2);
        assert_eq!(f.xlm_balance(&f.treasury), 1);
    }

    #[test]
    fn test_failed_payment_does_not_consume_rate_limit_slot() {
        let f = Fixture::new();
        f.init();
        f.client().set_payment_rate_limit(&f.admin, &1, &10);
        let order_id = order_bytes(&f.env, "failed-rate-payment");
        assert_eq!(
            f.client().try_pay_usdc(&f.payer, &1, &order_id),
            Err(Ok(Error::TransferFailed))
        );

        f.mint_usdc(&f.payer, 1);
        f.client().pay_usdc(&f.payer, &1, &order_id);
        assert_eq!(f.usdc_balance(&f.treasury), 1);
    }

    #[test]
    fn test_pay_usdc_emits_correct_event() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 10_000_000; // 10.00 USDC
        f.mint_usdc(&f.payer, amount);

        let oid = order_bytes(&f.env, "test-order-usdc");
        f.client().pay_usdc(&f.payer, &amount, &oid);

        // Scan events for our contract's pay_usdc event.
        // Events are (contract_id, topics: Vec<Val>, data: Val).
        // Val doesn't implement PartialEq — use try_into_val for typed comparison.
        let events = f.env.events().all();
        let mut found = false;
        for (contract_addr, topics, data) in events.iter() {
            if contract_addr != f.contract_id {
                continue;
            }
            let sym: Symbol = topics.get(0).unwrap().try_into_val(&f.env).unwrap();
            if sym != Symbol::new(&f.env, "pay_usdc") {
                continue;
            }
            let emitted_oid: Bytes = topics.get(1).unwrap().try_into_val(&f.env).unwrap();
            assert_eq!(emitted_oid, oid);
            let emitted_from: Address = topics.get(2).unwrap().try_into_val(&f.env).unwrap();
            assert_eq!(emitted_from, f.payer);
            let emitted_amount: i128 = data.try_into_val(&f.env).unwrap();
            assert_eq!(emitted_amount, amount);
            found = true;
            break;
        }
        assert!(found, "pay_usdc event not found");
    }

    #[test]
    fn test_pay_usdc_with_memo_emits_metadata_and_accepts_empty_metadata() {
        let f = Fixture::new();
        f.init();
        let amount = 100_i128;
        f.mint_usdc(&f.payer, amount * 2);

        let empty = Bytes::new(&f.env);
        f.client().pay_usdc_with_memo(
            &f.payer,
            &amount,
            &order_bytes(&f.env, "empty-metadata"),
            &empty,
        );
        let metadata = order_bytes(&f.env, "route-a");
        let order_id = order_bytes(&f.env, "tagged-metadata");
        f.client()
            .pay_usdc_with_memo(&f.payer, &amount, &order_id, &metadata);

        let (_, _, data) = f.env.events().all().last().unwrap();
        let (emitted_amount, emitted_metadata): (i128, Bytes) =
            data.try_into_val(&f.env).unwrap();
        assert_eq!(emitted_amount, amount);
        assert_eq!(emitted_metadata, metadata);
    }

    #[test]
    fn test_pay_xlm_with_memo_accepts_metadata_and_rejects_oversized_metadata() {
        let f = Fixture::new();
        f.init();
        let amount = 100_i128;
        f.mint_xlm(&f.payer, amount);
        let metadata = order_bytes(&f.env, "xlm-route");

        f.client().pay_xlm_with_memo(
            &f.payer,
            &amount,
            &order_bytes(&f.env, "xlm-metadata"),
            &metadata,
        );
        let (_, _, data) = f.env.events().all().last().unwrap();
        let (emitted_amount, emitted_metadata): (i128, Bytes) =
            data.try_into_val(&f.env).unwrap();
        assert_eq!(emitted_amount, amount);
        assert_eq!(emitted_metadata, metadata);

        let oversized = Bytes::from_slice(&f.env, &[0; 65]);
        assert_eq!(
            f.client().try_pay_xlm_with_memo(
                &f.payer,
                &amount,
                &order_bytes(&f.env, "oversized-metadata"),
                &oversized,
            ),
            Err(Ok(Error::InvalidMetadata))
        );
    }

    #[test]
    #[should_panic]
    fn test_pay_usdc_requires_auth() {
        let env = Env::default();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let payer = Address::generate(&env);
        let usdc = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let xlm_sac = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let contract_id = env.register(Stellar_CardReceiver, ());
        let client = Stellar_CardReceiverClient::new(&env, &contract_id);

        env.mock_all_auths();
        client.init(&admin, &treasury, &usdc, &xlm_sac);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let payer = Address::generate(&env);
        let usdc = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let xlm_sac = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let contract_id = env.register(Stellar_CardReceiver, ());
        let client = Stellar_CardReceiverClient::new(&env, &contract_id);

        env.mock_all_auths();
        client.init(&admin, &treasury, &usdc, &xlm_sac);

        // Remove the setup mock so this assertion exercises payer auth.
        env.mock_auths(&[]);
        let oid = order_bytes(&env, "order-no-auth");
        client.pay_usdc(&payer, &1_000_000_i128, &oid);
    }

    // ── pay_xlm tests ─────────────────────────────────────────────────────────
    // Issue #423 (Part 5): Tests for native XLM token transfer via Soroban SDK.
    // Verifies authorization, balance updates, event emission, and error paths.

    #[test]
    fn test_pay_xlm_transfers_to_treasury() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 161_290_000; // ~161.29 XLM in stroops
        f.mint_xlm(&f.payer, amount);

        let oid = order_bytes(&f.env, "b2e8d1c0-5f9a-4b0b-8d3e");
        f.client().pay_xlm(&f.payer, &amount, &oid);

        assert_eq!(f.xlm_balance(&f.treasury), amount);
        assert_eq!(f.xlm_balance(&f.payer), 0);
    }

    #[test]
    fn test_pay_xlm_emits_correct_event() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 50_000_000; // 50.00 XLM
        f.mint_xlm(&f.payer, amount);

        let oid = order_bytes(&f.env, "test-order-xlm");
        f.client().pay_xlm(&f.payer, &amount, &oid);

        let events = f.env.events().all();
        let mut found = false;
        for (contract_addr, topics, data) in events.iter() {
            if contract_addr != f.contract_id {
                continue;
            }
            let sym: Symbol = topics.get(0).unwrap().try_into_val(&f.env).unwrap();
            if sym != Symbol::new(&f.env, "pay_xlm") {
                continue;
            }
            let emitted_oid: Bytes = topics.get(1).unwrap().try_into_val(&f.env).unwrap();
            assert_eq!(emitted_oid, oid);
            let emitted_from: Address = topics.get(2).unwrap().try_into_val(&f.env).unwrap();
            assert_eq!(emitted_from, f.payer);
            let emitted_amount: i128 = data.try_into_val(&f.env).unwrap();
            assert_eq!(emitted_amount, amount);
            found = true;
            break;
        }
        assert!(found, "pay_xlm event not found");
    }

    #[test]
    #[should_panic]
    fn test_pay_xlm_requires_auth() {
        let env = Env::default();

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let payer = Address::generate(&env);
        let usdc = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let xlm_sac = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let contract_id = env.register(Stellar_CardReceiver, ());
        let client = Stellar_CardReceiverClient::new(&env, &contract_id);

        env.mock_all_auths();
        client.init(&admin, &treasury, &usdc, &xlm_sac);

        env.mock_auths(&[]);
        let oid = order_bytes(&env, "order-no-auth-xlm");
        client.pay_xlm(&payer, &1_000_000_i128, &oid);
    }

    // ── getter tests ──────────────────────────────────────────────────────────

    #[test]
    fn test_try_getters_before_init_return_err() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(Stellar_CardReceiver, ());
        let client = Stellar_CardReceiverClient::new(&env, &contract_id);

        // Uninitialised — try_treasury() returns Err (unwrap() would panic)
        assert!(client.try_treasury().is_err());
        assert!(client.try_usdc_contract().is_err());
        assert!(client.try_xlm_contract().is_err());
        assert!(client.try_get_config().is_err());
    }

    // ── get_config view (issue #651) ─────────────────────────────────────────

    #[test]
    fn test_get_config_matches_individual_getters() {
        let f = Fixture::new();
        f.init();

        let cfg = f.client().get_config();
        assert_eq!(cfg.admin, f.client().admin());
        assert_eq!(cfg.treasury, f.client().treasury());
        assert_eq!(cfg.usdc_contract, f.client().usdc_contract());
        assert_eq!(cfg.xlm_contract, f.client().xlm_contract());
        assert_eq!(cfg.is_paused, f.client().is_paused_view());
    }

    #[test]
    fn test_get_config_reflects_pause_state() {
        let f = Fixture::new();
        f.init();
        assert!(!f.client().get_config().is_paused);

        f.client().pause(&f.admin);
        assert!(f.client().get_config().is_paused);

        f.client().unpause();
        assert!(!f.client().get_config().is_paused);
    }

    #[test]
    fn test_get_config_reflects_admin_and_treasury_updates() {
        let f = Fixture::new();
        f.init();

        let new_treasury = Address::generate(&f.env);
        f.client().update_treasury(&new_treasury);
        let new_admin = Address::generate(&f.env);
        f.client().transfer_admin(&new_admin);

        let cfg = f.client().get_config();
        assert_eq!(cfg.admin, new_admin);
        assert_eq!(cfg.treasury, new_treasury);
        // Token addresses are immutable after init.
        assert_eq!(cfg.usdc_contract, f.usdc);
        assert_eq!(cfg.xlm_contract, f.xlm_sac);
    }

    #[test]
    fn test_get_config_requires_no_authorization() {
        let f = Fixture::new();
        f.init();
        // View call with no signatures at all must still succeed.
        f.env.mock_auths(&[]);
        let cfg = f.client().get_config();
        assert_eq!(cfg.admin, f.admin);
    }

    // ── order escrow tests (issue #649) ─────────────────────────────────────

    #[test]
    fn test_deposit_escrow_holds_funds_in_contract() {
        let f = Fixture::new();
        f.init();
        let oid = order_bytes(&f.env, "esc-1");
        f.mint_usdc(&f.payer, 1_000);

        f.client()
            .deposit_escrow(&f.payer, &500, &oid, &Asset::Usdc);

        assert_eq!(f.usdc_balance(&f.payer), 500);
        assert_eq!(f.usdc_balance(&f.contract_id), 500);
        assert_eq!(f.usdc_balance(&f.treasury), 0, "escrow must not pay out yet");

        let rec = f.client().get_escrow(&oid, &Asset::Usdc).unwrap();
        assert_eq!(rec.payer, f.payer);
        assert_eq!(rec.amount, 500);
    }

    #[test]
    fn test_release_escrow_forwards_to_treasury() {
        let f = Fixture::new();
        f.init();
        let oid = order_bytes(&f.env, "esc-rel");
        f.mint_usdc(&f.payer, 1_000);
        f.client()
            .deposit_escrow(&f.payer, &400, &oid, &Asset::Usdc);

        let operator = Address::generate(&f.env);
        f.client().grant_role(&operator, &Role::Operator);
        f.client().release_escrow(&operator, &oid, &Asset::Usdc);

        assert_eq!(f.usdc_balance(&f.contract_id), 0);
        assert_eq!(f.usdc_balance(&f.treasury), 400);
        assert_eq!(f.usdc_balance(&f.payer), 600);
        assert!(f.client().get_escrow(&oid, &Asset::Usdc).is_none());
    }

    #[test]
    fn test_refund_escrow_returns_to_payer_before_expiry_when_admin() {
        let f = Fixture::new();
        f.init();
        let oid = order_bytes(&f.env, "esc-ref");
        f.mint_xlm(&f.payer, 1_000);
        f.client().deposit_escrow(&f.payer, &250, &oid, &Asset::Xlm);

        // Admin may refund before the timelock expires.
        f.client().refund_escrow(&f.admin, &oid, &Asset::Xlm);

        assert_eq!(f.xlm_balance(&f.payer), 1_000);
        assert_eq!(f.xlm_balance(&f.contract_id), 0);
        assert_eq!(f.xlm_balance(&f.treasury), 0);
        assert!(f.client().get_escrow(&oid, &Asset::Xlm).is_none());
    }

    #[test]
    fn test_refund_escrow_after_timelock_allows_non_admin() {
        let f = Fixture::new();
        f.init();
        let oid = order_bytes(&f.env, "esc-to");
        f.mint_usdc(&f.payer, 1_000);
        f.client()
            .deposit_escrow(&f.payer, &300, &oid, &Asset::Usdc);

        // Before expiry a non-admin refund must be refused.
        let stranger = Address::generate(&f.env);
        assert_eq!(
            f.client().try_refund_escrow(&stranger, &oid, &Asset::Usdc),
            Err(Ok(Error::EscrowNotExpired))
        );
        assert!(f.client().get_escrow(&oid, &Asset::Usdc).is_some());

        // Cross the timelock.
        f.env.ledger().with_mut(|li| li.timestamp += ESCROW_TIMELOCK_SECS);

        f.client().refund_escrow(&stranger, &oid, &Asset::Usdc);
        assert_eq!(f.usdc_balance(&f.payer), 1_000);
        assert!(f.client().get_escrow(&oid, &Asset::Usdc).is_none());
    }

    #[test]
    fn test_escrow_deposit_emits_event() {
        let f = Fixture::new();
        f.init();
        let oid = order_bytes(&f.env, "esc-ev");
        f.mint_usdc(&f.payer, 100);
        f.client()
            .deposit_escrow(&f.payer, &100, &oid, &Asset::Usdc);

        let (topics, data) = single_contract_event(&f, "escrow_deposited");
        let t1: Bytes = topics.get(2).unwrap().try_into_val(&f.env).unwrap();
        assert_eq!(t1, oid);
        let t2: Address = topics.get(3).unwrap().try_into_val(&f.env).unwrap();
        assert_eq!(t2, f.payer);
        let amount: i128 = data.try_into_val(&f.env).unwrap();
        assert_eq!(amount, 100);
    }

    #[test]
    fn test_escrow_release_emits_event() {
        let f = Fixture::new();
        f.init();
        let oid = order_bytes(&f.env, "esc-rev");
        f.mint_usdc(&f.payer, 100);
        f.client()
            .deposit_escrow(&f.payer, &100, &oid, &Asset::Usdc);
        let operator = Address::generate(&f.env);
        f.client().grant_role(&operator, &Role::Operator);
        f.client().release_escrow(&operator, &oid, &Asset::Usdc);

        let (topics, _) = single_contract_event(&f, "escrow_released");
        let t2: Bytes = topics.get(2).unwrap().try_into_val(&f.env).unwrap();
        assert_eq!(t2, oid);
    }

    #[test]
    fn test_escrow_refund_emits_event() {
        let f = Fixture::new();
        f.init();
        let oid = order_bytes(&f.env, "esc-rfev");
        f.mint_usdc(&f.payer, 100);
        f.client()
            .deposit_escrow(&f.payer, &100, &oid, &Asset::Usdc);
        f.client().refund_escrow(&f.admin, &oid, &Asset::Usdc);

        let (topics, _) = single_contract_event(&f, "escrow_refunded");
        let t2: Bytes = topics.get(2).unwrap().try_into_val(&f.env).unwrap();
        assert_eq!(t2, oid);
    }

    #[test]
    fn test_release_escrow_unknown_order_errors() {
        let f = Fixture::new();
        f.init();
        let operator = Address::generate(&f.env);
        f.client().grant_role(&operator, &Role::Operator);
        let oid = order_bytes(&f.env, "missing");
        assert_eq!(
            f.client().try_release_escrow(&operator, &oid, &Asset::Usdc),
            Err(Ok(Error::EscrowNotFound))
        );
    }

    #[test]
    fn test_refund_escrow_unknown_order_errors() {
        let f = Fixture::new();
        f.init();
        let oid = order_bytes(&f.env, "missing");
        assert_eq!(
            f.client().try_refund_escrow(&f.admin, &oid, &Asset::Xlm),
            Err(Ok(Error::EscrowNotFound))
        );
    }

    #[test]
    fn test_deposit_escrow_rejects_duplicate_order() {
        let f = Fixture::new();
        f.init();
        let oid = order_bytes(&f.env, "dup");
        f.mint_usdc(&f.payer, 1_000);
        f.client()
            .deposit_escrow(&f.payer, &100, &oid, &Asset::Usdc);
        assert_eq!(
            f.client()
                .try_deposit_escrow(&f.payer, &100, &oid, &Asset::Usdc),
            Err(Ok(Error::EscrowAlreadyExists))
        );
        // Same order id on the other asset is a separate slot.
        f.mint_xlm(&f.payer, 1_000);
        f.client()
            .deposit_escrow(&f.payer, &100, &oid, &Asset::Xlm);
    }

    #[test]
    fn test_deposit_escrow_rejects_zero_and_negative() {
        let f = Fixture::new();
        f.init();
        let oid = order_bytes(&f.env, "bad-amt");
        assert_eq!(
            f.client().try_deposit_escrow(&f.payer, &0, &oid, &Asset::Usdc),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            f.client()
                .try_deposit_escrow(&f.payer, &-5, &oid, &Asset::Usdc),
            Err(Ok(Error::InvalidAmount))
        );
    }

    #[test]
    fn test_deposit_escrow_respects_pause() {
        let f = Fixture::new();
        f.init();
        f.client().pause(&f.admin);
        let oid = order_bytes(&f.env, "paused-esc");
        assert_eq!(
            f.client().try_deposit_escrow(&f.payer, &1, &oid, &Asset::Usdc),
            Err(Ok(Error::ContractPaused))
        );
    }

    #[test]
    #[should_panic(expected = "release_escrow requires at least the Operator role")]
    fn test_release_escrow_requires_operator_role() {
        let f = Fixture::new();
        f.init();
        let oid = order_bytes(&f.env, "esc-role");
        f.mint_usdc(&f.payer, 100);
        f.client()
            .deposit_escrow(&f.payer, &100, &oid, &Asset::Usdc);
        let viewer = Address::generate(&f.env);
        f.client().grant_role(&viewer, &Role::Viewer);
        f.client().release_escrow(&viewer, &oid, &Asset::Usdc);
    }

    // ── amount validation tests ───────────────────────────────────────────────

    #[test]
    fn test_pay_usdc_rejects_zero_amount() {
        let f = Fixture::new();
        f.init();
        let oid = order_bytes(&f.env, "zero-amount");
        assert!(f.client().try_pay_usdc(&f.payer, &0_i128, &oid).is_err());
    }

    #[test]
    fn test_pay_usdc_rejects_negative_amount() {
        let f = Fixture::new();
        f.init();
        let oid = order_bytes(&f.env, "neg-amount");
        assert!(f
            .client()
            .try_pay_usdc(&f.payer, &(-1_000_000_i128), &oid)
            .is_err());
    }

    #[test]
    fn test_pay_xlm_rejects_zero_amount() {
        let f = Fixture::new();
        f.init();
        let oid = order_bytes(&f.env, "xlm-zero");
        assert!(f.client().try_pay_xlm(&f.payer, &0_i128, &oid).is_err());
    }

    #[test]
    fn test_pay_xlm_rejects_negative_amount() {
        let f = Fixture::new();
        f.init();
        let oid = order_bytes(&f.env, "xlm-neg");
        assert!(f
            .client()
            .try_pay_xlm(&f.payer, &(-50_000_000_i128), &oid)
            .is_err());
    }

    // ── upgrade tests ─────────────────────────────────────────────────────────

    #[test]
    fn test_admin_getter_returns_correct_address() {
        let f = Fixture::new();
        f.init();
        assert_eq!(f.client().admin(), f.admin);
    }

    #[test]
    #[should_panic]
    fn test_upgrade_requires_admin_auth() {
        let env = Env::default();
        env.mock_auths(&[]);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let xlm_sac = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let contract_id = env.register(Stellar_CardReceiver, ());
        let client = Stellar_CardReceiverClient::new(&env, &contract_id);

        // init with mocked auth temporarily just for setup
        env.mock_all_auths();
        client.init(&admin, &treasury, &usdc, &xlm_sac);

        // upgrade without admin auth must panic
        env.mock_auths(&[]);
        let fake_hash = BytesN::from_array(&env, &[0u8; 32]);
        client.upgrade(&fake_hash);
    }

    // ── init auth test ────────────────────────────────────────────────────────

    #[test]
    fn test_init_requires_admin_auth() {
        let env = Env::default();
        // No mock_all_auths — only the admin can authorize
        env.mock_auths(&[]);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let xlm_sac = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let contract_id = env.register(Stellar_CardReceiver, ());
        let client = Stellar_CardReceiverClient::new(&env, &contract_id);

        // Should panic because admin.require_auth() fires and no auth is mocked
        let result = client.try_init(&admin, &treasury, &usdc, &xlm_sac);
        assert!(result.is_err(), "init should require admin authorization");
    }

    // ── reentrancy guard tests ──────────────────────────────────────────────

    #[test]
    #[should_panic(expected = "reentrancy detected")]
    fn test_reentrancy_guard_panics_on_reentry() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 10_000_000;
        f.mint_usdc(&f.payer, amount * 2);

        // Set the reentrancy guard from within the contract context
        f.env.as_contract(&f.contract_id, || {
            f.env
                .storage()
                .temporary()
                .set(&DataKey::ReentrancyGuard, &true);
        });

        let oid1 = order_bytes(&f.env, "reentry-1");
        f.client().pay_usdc(&f.payer, &amount, &oid1);
    }

    #[test]
    fn test_reentrancy_guard_resets_after_successful_transfer() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 5_000_000;
        f.mint_usdc(&f.payer, amount * 2);

        let oid1 = order_bytes(&f.env, "sequential-1");
        f.client().pay_usdc(&f.payer, &amount, &oid1);

        // Guard should be reset — second call should succeed
        let oid2 = order_bytes(&f.env, "sequential-2");
        f.client().pay_usdc(&f.payer, &amount, &oid2);

        assert_eq!(f.usdc_balance(&f.treasury), amount * 2);
        assert_eq!(f.usdc_balance(&f.payer), 0);
    }

    #[test]
    fn test_reentrancy_guard_resets_for_xlm_after_successful_transfer() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 5_000_000;
        f.mint_xlm(&f.payer, amount * 2);

        let oid1 = order_bytes(&f.env, "xlm-sequential-1");
        f.client().pay_xlm(&f.payer, &amount, &oid1);

        let oid2 = order_bytes(&f.env, "xlm-sequential-2");
        f.client().pay_xlm(&f.payer, &amount, &oid2);

        assert_eq!(f.xlm_balance(&f.treasury), amount * 2);
    }

    #[test]
    fn test_reentrancy_guard_resets_after_failed_transfer() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 10_000_000;
        f.mint_usdc(&f.payer, amount / 2); // only half balance to cause a failure

        let oid1 = order_bytes(&f.env, "failed-1");
        let result = f.client().try_pay_usdc(&f.payer, &amount, &oid1);
        assert!(result.is_err(), "should fail with insufficient balance");

        // Now give sufficient balance
        f.mint_usdc(&f.payer, amount);

        // Guard should have reset, so this should succeed
        let oid2 = order_bytes(&f.env, "success-after-fail");
        f.client().pay_usdc(&f.payer, &amount, &oid2);

        assert_eq!(f.usdc_balance(&f.treasury), amount);
    }

    #[test]
    fn test_reentrancy_guard_resets_for_xlm_after_failed_transfer() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 5_000_000;
        f.mint_xlm(&f.payer, amount / 2);

        let oid1 = order_bytes(&f.env, "xlm-failed-1");
        let result = f.client().try_pay_xlm(&f.payer, &amount, &oid1);
        assert!(result.is_err(), "should fail with insufficient balance");

        // Now give sufficient balance
        f.mint_xlm(&f.payer, amount);

        // Guard should have reset, so this should succeed
        let oid2 = order_bytes(&f.env, "xlm-success-after-fail");
        f.client().pay_xlm(&f.payer, &amount, &oid2);

        assert_eq!(f.xlm_balance(&f.treasury), amount);
    }

    // ── reentrancy guard tests ──────────────────────────────────────────────

    // ── reentrancy guard: rescue_tokens and callbacks (issue #397) ─────────

    /// A deliberately hostile "token" whose `transfer` tries to call back
    /// into the receiver contract, the way a malicious token passed to
    /// `rescue_tokens` could. It records whether the callback got through.
    mod reentrant_token {
        use soroban_sdk::{contract, contractimpl, contracttype, Address, Bytes, Env};

        #[contracttype]
        enum Key {
            Receiver,
            CallbackSucceeded,
        }

        #[contract]
        pub struct ReentrantToken;

        #[contractimpl]
        impl ReentrantToken {
            pub fn set_receiver(env: Env, receiver: Address) {
                env.storage().instance().set(&Key::Receiver, &receiver);
            }

            pub fn decimals(_env: Env) -> u32 {
                7
            }

            pub fn transfer(env: Env, from: Address, _to: Address, amount: i128) {
                let receiver: Address = env.storage().instance().get(&Key::Receiver).unwrap();
                let client = super::super::Stellar_CardReceiverClient::new(&env, &receiver);
                // Re-enter the receiver while its own rescue_tokens call is
                // still on the stack.
                let callback = client.try_rescue_tokens(
                    &from,
                    &env.current_contract_address(),
                    &from,
                    &amount,
                );
                let payment = client.try_pay_usdc(&from, &amount, &Bytes::new(&env));
                env.storage().instance().set(
                    &Key::CallbackSucceeded,
                    &(callback.is_ok() || payment.is_ok()),
                );
            }

            pub fn callback_succeeded(env: Env) -> bool {
                env.storage()
                    .instance()
                    .get(&Key::CallbackSucceeded)
                    .unwrap_or(false)
            }
        }
    }

    fn reentrancy_guard_is_held(f: &Fixture) -> bool {
        f.env.as_contract(&f.contract_id, || {
            f.env
                .storage()
                .temporary()
                .get::<_, bool>(&DataKey::ReentrancyGuard)
                .unwrap_or(false)
        })
    }

    #[test]
    #[should_panic(expected = "reentrancy detected")]
    fn test_reentrancy_guard_blocks_rescue_tokens_while_held() {
        let f = Fixture::new();
        f.init();
        f.mint_usdc(&f.contract_id, 1_000_000);

        f.env.as_contract(&f.contract_id, || {
            f.env
                .storage()
                .temporary()
                .set(&DataKey::ReentrancyGuard, &true);
        });

        let destination = Address::generate(&f.env);
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &destination, &1_000_000);
    }

    #[test]
    #[should_panic(expected = "reentrancy detected")]
    fn test_reentrancy_guard_blocks_pay_xlm_while_held() {
        let f = Fixture::new();
        f.init();
        f.mint_xlm(&f.payer, 1_000_000);

        f.env.as_contract(&f.contract_id, || {
            f.env
                .storage()
                .temporary()
                .set(&DataKey::ReentrancyGuard, &true);
        });

        f.client()
            .pay_xlm(&f.payer, &1_000_000, &order_bytes(&f.env, "xlm-reentry"));
    }

    #[test]
    fn test_reentrancy_guard_released_after_every_guarded_call() {
        let f = Fixture::new();
        f.init();
        f.mint_usdc(&f.payer, 2_000_000);
        f.mint_xlm(&f.payer, 1_000_000);
        f.mint_usdc(&f.contract_id, 500_000);
        let destination = Address::generate(&f.env);

        f.client()
            .pay_usdc(&f.payer, &1_000_000, &order_bytes(&f.env, "g-1"));
        assert!(!reentrancy_guard_is_held(&f));

        f.client()
            .pay_xlm(&f.payer, &1_000_000, &order_bytes(&f.env, "g-2"));
        assert!(!reentrancy_guard_is_held(&f));

        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &destination, &500_000);
        assert!(!reentrancy_guard_is_held(&f));

        // Failed transfers (insufficient balance) must release it too.
        assert_eq!(
            f.client()
                .try_pay_usdc(&f.payer, &5_000_000, &order_bytes(&f.env, "g-3")),
            Err(Ok(Error::TransferFailed))
        );
        assert!(!reentrancy_guard_is_held(&f));

        assert_eq!(
            f.client()
                .try_rescue_tokens(&f.admin, &f.usdc, &destination, &1),
            Err(Ok(Error::TransferFailed))
        );
        assert!(!reentrancy_guard_is_held(&f));
    }

    #[test]
    fn test_rejected_calls_never_acquire_the_guard() {
        // Paused and invalid-amount rejections return before the guarded
        // section, so they can't leave the guard set either.
        let f = Fixture::new();
        f.init();

        assert_eq!(
            f.client()
                .try_pay_usdc(&f.payer, &0, &order_bytes(&f.env, "zero")),
            Err(Ok(Error::InvalidAmount))
        );
        assert!(!reentrancy_guard_is_held(&f));

        f.client().pause(&f.admin);
        assert_eq!(
            f.client()
                .try_pay_xlm(&f.payer, &1, &order_bytes(&f.env, "paused")),
            Err(Ok(Error::ContractPaused))
        );
        assert!(!reentrancy_guard_is_held(&f));
    }

    #[test]
    fn test_rescue_tokens_callback_from_malicious_token_cannot_reenter() {
        let f = Fixture::new();
        f.init();
        f.client()
            .set_withdraw_limits(&f.admin, &None, &Some(1_000));
        f.mint_usdc(&f.admin, 10_000);

        let evil = f.env.register(reentrant_token::ReentrantToken, ());
        let evil_client = reentrant_token::ReentrantTokenClient::new(&f.env, &evil);
        evil_client.set_receiver(&f.contract_id);

        let destination = Address::generate(&f.env);
        f.client()
            .rescue_tokens(&f.admin, &evil, &destination, &1_000);

        // Neither the nested rescue_tokens nor the nested pay_usdc went
        // through, so no USDC moved on the callback path.
        assert!(!evil_client.callback_succeeded());
        assert_eq!(f.usdc_balance(&f.treasury), 0);
        assert_eq!(f.usdc_balance(&f.admin), 10_000);
        assert!(!reentrancy_guard_is_held(&f));

        // The single outer rescue used the whole daily budget: a callback
        // can't have slipped a second withdrawal in against a stale total.
        assert_eq!(
            f.client()
                .try_rescue_tokens(&f.admin, &evil, &destination, &1),
            Err(Ok(Error::DailyWithdrawLimitExceeded))
        );
    }

    // ── comprehensive edge-case tests ─────────────────────────────────────

    #[test]
    fn test_pay_usdc_smallest_positive_amount() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 1; // 0.0000001 USDC
        f.mint_usdc(&f.payer, amount);

        let oid = order_bytes(&f.env, "min-usdc");
        f.client().pay_usdc(&f.payer, &amount, &oid);

        assert_eq!(f.usdc_balance(&f.treasury), 1);
        assert_eq!(f.usdc_balance(&f.payer), 0);
    }

    #[test]
    fn test_pay_xlm_smallest_positive_amount() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 1; // 1 stroop
        f.mint_xlm(&f.payer, amount);

        let oid = order_bytes(&f.env, "min-xlm");
        f.client().pay_xlm(&f.payer, &amount, &oid);

        assert_eq!(f.xlm_balance(&f.treasury), 1);
        assert_eq!(f.xlm_balance(&f.payer), 0);
    }

    #[test]
    fn test_pay_usdc_large_amount() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 1_000_000_000_000; // 100,000 USDC
        f.mint_usdc(&f.payer, amount);

        let oid = order_bytes(&f.env, "large-usdc");
        f.client().pay_usdc(&f.payer, &amount, &oid);

        assert_eq!(f.usdc_balance(&f.treasury), amount);
    }

    #[test]
    fn test_pay_xlm_large_amount() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 1_000_000_000_000_000; // 100M XLM
        f.mint_xlm(&f.payer, amount);

        let oid = order_bytes(&f.env, "large-xlm");
        f.client().pay_xlm(&f.payer, &amount, &oid);

        assert_eq!(f.xlm_balance(&f.treasury), amount);
    }

    #[test]
    fn test_pay_usdc_insufficient_balance_panics() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 10_000_000;
        f.mint_usdc(&f.payer, amount / 2); // only half

        let oid = order_bytes(&f.env, "insufficient-usdc");
        let result = f.client().try_pay_usdc(&f.payer, &amount, &oid);
        assert!(result.is_err(), "should fail with insufficient balance");
    }

    #[test]
    fn test_pay_xlm_insufficient_balance_panics() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 10_000_000;
        f.mint_xlm(&f.payer, amount / 2);

        let oid = order_bytes(&f.env, "insufficient-xlm");
        let result = f.client().try_pay_xlm(&f.payer, &amount, &oid);
        assert!(result.is_err(), "should fail with insufficient balance");
    }

    // ── failed-transfer error/balance semantics (Issue #413 - Part 4) ────────

    #[test]
    fn test_pay_usdc_insufficient_balance_returns_transfer_failed_error() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 10_000_000;
        f.mint_usdc(&f.payer, amount / 2);

        let oid = order_bytes(&f.env, "insufficient-usdc-variant");
        let result = f.client().try_pay_usdc(&f.payer, &amount, &oid);
        assert_eq!(result, Err(Ok(Error::TransferFailed)));
    }

    #[test]
    fn test_pay_xlm_insufficient_balance_returns_transfer_failed_error() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 10_000_000;
        f.mint_xlm(&f.payer, amount / 2);

        let oid = order_bytes(&f.env, "insufficient-xlm-variant");
        let result = f.client().try_pay_xlm(&f.payer, &amount, &oid);
        assert_eq!(result, Err(Ok(Error::TransferFailed)));
    }

    #[test]
    fn test_pay_usdc_insufficient_balance_leaves_balances_unchanged() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 10_000_000;
        let available = amount / 2;
        f.mint_usdc(&f.payer, available);

        let oid = order_bytes(&f.env, "insufficient-usdc-no-partial");
        let result = f.client().try_pay_usdc(&f.payer, &amount, &oid);
        assert!(result.is_err());

        // A rejected token::Client transfer must not move any funds --
        // the payer keeps every unit they had, and the treasury sees none.
        assert_eq!(f.usdc_balance(&f.payer), available);
        assert_eq!(f.usdc_balance(&f.treasury), 0);
    }

    // ── failed-transfer error/balance semantics (Issue #413 - Part 4) ────────

    #[test]
    fn test_pay_xlm_insufficient_balance_leaves_balances_unchanged() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 10_000_000;
        let available = amount / 2;
        f.mint_xlm(&f.payer, available);

        let oid = order_bytes(&f.env, "insufficient-xlm-no-partial");
        let result = f.client().try_pay_xlm(&f.payer, &amount, &oid);
        assert!(result.is_err());

        assert_eq!(f.xlm_balance(&f.payer), available);
        assert_eq!(f.xlm_balance(&f.treasury), 0);
    }

    #[test]
    fn test_pay_usdc_with_zero_balance_payer_fails_cleanly() {
        let f = Fixture::new();
        f.init();

        // Payer never received any USDC at all -- not just "not enough".
        let amount: i128 = 5_000_000;
        let oid = order_bytes(&f.env, "zero-balance-usdc");
        let result = f.client().try_pay_usdc(&f.payer, &amount, &oid);

        assert_eq!(result, Err(Ok(Error::TransferFailed)));
        assert_eq!(f.usdc_balance(&f.payer), 0);
        assert_eq!(f.usdc_balance(&f.treasury), 0);
    }

    #[test]
    fn test_pay_xlm_with_zero_balance_payer_fails_cleanly() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 5_000_000;
        let oid = order_bytes(&f.env, "zero-balance-xlm");
        let result = f.client().try_pay_xlm(&f.payer, &amount, &oid);

        assert_eq!(result, Err(Ok(Error::TransferFailed)));
        assert_eq!(f.xlm_balance(&f.payer), 0);
        assert_eq!(f.xlm_balance(&f.treasury), 0);
    }

    // ── partial-spend and no-custody invariants (Issue #413 - Part 4) ────────

    #[test]
    fn test_pay_usdc_leaves_remainder_with_payer_when_paying_less_than_balance() {
        let f = Fixture::new();
        f.init();

        let minted: i128 = 30_000_000;
        let paid: i128 = 12_000_000;
        f.mint_usdc(&f.payer, minted);

        let oid = order_bytes(&f.env, "partial-spend-usdc");
        f.client().pay_usdc(&f.payer, &paid, &oid);

        assert_eq!(f.usdc_balance(&f.payer), minted - paid);
        assert_eq!(f.usdc_balance(&f.treasury), paid);
    }

    #[test]
    fn test_pay_xlm_leaves_remainder_with_payer_when_paying_less_than_balance() {
        let f = Fixture::new();
        f.init();

        let minted: i128 = 30_000_000;
        let paid: i128 = 12_000_000;
        f.mint_xlm(&f.payer, minted);

        let oid = order_bytes(&f.env, "partial-spend-xlm");
        f.client().pay_xlm(&f.payer, &paid, &oid);

        assert_eq!(f.xlm_balance(&f.payer), minted - paid);
        assert_eq!(f.xlm_balance(&f.treasury), paid);
    }

    #[test]
    fn test_contract_never_retains_usdc_balance_after_pay_usdc() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 8_000_000;
        f.mint_usdc(&f.payer, amount);

        let oid = order_bytes(&f.env, "no-custody-usdc");
        f.client().pay_usdc(&f.payer, &amount, &oid);

        // pay_usdc forwards straight from payer to treasury in the same
        // call -- the contract itself must never end up holding a balance.
        assert_eq!(f.usdc_balance(&f.contract_id), 0);
    }

    #[test]
    fn test_contract_never_retains_xlm_balance_after_pay_xlm() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 8_000_000;
        f.mint_xlm(&f.payer, amount);

        let oid = order_bytes(&f.env, "no-custody-xlm");
        f.client().pay_xlm(&f.payer, &amount, &oid);

        assert_eq!(f.xlm_balance(&f.contract_id), 0);
    }

    #[test]
    fn test_pay_usdc_does_not_affect_xlm_contract_balance() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 8_000_000;
        f.mint_usdc(&f.payer, amount);
        f.mint_xlm(&f.payer, amount);

        f.client()
            .pay_usdc(&f.payer, &amount, &order_bytes(&f.env, "usdc-only"));

        // Only the USDC leg moved; the payer's XLM balance (minted from a
        // separate SAC) must be completely untouched.
        assert_eq!(f.usdc_balance(&f.payer), 0);
        assert_eq!(f.xlm_balance(&f.payer), amount);
        assert_eq!(f.xlm_balance(&f.treasury), 0);
    }

    #[test]
    fn test_pay_xlm_does_not_affect_usdc_contract_balance() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 8_000_000;
        f.mint_usdc(&f.payer, amount);
        f.mint_xlm(&f.payer, amount);

        f.client()
            .pay_xlm(&f.payer, &amount, &order_bytes(&f.env, "xlm-only"));

        assert_eq!(f.xlm_balance(&f.payer), 0);
        assert_eq!(f.usdc_balance(&f.payer), amount);
        assert_eq!(f.usdc_balance(&f.treasury), 0);
    }

    #[test]
    fn test_multiple_payments_accumulate_in_treasury() {
        let f = Fixture::new();
        f.init();

        let usdc_amount: i128 = 10_000_000;
        let xlm_amount: i128 = 20_000_000;

        f.mint_usdc(&f.payer, usdc_amount * 2);
        f.mint_xlm(&f.payer, xlm_amount * 3);

        f.client()
            .pay_usdc(&f.payer, &usdc_amount, &order_bytes(&f.env, "multi-1"));
        f.client()
            .pay_usdc(&f.payer, &usdc_amount, &order_bytes(&f.env, "multi-2"));
        f.client()
            .pay_xlm(&f.payer, &xlm_amount, &order_bytes(&f.env, "multi-3"));
        f.client()
            .pay_xlm(&f.payer, &xlm_amount, &order_bytes(&f.env, "multi-4"));
        f.client()
            .pay_xlm(&f.payer, &xlm_amount, &order_bytes(&f.env, "multi-5"));

        assert_eq!(f.usdc_balance(&f.treasury), usdc_amount * 2);
        assert_eq!(f.xlm_balance(&f.treasury), xlm_amount * 3);
        assert_eq!(f.usdc_balance(&f.payer), 0);
        assert_eq!(f.xlm_balance(&f.payer), 0);
    }

    #[test]
    fn test_different_payers_pay_independently() {
        let f = Fixture::new();
        f.init();

        let payer2 = Address::generate(&f.env);
        let amount: i128 = 10_000_000;

        f.mint_usdc(&f.payer, amount);
        f.mint_usdc(&payer2, amount);

        f.client()
            .pay_usdc(&f.payer, &amount, &order_bytes(&f.env, "payer1-order"));
        f.client()
            .pay_usdc(&payer2, &amount, &order_bytes(&f.env, "payer2-order"));

        assert_eq!(f.usdc_balance(&f.treasury), amount * 2);
        assert_eq!(f.usdc_balance(&f.payer), 0);
        assert_eq!(f.usdc_balance(&payer2), 0);
    }

    #[test]
    fn test_getters_after_init() {
        let f = Fixture::new();
        f.init();

        assert_eq!(f.client().admin(), f.admin);
        assert_eq!(f.client().treasury(), f.treasury);
        assert_eq!(f.client().usdc_contract(), f.usdc);
        assert_eq!(f.client().xlm_contract(), f.xlm_sac);
    }

    #[test]
    fn test_try_admin_before_init_returns_err() {
        let env = Env::default();
        let contract_id = env.register(Stellar_CardReceiver, ());
        let client = Stellar_CardReceiverClient::new(&env, &contract_id);

        assert!(client.try_admin().is_err());
    }

    #[test]
    fn test_empty_order_id_accepted() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 1_000_000;
        f.mint_usdc(&f.payer, amount);

        let oid = Bytes::new(&f.env);
        f.client().pay_usdc(&f.payer, &amount, &oid);

        assert_eq!(f.usdc_balance(&f.treasury), amount);
    }

    #[test]
    fn test_long_order_id_accepted() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 1_000_000;
        f.mint_usdc(&f.payer, amount);

        let long_id = "a".repeat(200);
        let oid = order_bytes(&f.env, &long_id);
        f.client().pay_usdc(&f.payer, &amount, &oid);

        assert_eq!(f.usdc_balance(&f.treasury), amount);
    }

    #[test]
    fn test_init_stores_correct_admin() {
        let f = Fixture::new();
        f.init();
        assert_eq!(f.client().admin(), f.admin);
    }

    // ── comprehensive edge-case and error handling tests ──────────────────────

    #[test]
    fn test_pay_usdc_with_max_i128() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = i128::MAX / 2;
        f.mint_usdc(&f.payer, amount);

        let oid = order_bytes(&f.env, "max-i128");
        f.client().pay_usdc(&f.payer, &amount, &oid);

        assert_eq!(f.usdc_balance(&f.treasury), amount);
    }

    #[test]
    fn test_pay_xlm_with_max_i128() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = i128::MAX / 2;
        f.mint_xlm(&f.payer, amount);

        let oid = order_bytes(&f.env, "max-xlm");
        f.client().pay_xlm(&f.payer, &amount, &oid);

        assert_eq!(f.xlm_balance(&f.treasury), amount);
    }

    #[test]
    fn test_concurrent_payments_from_different_payers() {
        let f = Fixture::new();
        f.init();

        let payer1 = Address::generate(&f.env);
        let payer2 = Address::generate(&f.env);
        let payer3 = Address::generate(&f.env);

        let amount: i128 = 10_000_000;
        f.mint_usdc(&payer1, amount);
        f.mint_usdc(&payer2, amount);
        f.mint_usdc(&payer3, amount);

        f.client()
            .pay_usdc(&payer1, &amount, &order_bytes(&f.env, "payer1"));
        f.client()
            .pay_usdc(&payer2, &amount, &order_bytes(&f.env, "payer2"));
        f.client()
            .pay_usdc(&payer3, &amount, &order_bytes(&f.env, "payer3"));

        assert_eq!(f.usdc_balance(&f.treasury), amount * 3);
    }

    #[test]
    fn test_pay_usdc_with_exact_order_id_match() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 10_000_000;
        let available = amount / 2;
        f.mint_xlm(&f.payer, available);

        let oid = order_bytes(&f.env, "insufficient-xlm-no-partial");
        let result = f.client().try_pay_xlm(&f.payer, &amount, &oid);
        assert!(result.is_err());

        assert_eq!(f.xlm_balance(&f.payer), available);
        assert_eq!(f.xlm_balance(&f.treasury), 0);
    }

    #[test]
    fn test_treasury_getter_returns_consistent_value() {
        let f = Fixture::new();
        f.init();

        for _ in 0..5 {
            assert_eq!(f.client().treasury(), f.treasury);
        }
    }

    // ── partial-spend and no-custody invariants (Issue #413 - Part 4) ────────

    #[test]
    fn test_usdc_contract_getter_returns_consistent_value() {
        let f = Fixture::new();
        f.init();

        for _ in 0..5 {
            assert_eq!(f.client().usdc_contract(), f.usdc);
        }
    }

    #[test]
    fn test_xlm_contract_getter_returns_consistent_value() {
        let f = Fixture::new();
        f.init();

        for _ in 0..5 {
            assert_eq!(f.client().xlm_contract(), f.xlm_sac);
        }
    }

    #[test]
    fn test_admin_getter_returns_consistent_value() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 8_000_000;
        f.mint_usdc(&f.payer, amount);

        let oid = order_bytes(&f.env, "no-custody-usdc");
        f.client().pay_usdc(&f.payer, &amount, &oid);

        // pay_usdc forwards straight from payer to treasury in the same
        // call -- the contract itself must never end up holding a balance.
        assert_eq!(f.usdc_balance(&f.contract_id), 0);
        for _ in 0..5 {
            assert_eq!(f.client().admin(), f.admin);
        }
    }

    #[test]
    fn test_pay_usdc_with_various_order_id_formats() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 8_000_000;
        f.mint_xlm(&f.payer, amount);

        let oid = order_bytes(&f.env, "no-custody-xlm");
        f.client().pay_xlm(&f.payer, &amount, &oid);

        assert_eq!(f.xlm_balance(&f.contract_id), 0);
    }

    // ── comprehensive edge-case and error handling tests ──────────────────────

    #[test]
    fn test_role_check_with_unassigned_user_returns_false() {
        let f = Fixture::new();
        f.init();

        let user = Address::generate(&f.env);

        assert!(!f.client().has_role(&user, &Role::Admin));
        assert!(!f.client().has_role(&user, &Role::Operator));
        assert!(!f.client().has_role(&user, &Role::Viewer));
    }

    #[test]
    fn test_get_role_returns_none_for_unassigned_user() {
        let f = Fixture::new();
        f.init();

        let user = Address::generate(&f.env);
        assert_eq!(f.client().get_role(&user), None);
    }

    #[test]
    fn test_pay_operations_increment_ttl() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 1_000_000;

        let test_cases = [
            "",
            "order-1",
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "123456789",
            "!@#$%^&*()",
            "order\nwith\nnewlines",
        ];

        for order_id in test_cases.iter() {
            f.mint_usdc(&f.payer, amount);
            let oid = order_bytes(&f.env, order_id);
            f.client().pay_usdc(&f.payer, &amount, &oid);
        }

        assert_eq!(
            f.usdc_balance(&f.treasury),
            amount * test_cases.len() as i128
        );
    }

    #[test]
    fn test_role_management_operations_increment_ttl() {
        let f = Fixture::new();
        f.init();

        let user1 = Address::generate(&f.env);
        let user2 = Address::generate(&f.env);

        f.client().grant_role(&user1, &Role::Viewer);
        f.client().grant_role(&user2, &Role::Operator);
        f.client().revoke_role(&user1);

        assert_eq!(f.client().get_role(&user1), None);
        assert_eq!(f.client().get_role(&user2), Some(Role::Operator));
    }

    #[test]
    fn test_pay_usdc_event_count_matches_payment() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 10_000_000;
        f.mint_usdc(&f.payer, amount * 3);

        f.client()
            .pay_usdc(&f.payer, &amount, &order_bytes(&f.env, "evt-1"));
        f.client()
            .pay_usdc(&f.payer, &amount, &order_bytes(&f.env, "evt-2"));
        f.client()
            .pay_usdc(&f.payer, &amount, &order_bytes(&f.env, "evt-3"));

        // Each pay_usdc call emits exactly one event in the current transaction
        let events = f.env.events().all();
        let mut count = 0;
        for (contract_addr, topics, _) in events.iter() {
            if contract_addr != f.contract_id {
                continue;
            }
            let sym: Symbol = topics.get(0).unwrap().try_into_val(&f.env).unwrap();
            if sym == Symbol::new(&f.env, "pay_usdc") {
                count += 1;
            }
        }
        // Soroban test env captures events from the last transaction only
        assert!(
            count >= 1,
            "should emit at least 1 pay_usdc event per transaction"
        );
    }

    #[test]
    fn test_pay_xlm_event_count_matches_payment() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 5_000_000;
        f.mint_xlm(&f.payer, amount * 2);

        f.client()
            .pay_xlm(&f.payer, &amount, &order_bytes(&f.env, "xlm-evt-1"));
        f.client()
            .pay_xlm(&f.payer, &amount, &order_bytes(&f.env, "xlm-evt-2"));

        let events = f.env.events().all();
        let mut count = 0;
        for (contract_addr, topics, _) in events.iter() {
            if contract_addr != f.contract_id {
                continue;
            }
            let sym: Symbol = topics.get(0).unwrap().try_into_val(&f.env).unwrap();
            if sym == Symbol::new(&f.env, "pay_xlm") {
                count += 1;
            }
        }
        assert!(
            count >= 1,
            "should emit at least 1 pay_xlm event per transaction"
        );
    }

    #[test]
    fn test_usdc_and_xlm_payments_independent() {
        let f = Fixture::new();
        f.init();

        let usdc_amount: i128 = 10_000_000;
        let xlm_amount: i128 = 50_000_000;

        f.mint_usdc(&f.payer, usdc_amount);
        f.mint_xlm(&f.payer, xlm_amount);

        f.client()
            .pay_usdc(&f.payer, &usdc_amount, &order_bytes(&f.env, "mixed-usdc"));
        f.client()
            .pay_xlm(&f.payer, &xlm_amount, &order_bytes(&f.env, "mixed-xlm"));

        assert_eq!(f.usdc_balance(&f.treasury), usdc_amount);
        assert_eq!(f.xlm_balance(&f.treasury), xlm_amount);
        assert_eq!(f.usdc_balance(&f.payer), 0);
        assert_eq!(f.xlm_balance(&f.payer), 0);
    }

    // ── RBAC integration with payments tests ──────────────────────────────────

    #[test]
    fn test_admin_can_always_see_treasury() {
        let f = Fixture::new();
        f.init();

        let user = Address::generate(&f.env);
        f.client().grant_role(&user, &Role::Admin);

        assert!(f.client().has_role(&user, &Role::Admin));
        assert_eq!(f.client().treasury(), f.treasury);
    }

    #[test]
    fn test_operator_cannot_be_admin() {
        let f = Fixture::new();
        f.init();

        let user = Address::generate(&f.env);
        f.client().grant_role(&user, &Role::Operator);

        assert!(!f.client().has_role(&user, &Role::Admin));
        assert!(f.client().has_role(&user, &Role::Operator));
    }

    #[test]
    fn test_viewer_has_minimal_permissions() {
        let f = Fixture::new();
        f.init();

        let user = Address::generate(&f.env);
        f.client().grant_role(&user, &Role::Viewer);

        assert!(!f.client().has_role(&user, &Role::Admin));
        assert!(!f.client().has_role(&user, &Role::Operator));
        assert!(f.client().has_role(&user, &Role::Viewer));
    }

    #[test]
    fn test_multiple_users_can_have_roles() {
        let f = Fixture::new();
        f.init();

        let admin_user = Address::generate(&f.env);
        let operator_user = Address::generate(&f.env);
        let viewer_user = Address::generate(&f.env);

        f.client().grant_role(&admin_user, &Role::Admin);
        f.client().grant_role(&operator_user, &Role::Operator);
        f.client().grant_role(&viewer_user, &Role::Viewer);

        assert_eq!(f.client().get_role(&admin_user), Some(Role::Admin));
        assert_eq!(f.client().get_role(&operator_user), Some(Role::Operator));
        assert_eq!(f.client().get_role(&viewer_user), Some(Role::Viewer));
    }

    #[test]
    fn test_grant_role_overwrites_existing_role() {
        let f = Fixture::new();
        f.init();

        let user = Address::generate(&f.env);
        f.client().grant_role(&user, &Role::Viewer);
        assert_eq!(f.client().get_role(&user), Some(Role::Viewer));

        f.client().grant_role(&user, &Role::Operator);
        assert_eq!(f.client().get_role(&user), Some(Role::Operator));

        f.client().grant_role(&user, &Role::Admin);
        assert_eq!(f.client().get_role(&user), Some(Role::Admin));
    }

    #[test]
    fn test_revoke_role_makes_has_role_return_false() {
        let f = Fixture::new();
        f.init();

        let user = Address::generate(&f.env);
        f.client().grant_role(&user, &Role::Operator);
        assert!(f.client().has_role(&user, &Role::Operator));

        f.client().revoke_role(&user);
        assert!(!f.client().has_role(&user, &Role::Operator));
        assert!(!f.client().has_role(&user, &Role::Viewer));
        assert!(!f.client().has_role(&user, &Role::Admin));
    }

    #[test]
    fn test_admin_has_highest_privilege() {
        let f = Fixture::new();
        f.init();

        let admin_user = Address::generate(&f.env);
        f.client().grant_role(&admin_user, &Role::Admin);

        assert!(f.client().has_role(&admin_user, &Role::Admin));
        assert!(f.client().has_role(&admin_user, &Role::Operator));
        assert!(f.client().has_role(&admin_user, &Role::Viewer));
    }

    #[test]
    fn test_operator_has_operator_and_viewer_but_not_admin() {
        let f = Fixture::new();
        f.init();

        let operator_user = Address::generate(&f.env);
        f.client().grant_role(&operator_user, &Role::Operator);

        assert!(!f.client().has_role(&operator_user, &Role::Admin));
        assert!(f.client().has_role(&operator_user, &Role::Operator));
        assert!(f.client().has_role(&operator_user, &Role::Viewer));
    }

    // ── role-based access control state persistence tests ──────────────────────

    #[test]
    fn test_role_assignments_persist_across_calls() {
        let f = Fixture::new();
        f.init();

        let user = Address::generate(&f.env);
        f.client().grant_role(&user, &Role::Operator);

        assert_eq!(f.client().get_role(&user), Some(Role::Operator));
        assert_eq!(f.client().get_role(&user), Some(Role::Operator)); // Call again
    }

    #[test]
    fn test_multiple_role_assignments_do_not_interfere() {
        let f = Fixture::new();
        f.init();

        let user1 = Address::generate(&f.env);
        let user2 = Address::generate(&f.env);
        let user3 = Address::generate(&f.env);

        f.client().grant_role(&user1, &Role::Admin);
        f.client().grant_role(&user2, &Role::Operator);
        f.client().grant_role(&user3, &Role::Viewer);

        assert_eq!(f.client().get_role(&user1), Some(Role::Admin));
        assert_eq!(f.client().get_role(&user2), Some(Role::Operator));
        assert_eq!(f.client().get_role(&user3), Some(Role::Viewer));

        f.client().revoke_role(&user2);

        assert_eq!(f.client().get_role(&user1), Some(Role::Admin));
        assert_eq!(f.client().get_role(&user2), None);
        assert_eq!(f.client().get_role(&user3), Some(Role::Viewer));
    }

    // ── unauthorized caller edge cases (issue #652) ─────────────────────────

    /// Grants `role` to `addr` and returns it, for the negative-auth suite.
    fn fixture_with_role(f: &Fixture, role: Role) -> Address {
        let addr = Address::generate(&f.env);
        f.client().grant_role(&addr, &role);
        addr
    }

    // -- no signature at all: Soroban auth must reject the call --

    #[test]
    #[should_panic]
    fn test_no_auth_caller_cannot_pause() {
        let f = Fixture::new();
        f.init();
        let c = f.client().mock_auths(&[]);
        c.pause(&f.admin);
    }

    #[test]
    #[should_panic]
    fn test_no_auth_caller_cannot_unpause() {
        let f = Fixture::new();
        f.init();
        f.client().pause(&f.admin);
        let c = f.client().mock_auths(&[]);
        c.unpause();
    }

    #[test]
    #[should_panic]
    fn test_no_auth_caller_cannot_upgrade() {
        let f = Fixture::new();
        f.init();
        let c = f.client().mock_auths(&[]);
        c.upgrade(&BytesN::from_array(&f.env, &[0u8; 32]));
    }

    #[test]
    #[should_panic]
    fn test_no_auth_caller_cannot_grant_role() {
        let f = Fixture::new();
        f.init();
        let target = Address::generate(&f.env);
        let c = f.client().mock_auths(&[]);
        c.grant_role(&target, &Role::Viewer);
    }

    #[test]
    #[should_panic]
    fn test_no_auth_caller_cannot_revoke_role() {
        let f = Fixture::new();
        f.init();
        let target = fixture_with_role(&f, Role::Viewer);
        let c = f.client().mock_auths(&[]);
        c.revoke_role(&target);
    }

    // -- Operator attempting Admin-only actions. The operator signs the
    //    call (so Soroban auth is not the failing check) but is not the
    //    stored admin, so the role/authority gate must reject it. --

    #[test]
    #[should_panic]
    fn test_operator_cannot_upgrade() {
        let f = Fixture::new();
        f.init();
        let operator = fixture_with_role(&f, Role::Operator);
        let hash = BytesN::from_array(&f.env, &[1u8; 32]);
        f.env.mock_auths(&[MockAuth {
            address: &operator,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "upgrade",
                args: (hash.clone(),).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client().upgrade(&hash);
    }

    #[test]
    #[should_panic]
    fn test_operator_cannot_grant_role() {
        let f = Fixture::new();
        f.init();
        let operator = fixture_with_role(&f, Role::Operator);
        let target = Address::generate(&f.env);
        f.env.mock_auths(&[MockAuth {
            address: &operator,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "grant_role",
                args: (target.clone(), Role::Admin).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client().grant_role(&target, &Role::Admin);
    }

    #[test]
    #[should_panic]
    fn test_operator_cannot_revoke_role() {
        let f = Fixture::new();
        f.init();
        let operator = fixture_with_role(&f, Role::Operator);
        let target = fixture_with_role(&f, Role::Viewer);
        f.env.mock_auths(&[MockAuth {
            address: &operator,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "revoke_role",
                args: (target.clone(),).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client().revoke_role(&target);
    }

    #[test]
    #[should_panic]
    fn test_operator_cannot_unpause() {
        let f = Fixture::new();
        f.init();
        let operator = fixture_with_role(&f, Role::Operator);
        f.client().pause(&f.admin);
        f.env.mock_auths(&[MockAuth {
            address: &operator,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "unpause",
                args: ().into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        f.client().unpause();
    }

    #[test]
    #[should_panic(expected = "rescue_tokens requires the Admin role")]
    fn test_operator_cannot_rescue_tokens() {
        let f = Fixture::new();
        f.init();
        let operator = fixture_with_role(&f, Role::Operator);
        let other = Address::generate(&f.env);
        f.mint_usdc(&f.contract_id, 100);
        f.client().rescue_tokens(&operator, &f.usdc, &other, &1);
    }

    #[test]
    #[should_panic(expected = "set_withdraw_limits requires the Admin role")]
    fn test_operator_cannot_set_withdraw_limits() {
        let f = Fixture::new();
        f.init();
        let operator = fixture_with_role(&f, Role::Operator);
        f.client()
            .set_withdraw_limits(&operator, &Some(10), &Some(20));
    }

    // -- Viewer attempting Operator-only actions --

    #[test]
    #[should_panic(expected = "pause requires at least the Operator role")]
    fn test_viewer_cannot_pause() {
        let f = Fixture::new();
        f.init();
        let viewer = fixture_with_role(&f, Role::Viewer);
        f.client().pause(&viewer);
    }

    #[test]
    #[should_panic(expected = "set_discount requires at least the Operator role")]
    fn test_viewer_cannot_set_discount() {
        let f = Fixture::new();
        f.init();
        let viewer = fixture_with_role(&f, Role::Viewer);
        let account = Address::generate(&f.env);
        f.client().set_discount(&viewer, &account, &100);
    }

    #[test]
    #[should_panic(expected = "set_blacklisted requires at least the Operator role")]
    fn test_viewer_cannot_set_blacklisted_via_role_check() {
        let f = Fixture::new();
        f.init();
        let viewer = fixture_with_role(&f, Role::Viewer);
        let account = Address::generate(&f.env);
        f.client().set_blacklisted(&viewer, &account, &true);
    }

    #[test]
    #[should_panic(expected = "rescue_tokens requires the Admin role")]
    fn test_viewer_cannot_rescue_tokens() {
        let f = Fixture::new();
        f.init();
        let viewer = fixture_with_role(&f, Role::Viewer);
        let other = Address::generate(&f.env);
        f.mint_usdc(&f.contract_id, 100);
        f.client().rescue_tokens(&viewer, &f.usdc, &other, &1);
    }

    // -- no-role address attempting Operator and Admin actions --

    #[test]
    #[should_panic(expected = "set_discount requires at least the Operator role")]
    fn test_no_role_cannot_set_discount() {
        let f = Fixture::new();
        f.init();
        let stranger = Address::generate(&f.env);
        let account = Address::generate(&f.env);
        f.client().set_discount(&stranger, &account, &100);
    }

    #[test]
    #[should_panic(expected = "rescue_tokens requires the Admin role")]
    fn test_no_role_cannot_rescue_tokens() {
        let f = Fixture::new();
        f.init();
        let stranger = Address::generate(&f.env);
        let other = Address::generate(&f.env);
        f.mint_usdc(&f.contract_id, 100);
        f.client().rescue_tokens(&stranger, &f.usdc, &other, &1);
    }

    // -- role holders still cannot cross into the tier above --

    #[test]
    fn test_viewer_still_reads_after_denied_write() {
        let f = Fixture::new();
        f.init();
        let viewer = fixture_with_role(&f, Role::Viewer);
        // Reads stay open after a denied privileged attempt.
        assert!(f.client().is_paused_view() == false);
        assert_eq!(f.client().get_role(&viewer), Some(Role::Viewer));
        assert_eq!(f.client().get_config().admin, f.admin);
    }

    // ── role management tests ────────────────────────────────────────────────

    #[test]
    fn test_grant_role_works() {
        let f = Fixture::new();
        f.init();

        let user = Address::generate(&f.env);
        assert_eq!(f.client().get_role(&user), None);
        assert_eq!(f.client().has_role(&user, &Role::Viewer), false);

        f.client().grant_role(&user, &Role::Viewer);

        assert_eq!(f.client().get_role(&user), Some(Role::Viewer));
        assert_eq!(f.client().has_role(&user, &Role::Viewer), true);
        assert_eq!(f.client().has_role(&user, &Role::Operator), false);
        assert_eq!(f.client().has_role(&user, &Role::Admin), false);

        f.client().grant_role(&user, &Role::Operator);
        assert_eq!(f.client().get_role(&user), Some(Role::Operator));
        assert_eq!(f.client().has_role(&user, &Role::Viewer), true);
        assert_eq!(f.client().has_role(&user, &Role::Operator), true);
        assert_eq!(f.client().has_role(&user, &Role::Admin), false);
    }

    #[test]
    #[should_panic]
    fn test_grant_role_requires_admin_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let xlm_sac = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let contract_id = env.register(Stellar_CardReceiver, ());
        let client = Stellar_CardReceiverClient::new(&env, &contract_id);

        client.init(&admin, &treasury, &usdc, &xlm_sac);

        let user = Address::generate(&env);
        client.grant_role(&user, &Role::Viewer); // panics
    }

    #[test]
    fn test_revoke_role_works() {
        let f = Fixture::new();
        f.init();

        let user = Address::generate(&f.env);
        f.client().grant_role(&user, &Role::Operator);
        assert_eq!(f.client().get_role(&user), Some(Role::Operator));

        f.client().revoke_role(&user);
        assert_eq!(f.client().get_role(&user), None);
    }

    #[test]
    #[should_panic]
    fn test_revoke_role_requires_admin_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let xlm_sac = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let contract_id = env.register(Stellar_CardReceiver, ());
        let client = Stellar_CardReceiverClient::new(&env, &contract_id);

        client.init(&admin, &treasury, &usdc, &xlm_sac);

        let user = Address::generate(&env);
        client.revoke_role(&user); // panics
    }

    #[test]
    fn test_revoke_nonexistent_role_is_noop() {
        let f = Fixture::new();
        f.init();

        let user = Address::generate(&f.env);
        f.client().revoke_role(&user);
        assert_eq!(f.client().get_role(&user), None);
        assert_eq!(
            contract_event_count(&f.env, &f.contract_id, "role_revoked"),
            0
        );
    }

    // ── renounce_role (Issue #414 - Part 4) ──────────────────────────────────

    #[test]
    fn test_renounce_role_removes_own_role() {
        let f = Fixture::new();
        f.init();

        let user = Address::generate(&f.env);
        f.client().grant_role(&user, &Role::Operator);
        assert_eq!(f.client().get_role(&user), Some(Role::Operator));

        f.client().renounce_role(&user);

        assert_eq!(f.client().get_role(&user), None);
        assert_eq!(f.client().has_role(&user, &Role::Viewer), false);
    }

    #[test]
    #[should_panic]
    fn test_renounce_role_requires_self_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let xlm_sac = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let contract_id = env.register(Stellar_CardReceiver, ());
        let client = Stellar_CardReceiverClient::new(&env, &contract_id);

        env.mock_all_auths();
        client.init(&admin, &treasury, &usdc, &xlm_sac);

        let user = Address::generate(&env);
        client.grant_role(&user, &Role::Viewer);

        // Neither the user nor anyone else has authorized this call.
        env.mock_auths(&[]);
        client.renounce_role(&user); // panics
    }

    #[test]
    fn test_renounce_nonexistent_role_is_noop() {
        let f = Fixture::new();
        f.init();

        let user = Address::generate(&f.env);
        f.client().renounce_role(&user);
        assert_eq!(f.client().get_role(&user), None);
    }

    #[test]
    fn test_renounce_role_does_not_affect_other_users() {
        let f = Fixture::new();
        f.init();

        let user1 = Address::generate(&f.env);
        let user2 = Address::generate(&f.env);
        f.client().grant_role(&user1, &Role::Operator);
        f.client().grant_role(&user2, &Role::Admin);

        f.client().renounce_role(&user1);

        assert_eq!(f.client().get_role(&user1), None);
        assert_eq!(f.client().get_role(&user2), Some(Role::Admin));
    }

    #[test]
    fn test_renounce_role_emits_correct_event() {
        let f = Fixture::new();
        f.init();

        let user = Address::generate(&f.env);
        f.client().grant_role(&user, &Role::Viewer);
        f.client().renounce_role(&user);

        let events = f.env.events().all();
        let mut found = false;
        for (contract_addr, topics, _data) in events.iter() {
            if contract_addr != f.contract_id {
                continue;
            }
            let sym: Symbol = topics.get(0).unwrap().try_into_val(&f.env).unwrap();
            if sym != Symbol::new(&f.env, "role_renounced") {
                continue;
            }
            let emitted_caller: Address = topics.get(1).unwrap().try_into_val(&f.env).unwrap();
            assert_eq!(emitted_caller, user);
            found = true;
            break;
        }
        assert!(found, "role_renounced event not found");
    }

    #[test]
    fn test_admin_can_still_grant_roles_after_admin_role_renounced() {
        let f = Fixture::new();
        f.init();

        // The admin renouncing its Role::Admin doesn't affect DataKey::Admin,
        // which is a separate identity — grant_role must keep working.
        f.client().renounce_role(&f.admin);
        assert_eq!(f.client().get_role(&f.admin), None);

        let user = Address::generate(&f.env);
        f.client().grant_role(&user, &Role::Viewer);
        assert_eq!(f.client().get_role(&user), Some(Role::Viewer));
    }

    #[test]
    fn test_has_role_hierarchy() {
        let f = Fixture::new();
        f.init();

        let admin_user = Address::generate(&f.env);
        let operator_user = Address::generate(&f.env);
        let viewer_user = Address::generate(&f.env);

        f.client().grant_role(&admin_user, &Role::Admin);
        f.client().grant_role(&operator_user, &Role::Operator);
        f.client().grant_role(&viewer_user, &Role::Viewer);

        // Admin has all roles
        assert!(f.client().has_role(&admin_user, &Role::Viewer));
        assert!(f.client().has_role(&admin_user, &Role::Operator));
        assert!(f.client().has_role(&admin_user, &Role::Admin));

        // Operator has Operator and Viewer
        assert!(f.client().has_role(&operator_user, &Role::Viewer));
        assert!(f.client().has_role(&operator_user, &Role::Operator));
        assert!(!f.client().has_role(&operator_user, &Role::Admin));

        // Viewer only has Viewer
        assert!(f.client().has_role(&viewer_user, &Role::Viewer));
        assert!(!f.client().has_role(&viewer_user, &Role::Operator));
        assert!(!f.client().has_role(&viewer_user, &Role::Admin));
    }

    // ── grant multiple roles to same user ──────────────────────────────────

    #[test]
    fn test_grant_multiple_roles_to_same_user() {
        let f = Fixture::new();
        f.init();

        let user = Address::generate(&f.env);
        f.client().grant_role(&user, &Role::Viewer);
        assert_eq!(f.client().get_role(&user), Some(Role::Viewer));

        // Upgrading from Viewer to Operator
        f.client().grant_role(&user, &Role::Operator);
        assert_eq!(f.client().get_role(&user), Some(Role::Operator));
        assert!(f.client().has_role(&user, &Role::Viewer));
        assert!(f.client().has_role(&user, &Role::Operator));
        assert!(!f.client().has_role(&user, &Role::Admin));

        // Upgrading from Operator to Admin
        f.client().grant_role(&user, &Role::Admin);
        assert_eq!(f.client().get_role(&user), Some(Role::Admin));
        assert!(f.client().has_role(&user, &Role::Viewer));
        assert!(f.client().has_role(&user, &Role::Operator));
        assert!(f.client().has_role(&user, &Role::Admin));
    }

    // ── revoke admin role from original admin ──────────────────────────────

    #[test]
    fn test_revoke_admin_role_from_original_admin() {
        let f = Fixture::new();
        f.init();

        // The init function grants Admin role to the admin address
        assert_eq!(f.client().get_role(&f.admin), Some(Role::Admin));

        // Revoke admin's role
        f.client().revoke_role(&f.admin);
        assert_eq!(f.client().get_role(&f.admin), None);
        assert!(!f.client().has_role(&f.admin, &Role::Admin));
    }

    // ── has_role returns false for unknown address ─────────────────────────

    #[test]
    fn test_has_role_returns_false_for_unknown() {
        let f = Fixture::new();
        f.init();

        let unknown = Address::generate(&f.env);
        assert!(!f.client().has_role(&unknown, &Role::Viewer));
        assert!(!f.client().has_role(&unknown, &Role::Operator));
        assert!(!f.client().has_role(&unknown, &Role::Admin));
    }

    // ── pause / unpause (circuit breaker) tests ──────────────────────────────

    #[test]
    fn test_contract_starts_unpaused() {
        let f = Fixture::new();
        f.init();
        assert_eq!(f.client().is_paused_view(), false);
    }

    #[test]
    fn test_pause_requires_operator_role() {
        let f = Fixture::new();
        f.init();

        let operator = Address::generate(&f.env);
        f.client().grant_role(&operator, &Role::Operator);

        f.client().pause(&operator);
        assert_eq!(f.client().is_paused_view(), true);
    }

    #[test]
    fn test_admin_role_can_also_pause() {
        let f = Fixture::new();
        f.init();

        let admin_role_holder = Address::generate(&f.env);
        f.client().grant_role(&admin_role_holder, &Role::Admin);

        f.client().pause(&admin_role_holder);
        assert_eq!(f.client().is_paused_view(), true);
    }

    #[test]
    fn test_pause_events_only_describe_state_transitions() {
        let f = Fixture::new();
        f.init();

        let operator = Address::generate(&f.env);
        f.client().grant_role(&operator, &Role::Operator);
        f.client().pause(&operator);
        assert_eq!(contract_event_count(&f.env, &f.contract_id, "paused"), 1);
        f.client().pause(&operator);
        assert_eq!(contract_event_count(&f.env, &f.contract_id, "paused"), 0);

        f.client().unpause();
        assert_eq!(contract_event_count(&f.env, &f.contract_id, "unpaused"), 1);
        f.client().unpause();
        assert_eq!(contract_event_count(&f.env, &f.contract_id, "unpaused"), 0);
    }

    // ── state-change event coverage (issue #398) ──────────────────────────────

    /// Returns `(topics, data)` of the single event named `name` that this
    /// contract emitted during the last invocation, panicking if there
    /// isn't exactly one.
    fn single_contract_event(
        f: &Fixture,
        name: &str,
    ) -> (soroban_sdk::Vec<soroban_sdk::Val>, soroban_sdk::Val) {
        let symbol = Symbol::new(&f.env, name);
        let mut found = None;
        for (event_contract, topics, data) in f.env.events().all().iter() {
            if event_contract != f.contract_id {
                continue;
            }
            let event_symbol: Symbol = topics.get(0).unwrap().try_into_val(&f.env).unwrap();
            if event_symbol == symbol {
                assert!(found.is_none(), "more than one `{}` event emitted", name);
                found = Some((topics, data));
            }
        }
        found.unwrap_or_else(|| panic!("no `{}` event emitted", name))
    }

    #[test]
    fn test_rescue_tokens_emits_tokens_rescued_event() {
        let f = Fixture::new();
        f.init();
        f.mint_usdc(&f.contract_id, 400_000);
        let destination = Address::generate(&f.env);

        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &destination, &400_000);

        let (topics, data) = single_contract_event(&f, "tokens_rescued");
        assert_eq!(topics.len(), 3);
        let token_topic: Address = topics.get(1).unwrap().try_into_val(&f.env).unwrap();
        let to_topic: Address = topics.get(2).unwrap().try_into_val(&f.env).unwrap();
        let (caller, amount): (Address, i128) = data.try_into_val(&f.env).unwrap();
        assert_eq!(token_topic, f.usdc);
        assert_eq!(to_topic, destination);
        assert_eq!(caller, f.admin);
        assert_eq!(amount, 400_000);
    }

    #[test]
    fn test_failed_rescue_tokens_emits_no_event() {
        let f = Fixture::new();
        f.init();
        let destination = Address::generate(&f.env);

        // Insufficient contract balance -> TransferFailed.
        assert_eq!(
            f.client()
                .try_rescue_tokens(&f.admin, &f.usdc, &destination, &1),
            Err(Ok(Error::TransferFailed))
        );
        assert_eq!(
            contract_event_count(&f.env, &f.contract_id, "tokens_rescued"),
            0
        );

        // Rejected by the per-call limit before any transfer is attempted.
        f.client().set_withdraw_limits(&f.admin, &Some(10), &None);
        f.mint_usdc(&f.contract_id, 100);
        assert_eq!(
            f.client()
                .try_rescue_tokens(&f.admin, &f.usdc, &destination, &11),
            Err(Ok(Error::WithdrawLimitExceeded))
        );
        assert_eq!(
            contract_event_count(&f.env, &f.contract_id, "tokens_rescued"),
            0
        );
    }

    #[test]
    fn test_set_withdraw_limits_emits_event_with_new_limits() {
        let f = Fixture::new();
        f.init();

        f.client().set_withdraw_limits(&f.admin, &Some(250), &None);

        let (topics, data) = single_contract_event(&f, "withdraw_limits_set");
        let caller: Address = topics.get(1).unwrap().try_into_val(&f.env).unwrap();
        let limits: (Option<i128>, Option<i128>) = data.try_into_val(&f.env).unwrap();
        assert_eq!(caller, f.admin);
        assert_eq!(limits, (Some(250), None));
    }

    #[test]
    fn test_transfer_admin_emits_event_with_old_and_new_admin() {
        let f = Fixture::new();
        f.init();
        let new_admin = Address::generate(&f.env);

        f.client().transfer_admin(&new_admin);

        let (topics, _) = single_contract_event(&f, "admin_transferred");
        let old: Address = topics.get(1).unwrap().try_into_val(&f.env).unwrap();
        let new: Address = topics.get(2).unwrap().try_into_val(&f.env).unwrap();
        assert_eq!(old, f.admin);
        assert_eq!(new, new_admin);
    }

    #[test]
    fn test_renounce_role_not_held_emits_no_event() {
        let f = Fixture::new();
        f.init();
        let user = Address::generate(&f.env);

        f.client().renounce_role(&user);
        assert_eq!(
            contract_event_count(&f.env, &f.contract_id, "role_renounced"),
            0
        );

        // Renouncing twice: only the first call is a real change.
        f.client().grant_role(&user, &Role::Operator);
        f.client().renounce_role(&user);
        assert_eq!(
            contract_event_count(&f.env, &f.contract_id, "role_renounced"),
            1
        );
        f.client().renounce_role(&user);
        assert_eq!(
            contract_event_count(&f.env, &f.contract_id, "role_renounced"),
            0
        );
    }

    #[test]
    fn test_grant_role_emits_only_when_role_changes() {
        let f = Fixture::new();
        f.init();
        let user = Address::generate(&f.env);

        f.client().grant_role(&user, &Role::Viewer);
        let (topics, data) = single_contract_event(&f, "role_granted");
        let role: Role = data.try_into_val(&f.env).unwrap();
        assert_eq!(role, Role::Viewer);
        // Issue #635: topics are (name, account, role).
        assert_eq!(topics.len(), 3);
        let account: Address = topics.get(1).unwrap().try_into_val(&f.env).unwrap();
        assert_eq!(account, user);
        let topic_role: Role = topics.get(2).unwrap().try_into_val(&f.env).unwrap();
        assert_eq!(topic_role, Role::Viewer);

        // Same role again: nothing changed, so no event.
        f.client().grant_role(&user, &Role::Viewer);
        assert_eq!(
            contract_event_count(&f.env, &f.contract_id, "role_granted"),
            0
        );
        assert_eq!(f.client().get_role(&user), Some(Role::Viewer));

        // A different role is a real change and is reported.
        f.client().grant_role(&user, &Role::Operator);
        let (topics, data) = single_contract_event(&f, "role_granted");
        let role: Role = data.try_into_val(&f.env).unwrap();
        assert_eq!(role, Role::Operator);
        let topic_role: Role = topics.get(2).unwrap().try_into_val(&f.env).unwrap();
        assert_eq!(topic_role, Role::Operator);
    }

    #[test]
    fn test_grant_roles_emits_only_for_addresses_whose_role_changed() {
        let f = Fixture::new();
        f.init();
        let already_viewer = Address::generate(&f.env);
        let fresh = Address::generate(&f.env);
        let was_operator = Address::generate(&f.env);
        f.client().grant_role(&already_viewer, &Role::Viewer);
        f.client().grant_role(&was_operator, &Role::Operator);

        let batch = soroban_sdk::vec![
            &f.env,
            already_viewer.clone(),
            fresh.clone(),
            was_operator.clone()
        ];
        f.client().grant_roles(&batch, &Role::Viewer);

        let mut granted = soroban_sdk::Vec::<Address>::new(&f.env);
        for (event_contract, topics, _) in f.env.events().all().iter() {
            if event_contract != f.contract_id {
                continue;
            }
            let name: Symbol = topics.get(0).unwrap().try_into_val(&f.env).unwrap();
            if name == Symbol::new(&f.env, "role_granted") {
                granted.push_back(topics.get(1).unwrap().try_into_val(&f.env).unwrap());
            }
        }
        assert_eq!(granted, soroban_sdk::vec![&f.env, fresh, was_operator]);
    }

    #[test]
    fn test_revoke_role_emits_single_event_only_for_held_role() {
        let f = Fixture::new();
        f.init();
        let user = Address::generate(&f.env);
        f.client().grant_role(&user, &Role::Viewer);

        f.client().revoke_role(&user);
        let (topics, _) = single_contract_event(&f, "role_revoked");
        // Issue #635: topics are (name, account, role).
        assert_eq!(topics.len(), 3);
        let revoked: Address = topics.get(1).unwrap().try_into_val(&f.env).unwrap();
        assert_eq!(revoked, user);
        let revoked_role: Role = topics.get(2).unwrap().try_into_val(&f.env).unwrap();
        assert_eq!(revoked_role, Role::Viewer);

        f.client().revoke_role(&user);
        assert_eq!(
            contract_event_count(&f.env, &f.contract_id, "role_revoked"),
            0
        );
    }

    #[test]
    #[should_panic(expected = "pause requires at least the Operator role")]
    fn test_pause_rejects_viewer_role() {
        let f = Fixture::new();
        f.init();

        let viewer = Address::generate(&f.env);
        f.client().grant_role(&viewer, &Role::Viewer);

        f.client().pause(&viewer); // panics — Viewer is below Operator
    }

    #[test]
    #[should_panic(expected = "pause requires at least the Operator role")]
    fn test_pause_rejects_address_with_no_role() {
        let f = Fixture::new();
        f.init();

        let nobody = Address::generate(&f.env);
        f.client().pause(&nobody); // panics — no role at all
    }

    #[test]
    fn test_unpause_resumes_payments() {
        let f = Fixture::new();
        f.init();

        let operator = Address::generate(&f.env);
        f.client().grant_role(&operator, &Role::Operator);
        f.client().pause(&operator);
        assert_eq!(f.client().is_paused_view(), true);

        f.client().unpause();
        assert_eq!(f.client().is_paused_view(), false);
    }

    // ── rescue_tokens tests ───────────────────────────────────────────────────

    #[test]
    fn test_rescue_tokens_recovers_mistaken_direct_transfer() {
        let f = Fixture::new();
        f.init();

        // Simulate a mistaken direct send: USDC minted straight to the
        // contract's own address, bypassing pay_usdc entirely.
        let amount: i128 = 3_000_000;
        f.mint_usdc(&f.contract_id, amount);
        assert_eq!(f.usdc_balance(&f.contract_id), amount);

        let rescue_destination = Address::generate(&f.env);
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &rescue_destination, &amount);

        assert_eq!(f.usdc_balance(&f.contract_id), 0);
        assert_eq!(f.usdc_balance(&rescue_destination), amount);
    }

    #[test]
    #[should_panic(expected = "rescue_tokens requires the Admin role")]
    fn test_rescue_tokens_requires_admin_role() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 1_000_000;
        f.mint_usdc(&f.contract_id, amount);

        let operator = Address::generate(&f.env);
        f.client().grant_role(&operator, &Role::Operator);

        let destination = Address::generate(&f.env);
        // Operator is below Admin in the hierarchy — must panic (has_role
        // check), not merely return Err.
        f.client()
            .rescue_tokens(&operator, &f.usdc, &destination, &amount);
    }

    #[test]
    fn test_rescue_tokens_accepts_role_admin_who_is_not_the_stored_admin() {
        let f = Fixture::new();
        f.init();

        // Someone granted the Admin *role* — but who is NOT the stored
        // DataKey::Admin address — must still be able to rescue tokens.
        let role_admin = Address::generate(&f.env);
        f.client().grant_role(&role_admin, &Role::Admin);

        let amount: i128 = 750_000;
        f.mint_usdc(&f.contract_id, amount);
        let destination = Address::generate(&f.env);

        f.client()
            .rescue_tokens(&role_admin, &f.usdc, &destination, &amount);
        assert_eq!(f.usdc_balance(&destination), amount);
    }

    #[test]
    fn test_rescue_tokens_rejects_non_positive_amount() {
        let f = Fixture::new();
        f.init();

        f.client().grant_role(&f.admin, &Role::Admin);
        let destination = Address::generate(&f.env);

        let result = f
            .client()
            .try_rescue_tokens(&f.admin, &f.usdc, &destination, &0_i128);
        assert_eq!(result, Err(Ok(Error::InvalidAmount)));
        assert_eq!(
            f.client()
                .try_rescue_tokens(&f.admin, &f.usdc, &destination, &-1_i128),
            Err(Ok(Error::InvalidAmount))
        );
    }

    #[test]
    fn test_rescue_tokens_works_for_any_sac_not_just_configured_ones() {
        let f = Fixture::new();
        f.init();

        // A third, unrelated token (not the contract's configured USDC/XLM)
        // mistakenly sent to the contract — rescue_tokens must still work,
        // since it takes the token contract as a parameter.
        let other_token_admin = Address::generate(&f.env);
        let other_token = f
            .env
            .register_stellar_asset_contract_v2(other_token_admin.clone())
            .address();
        let amount: i128 = 500_000;
        token::StellarAssetClient::new(&f.env, &other_token).mint(&f.contract_id, &amount);

        let destination = Address::generate(&f.env);
        f.client()
            .rescue_tokens(&f.admin, &other_token, &destination, &amount);

        assert_eq!(
            token::Client::new(&f.env, &other_token).balance(&destination),
            amount
        );
    }

    // ── withdraw limit tests (issue #401) ───────────────────────────────────────

    #[test]
    fn test_withdraw_limits_default_to_unset() {
        let f = Fixture::new();
        f.init();
        assert_eq!(f.client().withdraw_limits(), (None, None));
    }

    #[test]
    fn test_rescue_tokens_returns_arithmetic_overflow_for_daily_total() {
        let f = Fixture::new();
        f.init();
        let day = Stellar_CardReceiver::current_day(&f.env);
        f.env.as_contract(&f.contract_id, || {
            Stellar_CardReceiver::set_withdrawn(&f.env, day, i128::MAX);
        });

        let destination = Address::generate(&f.env);
        assert_eq!(
            f.client()
                .try_rescue_tokens(&f.admin, &f.usdc, &destination, &1_i128),
            Err(Ok(Error::ArithmeticOverflow))
        );
    }

    #[test]
    fn test_set_withdraw_limits_works() {
        let f = Fixture::new();
        f.init();
        f.client()
            .set_withdraw_limits(&f.admin, &Some(1_000_000), &Some(5_000_000));
        assert_eq!(
            f.client().withdraw_limits(),
            (Some(1_000_000), Some(5_000_000))
        );
    }

    #[test]
    fn test_set_withdraw_limits_can_clear_a_limit() {
        let f = Fixture::new();
        f.init();
        f.client()
            .set_withdraw_limits(&f.admin, &Some(1_000_000), &Some(5_000_000));
        f.client().set_withdraw_limits(&f.admin, &None, &None);
        assert_eq!(f.client().withdraw_limits(), (None, None));
    }

    #[test]
    #[should_panic(expected = "set_withdraw_limits requires the Admin role")]
    fn test_set_withdraw_limits_requires_admin_role() {
        let f = Fixture::new();
        f.init();
        let operator = Address::generate(&f.env);
        f.client().grant_role(&operator, &Role::Operator);
        f.client()
            .set_withdraw_limits(&operator, &Some(1_000_000), &None);
    }

    #[test]
    #[should_panic(expected = "withdraw limits must be positive when set")]
    fn test_set_withdraw_limits_rejects_non_positive_per_call() {
        let f = Fixture::new();
        f.init();
        f.client().set_withdraw_limits(&f.admin, &Some(0), &None);
    }

    #[test]
    fn test_rescue_tokens_within_per_call_limit_succeeds() {
        let f = Fixture::new();
        f.init();
        f.client()
            .set_withdraw_limits(&f.admin, &Some(1_000_000), &None);

        f.mint_usdc(&f.contract_id, 1_000_000);
        let destination = Address::generate(&f.env);
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &destination, &1_000_000);

        assert_eq!(f.usdc_balance(&destination), 1_000_000);
    }

    #[test]
    fn test_rescue_tokens_over_per_call_limit_returns_err() {
        let f = Fixture::new();
        f.init();
        f.client()
            .set_withdraw_limits(&f.admin, &Some(1_000_000), &None);

        f.mint_usdc(&f.contract_id, 2_000_000);
        let destination = Address::generate(&f.env);
        let result = f
            .client()
            .try_rescue_tokens(&f.admin, &f.usdc, &destination, &1_000_001);

        assert_eq!(result, Err(Ok(Error::WithdrawLimitExceeded)));
        // Balance must be untouched on rejection.
        assert_eq!(f.usdc_balance(&f.contract_id), 2_000_000);
    }

    #[test]
    fn test_rescue_tokens_within_daily_limit_across_multiple_calls_succeeds() {
        let f = Fixture::new();
        f.init();
        f.client()
            .set_withdraw_limits(&f.admin, &None, &Some(1_000_000));

        f.mint_usdc(&f.contract_id, 1_000_000);
        let destination = Address::generate(&f.env);
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &destination, &600_000);
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &destination, &400_000);

        assert_eq!(f.usdc_balance(&destination), 1_000_000);
    }

    #[test]
    fn test_rescue_tokens_exceeding_daily_limit_on_second_call_returns_err() {
        let f = Fixture::new();
        f.init();
        f.client()
            .set_withdraw_limits(&f.admin, &None, &Some(1_000_000));

        f.mint_usdc(&f.contract_id, 2_000_000);
        let destination = Address::generate(&f.env);
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &destination, &600_000);
        let result = f
            .client()
            .try_rescue_tokens(&f.admin, &f.usdc, &destination, &400_001);

        assert_eq!(result, Err(Ok(Error::DailyWithdrawLimitExceeded)));
        // The rejected call must not have moved any funds or inflated the accumulator.
        assert_eq!(f.usdc_balance(&destination), 600_000);
    }

    #[test]
    fn test_rescue_tokens_daily_limit_resets_on_the_next_day() {
        let f = Fixture::new();
        f.init();
        f.client()
            .set_withdraw_limits(&f.admin, &None, &Some(1_000_000));

        f.mint_usdc(&f.contract_id, 2_000_000);
        let destination = Address::generate(&f.env);
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &destination, &1_000_000);

        // Advance the ledger clock by a full day.
        f.env.ledger().with_mut(|li| {
            li.timestamp += 86_400;
        });

        // A fresh day's accumulator is empty, so this succeeds even though
        // the prior call already used up the "previous day"'s full limit.
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &destination, &1_000_000);

        assert_eq!(f.usdc_balance(&destination), 2_000_000);
    }

    #[test]
    fn test_rescue_tokens_amount_still_counted_when_only_per_call_limit_set() {
        let f = Fixture::new();
        f.init();
        f.client()
            .set_withdraw_limits(&f.admin, &Some(500_000), &None);

        f.mint_usdc(&f.contract_id, 500_000);
        let destination = Address::generate(&f.env);
        // Exactly at the limit must succeed (limit is inclusive).
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &destination, &500_000);
        assert_eq!(f.usdc_balance(&destination), 500_000);
    }

    #[test]
    fn test_rescue_tokens_failed_transfer_does_not_advance_daily_accumulator() {
        let f = Fixture::new();
        f.init();
        f.client()
            .set_withdraw_limits(&f.admin, &None, &Some(1_000_000));

        // No funds minted to the contract — the underlying token transfer
        // must fail (insufficient balance), which must not count against
        // the daily accumulator: a failed rescue shouldn't eat into the
        // day's remaining withdraw budget.
        let destination = Address::generate(&f.env);
        let result = f
            .client()
            .try_rescue_tokens(&f.admin, &f.usdc, &destination, &500_000);
        assert_eq!(result, Err(Ok(Error::TransferFailed)));

        // A second call for the same amount must still be within budget —
        // proof the first (failed) call left the accumulator untouched.
        f.mint_usdc(&f.contract_id, 500_000);
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &destination, &500_000);
        assert_eq!(f.usdc_balance(&destination), 500_000);
    }

    #[test]
    fn test_rescue_tokens_xlm_sac_respects_withdraw_limits_too() {
        // The withdraw limit applies to rescue_tokens generically, not just
        // to USDC — exercised here against the XLM SAC to prove it isn't
        // hardcoded to one token contract.
        let f = Fixture::new();
        f.init();
        f.client()
            .set_withdraw_limits(&f.admin, &Some(1_000_000), &None);

        f.mint_xlm(&f.contract_id, 2_000_000);
        let destination = Address::generate(&f.env);
        let result = f
            .client()
            .try_rescue_tokens(&f.admin, &f.xlm_sac, &destination, &1_500_000);
        assert_eq!(result, Err(Ok(Error::WithdrawLimitExceeded)));

        f.client()
            .rescue_tokens(&f.admin, &f.xlm_sac, &destination, &1_000_000);
        assert_eq!(
            token::Client::new(&f.env, &f.xlm_sac).balance(&destination),
            1_000_000
        );
    }

    // ── withdraw limit protections (issue #391) ─────────────────────────────────

    fn advance_days(f: &Fixture, days: u64) {
        f.env.ledger().with_mut(|li| {
            li.timestamp += days * 86_400;
        });
    }

    #[test]
    #[should_panic(expected = "per-call withdraw limit cannot exceed the daily limit")]
    fn test_set_withdraw_limits_rejects_per_call_above_daily() {
        let f = Fixture::new();
        f.init();
        f.client()
            .set_withdraw_limits(&f.admin, &Some(5_000_000), &Some(1_000_000));
    }

    #[test]
    fn test_set_withdraw_limits_accepts_per_call_equal_to_daily() {
        let f = Fixture::new();
        f.init();
        f.client()
            .set_withdraw_limits(&f.admin, &Some(1_000_000), &Some(1_000_000));
        assert_eq!(
            f.client().withdraw_limits(),
            (Some(1_000_000), Some(1_000_000))
        );
    }

    #[test]
    fn test_set_withdraw_limits_allows_any_per_call_when_daily_unset() {
        // The ordering rule only applies when both limits are set.
        let f = Fixture::new();
        f.init();
        f.client()
            .set_withdraw_limits(&f.admin, &Some(i128::MAX), &None);
        assert_eq!(f.client().withdraw_limits(), (Some(i128::MAX), None));
    }

    #[test]
    fn test_rejected_withdraw_limits_leave_previous_limits_in_place() {
        let f = Fixture::new();
        f.init();
        f.client()
            .set_withdraw_limits(&f.admin, &Some(100), &Some(1_000));

        assert!(f
            .client()
            .try_set_withdraw_limits(&f.admin, &Some(2_000), &Some(1_000))
            .is_err());
        assert_eq!(f.client().withdraw_limits(), (Some(100), Some(1_000)));
        assert_eq!(
            contract_event_count(&f.env, &f.contract_id, "withdraw_limits_set"),
            0
        );
    }

    #[test]
    fn test_rescue_tokens_to_contract_itself_returns_err() {
        let f = Fixture::new();
        f.init();
        f.client()
            .set_withdraw_limits(&f.admin, &None, &Some(1_000_000));
        f.mint_usdc(&f.contract_id, 1_000_000);

        let result = f
            .client()
            .try_rescue_tokens(&f.admin, &f.usdc, &f.contract_id, &1_000_000);

        assert_eq!(result, Err(Ok(Error::InvalidRecipient)));
        // Nothing moved and none of the day's budget was spent, so a
        // genuine rescue of the full balance still fits under the limit.
        assert_eq!(f.client().withdrawn_today(), 0);
        let destination = Address::generate(&f.env);
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &destination, &1_000_000);
        assert_eq!(f.usdc_balance(&destination), 1_000_000);
    }

    #[test]
    fn test_withdrawn_today_tracks_successful_rescues_only() {
        let f = Fixture::new();
        f.init();
        assert_eq!(f.client().withdrawn_today(), 0);

        f.mint_usdc(&f.contract_id, 1_000);
        let destination = Address::generate(&f.env);
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &destination, &300);
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &destination, &200);
        assert_eq!(f.client().withdrawn_today(), 500);

        // Fails at the token (balance is only 500): not counted.
        assert_eq!(
            f.client()
                .try_rescue_tokens(&f.admin, &f.usdc, &destination, &600),
            Err(Ok(Error::TransferFailed))
        );
        assert_eq!(f.client().withdrawn_today(), 500);
    }

    #[test]
    fn test_withdrawn_today_resets_on_the_next_day() {
        let f = Fixture::new();
        f.init();
        f.client()
            .set_withdraw_limits(&f.admin, &None, &Some(1_000));
        f.mint_usdc(&f.contract_id, 2_000);
        let destination = Address::generate(&f.env);

        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &destination, &1_000);
        assert_eq!(f.client().withdrawn_today(), 1_000);

        advance_days(&f, 1);
        assert_eq!(f.client().withdrawn_today(), 0);
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &destination, &1_000);
        assert_eq!(f.client().withdrawn_today(), 1_000);
    }

    #[test]
    fn test_daily_withdraw_accumulator_uses_a_single_storage_slot() {
        // Rescues on many different days must keep overwriting one entry
        // rather than leaving a key behind per day in instance storage,
        // which every call loads and pays rent on.
        let f = Fixture::new();
        f.init();
        f.mint_usdc(&f.contract_id, 10);
        let destination = Address::generate(&f.env);

        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &destination, &1);
        let entries_after_first_day = f
            .env
            .as_contract(&f.contract_id, || f.env.storage().instance().has(&DataKey::DailyWithdrawn));

        for _ in 0..5 {
            advance_days(&f, 1);
            f.client()
                .rescue_tokens(&f.admin, &f.usdc, &destination, &1);
        }

        let entries_after_six_days = f
            .env
            .as_contract(&f.contract_id, || f.env.storage().instance().has(&DataKey::DailyWithdrawn));
        assert_eq!(
            entries_after_six_days, entries_after_first_day,
            "DailyWithdrawn stays a single slot"
        );
        assert_eq!(
            f.env.as_contract(&f.contract_id, || f
                .env
                .storage()
                .instance()
                .get::<_, (u64, i128)>(&DataKey::DailyWithdrawn)),
            Some((f.env.ledger().timestamp() / 86_400, 1))
        );
    }

    // ── transfer_admin tests ──────────────────────────────────────────────────

    #[test]
    fn test_transfer_admin_updates_admin_address() {
        let f = Fixture::new();
        f.init();

        let new_admin = Address::generate(&f.env);
        f.client().transfer_admin(&new_admin);

        assert_eq!(f.client().admin(), new_admin);
    }

    #[test]
    fn test_new_admin_can_act_after_transfer() {
        let f = Fixture::new();
        f.init();

        let new_admin = Address::generate(&f.env);
        f.client().transfer_admin(&new_admin);

        // The new admin must now be able to do admin-gated work (e.g.
        // grant a role) — proving the handover actually took effect, not
        // just that the getter reports the new address.
        let user = Address::generate(&f.env);
        f.client().grant_role(&user, &Role::Viewer);
        assert_eq!(f.client().get_role(&user), Some(Role::Viewer));
    }

    #[test]
    #[should_panic]
    fn test_pause_requires_admin_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let xlm_sac = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let contract_id = env.register(Stellar_CardReceiver, ());
        let client = Stellar_CardReceiverClient::new(&env, &contract_id);

        env.mock_all_auths();
        client.init(&admin, &treasury, &usdc, &xlm_sac);

        // init() auto-grants admin the Admin role, which satisfies pause()'s
        // Operator-or-above check -- so with no auth mocked at all, the
        // panic must come from caller.require_auth(), not a missing role.
        env.mock_auths(&[]);
        client.pause(&admin);
    }

    #[test]
    #[should_panic]
    fn test_unpause_requires_admin_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let xlm_sac = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let contract_id = env.register(Stellar_CardReceiver, ());
        let client = Stellar_CardReceiverClient::new(&env, &contract_id);

        env.mock_all_auths();
        client.init(&admin, &treasury, &usdc, &xlm_sac);

        // unpause() checks DataKey::Admin directly (not the Role system), and
        // is deliberately stricter than pause() — with no auth mocked at all,
        // admin.require_auth() must panic.

        env.mock_auths(&[]);
        client.unpause();
    }

    #[test]
    #[should_panic]
    fn test_old_admin_loses_authority_after_transfer() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let xlm_sac = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let contract_id = env.register(Stellar_CardReceiver, ());
        let client = Stellar_CardReceiverClient::new(&env, &contract_id);

        env.mock_all_auths();
        client.init(&admin, &treasury, &usdc, &xlm_sac);

        let new_admin = Address::generate(&env);
        client.transfer_admin(&new_admin);
        assert_eq!(client.admin(), new_admin);

        // DataKey::Admin now holds new_admin. Mock auth for the OLD admin
        // ONLY (not new_admin) and try an admin-gated call — it must panic,
        // proving the old admin no longer has authority, not merely that
        // the getter reports a different address.
        let someone = Address::generate(&env);
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "revoke_role",
                args: (someone.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.revoke_role(&someone);
    }

    #[test]
    #[should_panic]
    fn test_transfer_admin_requires_new_admin_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let xlm_sac = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let contract_id = env.register(Stellar_CardReceiver, ());
        let client = Stellar_CardReceiverClient::new(&env, &contract_id);

        env.mock_all_auths();
        client.init(&admin, &treasury, &usdc, &xlm_sac);

        // transfer_admin requires BOTH the current admin's and the new
        // admin's auth. Mock only the current admin — the new admin's
        // require_auth() must panic.
        let new_admin = Address::generate(&env);
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "transfer_admin",
                args: (new_admin.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.transfer_admin(&new_admin);
    }

    #[test]
    fn test_pay_usdc_rejected_when_paused() {
        let f = Fixture::new();
        f.init();

        let operator = Address::generate(&f.env);
        f.client().grant_role(&operator, &Role::Operator);
        f.client().pause(&operator);

        let amount: i128 = 10_000_000;
        f.mint_usdc(&f.payer, amount);

        let oid = order_bytes(&f.env, "paused-usdc");
        let result = f.client().try_pay_usdc(&f.payer, &amount, &oid);
        assert_eq!(result, Err(Ok(Error::ContractPaused)));

        // Balance must be untouched — the paused check runs before any transfer.
        assert_eq!(f.usdc_balance(&f.payer), amount);
    }

    #[test]
    fn test_paused_contract_rejects_pay_xlm() {
        let f = Fixture::new();
        f.init();

        let operator = Address::generate(&f.env);
        f.client().grant_role(&operator, &Role::Operator);
        f.client().pause(&operator);

        let amount: i128 = 5_000_000;
        f.mint_xlm(&f.payer, amount);

        let oid = order_bytes(&f.env, "paused-xlm");
        let result = f.client().try_pay_xlm(&f.payer, &amount, &oid);
        assert_eq!(result, Err(Ok(Error::ContractPaused)));
        assert_eq!(f.xlm_balance(&f.payer), amount);
    }

    #[test]
    fn test_pay_usdc_works_again_after_unpause() {
        let f = Fixture::new();
        f.init();

        let operator = Address::generate(&f.env);
        f.client().grant_role(&operator, &Role::Operator);
        f.client().pause(&operator);
        f.client().unpause();

        let amount: i128 = 10_000_000;
        f.mint_usdc(&f.payer, amount);
        let oid = order_bytes(&f.env, "after-unpause");

        f.client().pay_usdc(&f.payer, &amount, &oid);

        assert_eq!(f.usdc_balance(&f.treasury), amount);
    }

    #[test]
    fn test_different_payers_usdc() {
        let f = Fixture::new();
        f.init();

        let payer2 = Address::generate(&f.env);
        let payer3 = Address::generate(&f.env);
        let amount: i128 = 1_000_000;

        f.mint_usdc(&f.payer, amount);
        f.mint_usdc(&payer2, amount);
        f.mint_usdc(&payer3, amount);

        f.client()
            .pay_usdc(&f.payer, &amount, &order_bytes(&f.env, "dp-1"));
        f.client()
            .pay_usdc(&payer2, &amount, &order_bytes(&f.env, "dp-2"));
        f.client()
            .pay_usdc(&payer3, &amount, &order_bytes(&f.env, "dp-3"));

        assert_eq!(f.usdc_balance(&f.treasury), amount * 3);
    }

    #[test]
    fn test_different_payers_xlm() {
        let f = Fixture::new();
        f.init();

        let payer2 = Address::generate(&f.env);
        let amount: i128 = 1_000_000;

        f.mint_xlm(&f.payer, amount);
        f.mint_xlm(&payer2, amount);

        f.client()
            .pay_xlm(&f.payer, &amount, &order_bytes(&f.env, "dp-xlm-1"));
        f.client()
            .pay_xlm(&payer2, &amount, &order_bytes(&f.env, "dp-xlm-2"));

        assert_eq!(f.xlm_balance(&f.treasury), amount * 2);
    }

    #[test]
    fn test_multiple_payers_single_order() {
        let f = Fixture::new();
        f.init();

        let payer2 = Address::generate(&f.env);
        let amount: i128 = 5_000_000;

        f.mint_usdc(&f.payer, amount);
        f.mint_usdc(&payer2, amount);

        // Same order ID used by different payers
        f.client()
            .pay_usdc(&f.payer, &amount, &order_bytes(&f.env, "shared-order"));
        f.client()
            .pay_usdc(&payer2, &amount, &order_bytes(&f.env, "shared-order"));

        assert_eq!(f.usdc_balance(&f.treasury), amount * 2);
    }

    #[test]
    fn test_empty_order_id_xlm() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 1_000_000;
        f.mint_xlm(&f.payer, amount);

        let oid = Bytes::new(&f.env);
        f.client().pay_xlm(&f.payer, &amount, &oid);

        assert_eq!(f.xlm_balance(&f.treasury), amount);
    }

    #[test]
    fn test_long_order_id_xlm() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 1_000_000;
        f.mint_xlm(&f.payer, amount);

        let long_id = "x".repeat(200);
        let oid = order_bytes(&f.env, &long_id);
        f.client().pay_xlm(&f.payer, &amount, &oid);

        assert_eq!(f.xlm_balance(&f.treasury), amount);
    }

    #[test]
    fn test_pay_usdc_with_fractional_amount() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 1_500_000; // 1.5 USDC
        f.mint_usdc(&f.payer, amount);

        let oid = order_bytes(&f.env, "fractional");
        f.client().pay_usdc(&f.payer, &amount, &oid);

        assert_eq!(f.usdc_balance(&f.treasury), amount);
    }

    #[test]
    fn test_pay_xlm_minimum_stroops() {
        let f = Fixture::new();
        f.init();

        let amount: i128 = 1;
        f.mint_xlm(&f.payer, amount);

        let oid = order_bytes(&f.env, "min-stroops");
        f.client().pay_xlm(&f.payer, &amount, &oid);

        assert_eq!(f.xlm_balance(&f.treasury), 1);
    }

    mod upgrade_wasm {
        soroban_sdk::contractimport!(
            file = "target/wasm32v1-none/release/stellar_card_receiver.wasm"
        );
    }

    #[test]
    fn test_upgrade_works() {
        let f = Fixture::new();
        f.init();

        // `upgrade()` only needs a WASM hash that actually exists in the
        // ledger — upload this same contract's own compiled WASM so the
        // success path can be exercised without a second dummy contract.
        // Built for wasm32v1-none rather than wasm32-unknown-unknown: on
        // this toolchain the latter emits reference-types encoding that
        // the bundled soroban-env-host WASM parser rejects.
        let new_hash = f.env.deployer().upload_contract_wasm(upgrade_wasm::WASM);
        f.client().upgrade(&new_hash);

        let mut found = false;
        for (contract_addr, topics, data) in f.env.events().all().iter() {
            if contract_addr != f.contract_id {
                continue;
            }
            let symbol: Symbol = topics.get(0).unwrap().try_into_val(&f.env).unwrap();
            if symbol != Symbol::new(&f.env, "upgraded") {
                continue;
            }
            let emitted_admin: Address = topics.get(1).unwrap().try_into_val(&f.env).unwrap();
            let emitted_hash: BytesN<32> = data.try_into_val(&f.env).unwrap();
            assert_eq!(emitted_admin, f.admin);
            assert_eq!(emitted_hash, new_hash);
            found = true;
        }
        assert!(found, "upgrade event not found");
    }

    // ── WASM size (issue #392) ────────────────────────────────────────────────

    /// Raw (pre-`stellar contract optimize`) size budget. Mirrors
    /// `WASM_SIZE_BUDGET_BYTES` in the Makefile — keep the two in sync.
    const WASM_SIZE_BUDGET_BYTES: usize = 86_016;
    // Soroban's network-enforced ceiling on deployed contract code size is
    // 65_536 bytes. Only the optimized binary is deployed, so the raw rustc
    // output may exceed it; the optimized budget in the Makefile is what
    // must fit.
    #[test]
    fn test_wasm_within_size_budget() {
        // Runs as part of every `cargo test`, so a size regression fails
        // locally without needing `make build`'s separate budget check.
        let size = upgrade_wasm::WASM.len();
        assert!(
            size <= WASM_SIZE_BUDGET_BYTES,
            "contract WASM is {size} bytes, over its {WASM_SIZE_BUDGET_BYTES}-byte budget \
             by {} bytes",
            size - WASM_SIZE_BUDGET_BYTES
        );
    }

    #[test]
    fn test_wasm_has_no_custom_sections_beyond_contract_metadata() {
        // `strip = "symbols"` + `debug = 0` should leave only the sections
        // Soroban itself reads (contract spec / env and SDK metadata). A
        // `name` or DWARF `.debug_*` section showing up means the release
        // profile stopped stripping and the binary grew for nothing.
        let wasm = upgrade_wasm::WASM;
        let mut offset = 8; // "\0asm" magic + version
        while offset < wasm.len() {
            let id = wasm[offset];
            offset += 1;
            let (len, used) = read_leb128_u32(&wasm[offset..]);
            offset += used;
            if id == 0 {
                let (name_len, name_used) = read_leb128_u32(&wasm[offset..]);
                let start = offset + name_used;
                let name = core::str::from_utf8(&wasm[start..start + name_len as usize]).unwrap();
                assert!(
                    name.starts_with("contract"),
                    "unexpected custom section `{name}` in release WASM"
                );
            }
            offset += len as usize;
        }
        assert_eq!(offset, wasm.len());
    }

    /// Decodes an unsigned LEB128 `u32`, returning `(value, bytes_read)`.
    fn read_leb128_u32(bytes: &[u8]) -> (u32, usize) {
        let mut value = 0u32;
        for (i, byte) in bytes.iter().enumerate() {
            value |= u32::from(byte & 0x7f) << (7 * i);
            if byte & 0x80 == 0 {
                return (value, i + 1);
            }
        }
        panic!("truncated LEB128");
    }

    // ── init events test ───────────────────────────────────────────────────

    #[test]
    fn test_init_emits_configuration_event() {
        let f = Fixture::new();
        f.init();

        let mut found = false;
        for (contract_addr, topics, data) in f.env.events().all().iter() {
            if contract_addr != f.contract_id {
                continue;
            }
            let symbol: Symbol = topics.get(0).unwrap().try_into_val(&f.env).unwrap();
            if symbol != Symbol::new(&f.env, "init") {
                continue;
            }
            let emitted_admin: Address = topics.get(1).unwrap().try_into_val(&f.env).unwrap();
            let configuration: (Address, Address, Address) = data.try_into_val(&f.env).unwrap();
            assert_eq!(emitted_admin, f.admin);
            assert_eq!(
                configuration,
                (f.treasury.clone(), f.usdc.clone(), f.xlm_sac.clone())
            );
            found = true;
        }
        assert!(found, "init event not found");
    }

    // ── per-address role storage tests ───────────────────────────────────────

    #[test]
    fn test_role_storage_is_independent_per_address() {
        let f = Fixture::new();
        f.init();

        let alice = Address::generate(&f.env);
        let bob = Address::generate(&f.env);

        f.client().grant_role(&alice, &Role::Admin);
        f.client().grant_role(&bob, &Role::Viewer);

        // Each address's role is stored under its own key — granting/
        // revoking one must never affect the other.
        assert_eq!(f.client().get_role(&alice), Some(Role::Admin));
        assert_eq!(f.client().get_role(&bob), Some(Role::Viewer));

        f.client().revoke_role(&alice);
        assert_eq!(f.client().get_role(&alice), None);
        assert_eq!(f.client().get_role(&bob), Some(Role::Viewer)); // untouched
    }

    #[test]
    fn test_grant_role_overwrites_previous_role_for_same_address() {
        let f = Fixture::new();
        f.init();

        let user = Address::generate(&f.env);
        f.client().grant_role(&user, &Role::Viewer);
        assert_eq!(f.client().get_role(&user), Some(Role::Viewer));

        f.client().grant_role(&user, &Role::Admin);
        assert_eq!(f.client().get_role(&user), Some(Role::Admin));
    }

    // ── grant_roles (batch) tests ─────────────────────────────────────────────

    #[test]
    fn test_grant_roles_grants_same_role_to_all_addresses() {
        let f = Fixture::new();
        f.init();

        let alice = Address::generate(&f.env);
        let bob = Address::generate(&f.env);
        let carol = Address::generate(&f.env);
        let addresses = soroban_sdk::vec![&f.env, alice.clone(), bob.clone(), carol.clone()];

        f.client().grant_roles(&addresses, &Role::Operator);

        assert_eq!(
            contract_event_count(&f.env, &f.contract_id, "role_granted"),
            3
        );
        assert_eq!(f.client().get_role(&alice), Some(Role::Operator));
        assert_eq!(f.client().get_role(&bob), Some(Role::Operator));
        assert_eq!(f.client().get_role(&carol), Some(Role::Operator));
    }

    #[test]
    #[should_panic]
    fn test_grant_roles_requires_admin_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let usdc = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let xlm_sac = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let contract_id = env.register(Stellar_CardReceiver, ());
        let client = Stellar_CardReceiverClient::new(&env, &contract_id);

        env.mock_all_auths();
        client.init(&admin, &treasury, &usdc, &xlm_sac);

        env.mock_auths(&[]);
        let addresses = soroban_sdk::vec![&env, Address::generate(&env)];
        client.grant_roles(&addresses, &Role::Viewer);
    }

    #[test]
    fn test_grant_roles_empty_list_is_noop() {
        let f = Fixture::new();
        f.init();

        let empty: Vec<Address> = soroban_sdk::vec![&f.env];
        f.client().grant_roles(&empty, &Role::Viewer); // must not panic

        let someone = Address::generate(&f.env);
        assert_eq!(f.client().get_role(&someone), None);
    }

    #[test]
    fn test_grant_roles_does_not_disturb_roles_outside_the_batch() {
        let f = Fixture::new();
        f.init();

        let already_admin = Address::generate(&f.env);
        f.client().grant_role(&already_admin, &Role::Admin);

        let batch = soroban_sdk::vec![&f.env, Address::generate(&f.env), Address::generate(&f.env)];
        f.client().grant_roles(&batch, &Role::Viewer);

        // Granting a batch of Viewer roles must not touch an address that
        // was never part of the batch.
        assert_eq!(f.client().get_role(&already_admin), Some(Role::Admin));
    }

    // ── TTL threshold optimization tests ──────────────────────────────────────

    #[test]
    fn test_instance_ttl_extension_is_skipped_once_already_healthy() {
        use soroban_sdk::testutils::storage::Instance;

        let f = Fixture::new();
        f.init();

        // The test network's own max_entry_ttl setting caps how far any
        // single extend_ttl call can push the TTL, so we don't assert
        // against an absolute value — only that init() performed a real
        // extension at all.
        let ttl_after_init = f
            .env
            .as_contract(&f.contract_id, || f.env.storage().instance().get_ttl());
        assert!(ttl_after_init > 0, "TTL after init should be positive");

        // A second admin-gated call (grant_role) while the TTL is already
        // above INSTANCE_TTL_THRESHOLD must be a genuine no-op on the TTL —
        // proving extend_instance_ttl's threshold check actually skips
        // redundant extension work, not just that it compiles.
        let user = Address::generate(&f.env);
        f.client().grant_role(&user, &Role::Viewer);
        let ttl_after_second_call = f
            .env
            .as_contract(&f.contract_id, || f.env.storage().instance().get_ttl());
        assert_eq!(
            ttl_after_second_call, ttl_after_init,
            "a second call while TTL is already above the threshold should not re-extend it"
        );
    }

    #[test]
    fn test_ttl_threshold_is_strictly_below_max() {
        // The entire point of the threshold/max split: if they were equal
        // (the contract's original pattern), almost every call would
        // re-extend, since any decrease at all drops below the threshold.
        assert!(INSTANCE_TTL_THRESHOLD < INSTANCE_TTL_MAX);
        assert_eq!(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_MAX / 2);
    }

    #[test]
    fn test_role_ttl_extension_is_skipped_once_already_healthy() {
        use soroban_sdk::testutils::storage::Persistent;

        let f = Fixture::new();
        f.init();

        let user = Address::generate(&f.env);
        f.client().grant_role(&user, &Role::Viewer);

        let key = DataKey::UserRole(user.clone());
        let ttl_after_first_grant = f.env.as_contract(&f.contract_id, || {
            f.env.storage().persistent().get_ttl(&key)
        });
        assert!(
            ttl_after_first_grant > 0,
            "TTL after grant should be positive"
        );

        // Re-granting a role to the same address while its entry's TTL is
        // already above the threshold must be a genuine no-op on the TTL —
        // proving extend_role_ttl's threshold check actually skips
        // redundant extension work, not just that it compiles (Issue #415
        // - Part 4).
        f.client().grant_role(&user, &Role::Operator);
        let ttl_after_second_grant = f.env.as_contract(&f.contract_id, || {
            f.env.storage().persistent().get_ttl(&key)
        });
        assert_eq!(
            ttl_after_second_grant, ttl_after_first_grant,
            "re-granting a role while its TTL is already above the threshold should not re-extend it"
        );
    }

    // ── Token transfer tests (Issue #393 - Part 2) ────────────────────────────
    //
    // The earlier transfer tests check balances, amounts and events. These
    // pin down what the SAC `transfer` sees: who authorizes it, with which
    // arguments, and what happens when the token itself refuses to move.

    /// The auth tree `from` signs for `pay_<token>`: the receiver call, with
    /// the SAC `transfer(from, treasury, amount)` nested beneath it.
    fn expected_payment_auth(
        f: &Fixture,
        fn_name: &str,
        token: &Address,
        amount: i128,
        order_id: &Bytes,
    ) -> (Address, AuthorizedInvocation) {
        (
            f.payer.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    f.contract_id.clone(),
                    Symbol::new(&f.env, fn_name),
                    (f.payer.clone(), amount, order_id.clone()).into_val(&f.env),
                )),
                sub_invocations: std::vec![AuthorizedInvocation {
                    function: AuthorizedFunction::Contract((
                        token.clone(),
                        Symbol::new(&f.env, "transfer"),
                        (f.payer.clone(), f.treasury.clone(), amount).into_val(&f.env),
                    )),
                    sub_invocations: std::vec![],
                }],
            },
        )
    }

    #[test]
    fn test_pay_usdc_payer_authorizes_exactly_one_transfer_to_treasury() {
        let f = Fixture::new();
        f.init();
        let amount: i128 = 4_200_000;
        let order = order_bytes(&f.env, "auth-usdc");
        f.mint_usdc(&f.payer, amount);

        f.client().pay_usdc(&f.payer, &amount, &order);

        // Only the payer signs, and only for a transfer of exactly `amount`
        // to the configured treasury — no other address or amount.
        assert_eq!(
            f.env.auths(),
            std::vec![expected_payment_auth(
                &f, "pay_usdc", &f.usdc, amount, &order
            )]
        );
    }

    #[test]
    fn test_pay_xlm_payer_authorizes_exactly_one_transfer_to_treasury() {
        let f = Fixture::new();
        f.init();
        let amount: i128 = 1_500_000;
        let order = order_bytes(&f.env, "auth-xlm");
        f.mint_xlm(&f.payer, amount);

        f.client().pay_xlm(&f.payer, &amount, &order);

        assert_eq!(
            f.env.auths(),
            std::vec![expected_payment_auth(
                &f, "pay_xlm", &f.xlm_sac, amount, &order
            )]
        );
    }

    #[test]
    fn test_pay_usdc_auth_not_covering_token_transfer_returns_transfer_failed() {
        let f = Fixture::new();
        f.init();
        let amount: i128 = 2_000_000;
        let order = order_bytes(&f.env, "no-sub-auth");
        f.mint_usdc(&f.payer, amount);

        // The payer signs `pay_usdc` itself but not the nested SAC transfer,
        // so the token must refuse to move funds.
        let result = f
            .client()
            .mock_auths(&[MockAuth {
                address: &f.payer,
                invoke: &MockAuthInvoke {
                    contract: &f.contract_id,
                    fn_name: "pay_usdc",
                    args: (&f.payer, amount, &order).into_val(&f.env),
                    sub_invokes: &[],
                },
            }])
            .try_pay_usdc(&f.payer, &amount, &order);

        assert_eq!(result, Err(Ok(Error::TransferFailed)));
        assert_eq!(f.usdc_balance(&f.payer), amount);
        assert_eq!(f.usdc_balance(&f.treasury), 0);
        assert_eq!(contract_event_count(&f.env, &f.contract_id, "pay_usdc"), 0);
    }

    /// A fixture whose USDC and XLM SACs have an `AUTH_REVOCABLE` issuer, so
    /// the issuer can freeze a holder with `set_authorized(holder, false)`.
    fn revocable_fixture() -> Fixture {
        let mut f = Fixture::new();
        for token in [&mut f.usdc, &mut f.xlm_sac] {
            let sac = f.env.register_stellar_asset_contract_v2(f.admin.clone());
            sac.issuer().set_flag(IssuerFlags::RevocableFlag);
            *token = sac.address();
        }
        f.init();
        f
    }

    #[test]
    fn test_pay_usdc_from_deauthorized_holder_returns_transfer_failed() {
        let f = revocable_fixture();
        let amount: i128 = 3_000_000;
        f.mint_usdc(&f.payer, amount);

        // The issuer freezes the payer's trustline (e.g. a compliance hold).
        token::StellarAssetClient::new(&f.env, &f.usdc).set_authorized(&f.payer, &false);

        let result = f
            .client()
            .try_pay_usdc(&f.payer, &amount, &order_bytes(&f.env, "frozen"));
        assert_eq!(result, Err(Ok(Error::TransferFailed)));
        assert_eq!(f.usdc_balance(&f.payer), amount);
        assert_eq!(f.usdc_balance(&f.treasury), 0);
        assert!(!reentrancy_guard_is_held(&f));
    }

    #[test]
    fn test_pay_xlm_from_deauthorized_holder_returns_transfer_failed() {
        let f = revocable_fixture();
        let amount: i128 = 3_000_000;
        f.mint_xlm(&f.payer, amount);
        token::StellarAssetClient::new(&f.env, &f.xlm_sac).set_authorized(&f.payer, &false);

        let result = f
            .client()
            .try_pay_xlm(&f.payer, &amount, &order_bytes(&f.env, "frozen"));
        assert_eq!(result, Err(Ok(Error::TransferFailed)));
        assert_eq!(f.xlm_balance(&f.payer), amount);
        assert_eq!(f.xlm_balance(&f.treasury), 0);
    }

    #[test]
    fn test_pay_usdc_can_spend_entire_balance() {
        let f = Fixture::new();
        f.init();
        let amount: i128 = 7_777_777;
        f.mint_usdc(&f.payer, amount);

        f.client()
            .pay_usdc(&f.payer, &amount, &order_bytes(&f.env, "all-in"));
        assert_eq!(f.usdc_balance(&f.payer), 0);
        assert_eq!(f.usdc_balance(&f.treasury), amount);

        // With the balance exhausted, even one stroop more must fail cleanly.
        let result = f
            .client()
            .try_pay_usdc(&f.payer, &1, &order_bytes(&f.env, "one-more"));
        assert_eq!(result, Err(Ok(Error::TransferFailed)));
    }

    #[test]
    fn test_rejected_payments_require_no_signature() {
        let f = Fixture::new();
        f.init();
        f.client().pause(&f.admin);

        // Pause and amount checks run before `from.require_auth()`, so a
        // rejected payment returns its error even with no auth mocked at all
        // and never consumes a signature.
        let client = f.client().mock_auths(&[]);
        let order = order_bytes(&f.env, "no-sig");
        assert_eq!(
            client.try_pay_usdc(&f.payer, &1, &order),
            Err(Ok(Error::ContractPaused))
        );
        assert_eq!(
            client.try_pay_xlm(&f.payer, &1, &order),
            Err(Ok(Error::ContractPaused))
        );

        f.client().unpause();
        let client = f.client().mock_auths(&[]);
        assert_eq!(
            client.try_pay_usdc(&f.payer, &0, &order),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            client.try_pay_xlm(&f.payer, &-1, &order),
            Err(Ok(Error::InvalidAmount))
        );
    }

    #[test]
    fn test_payments_still_reach_treasury_after_admin_transfer() {
        let f = Fixture::new();
        f.init();
        let new_admin = Address::generate(&f.env);
        f.client().transfer_admin(&new_admin);

        let amount: i128 = 1_000_000;
        f.mint_usdc(&f.payer, amount);
        f.mint_xlm(&f.payer, amount);
        f.client()
            .pay_usdc(&f.payer, &amount, &order_bytes(&f.env, "post-handover"));
        f.client()
            .pay_xlm(&f.payer, &amount, &order_bytes(&f.env, "post-handover"));

        // The treasury is independent of the admin: neither the old nor the
        // new admin receives payment funds.
        assert_eq!(f.usdc_balance(&f.treasury), amount);
        assert_eq!(f.xlm_balance(&f.treasury), amount);
        assert_eq!(f.usdc_balance(&f.admin), 0);
        assert_eq!(f.usdc_balance(&new_admin), 0);
    }

    // ── RBAC tests (Issue #394 - Part 2) ──────────────────────────────────────

    #[test]
    fn test_role_rank_matrix_matches_hierarchy() {
        let roles = [Role::Viewer, Role::Operator, Role::Admin];
        for (held_rank, held) in roles.iter().enumerate() {
            for (required_rank, required) in roles.iter().enumerate() {
                assert_eq!(
                    Stellar_CardReceiver::is_role_sufficient(held, required),
                    held_rank >= required_rank,
                    "{:?} vs required {:?}",
                    held,
                    required
                );
            }
        }
    }

    #[test]
    fn test_transfer_admin_moves_admin_role_to_new_admin() {
        let f = Fixture::new();
        f.init();
        let new_admin = Address::generate(&f.env);

        f.client().transfer_admin(&new_admin);

        // `events().all()` only covers the last invocation, so count the
        // handover's events before calling any getter.
        assert_eq!(
            contract_event_count(&f.env, &f.contract_id, "role_revoked"),
            1
        );
        assert_eq!(
            contract_event_count(&f.env, &f.contract_id, "role_granted"),
            1
        );
        assert_eq!(f.client().get_role(&f.admin), None);
        assert_eq!(f.client().get_role(&new_admin), Some(Role::Admin));
    }

    #[test]
    #[should_panic(expected = "pause requires at least the Operator role")]
    fn test_old_admin_cannot_pause_after_transfer() {
        let f = Fixture::new();
        f.init();
        f.client().transfer_admin(&Address::generate(&f.env));
        f.client().pause(&f.admin);
    }

    #[test]
    #[should_panic(expected = "rescue_tokens requires the Admin role")]
    fn test_old_admin_cannot_rescue_tokens_after_transfer() {
        let f = Fixture::new();
        f.init();
        f.mint_usdc(&f.contract_id, 1_000);
        f.client().transfer_admin(&Address::generate(&f.env));
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &f.admin, &1_000);
    }

    #[test]
    #[should_panic(expected = "set_withdraw_limits requires the Admin role")]
    fn test_old_admin_cannot_set_withdraw_limits_after_transfer() {
        let f = Fixture::new();
        f.init();
        f.client().transfer_admin(&Address::generate(&f.env));
        f.client().set_withdraw_limits(&f.admin, &Some(1), &None);
    }

    #[test]
    fn test_transfer_admin_keeps_non_admin_role_of_old_admin() {
        let f = Fixture::new();
        f.init();
        // The admin deliberately holds only Operator before handing over.
        f.client().grant_role(&f.admin, &Role::Operator);

        f.client().transfer_admin(&Address::generate(&f.env));

        assert_eq!(f.client().get_role(&f.admin), Some(Role::Operator));
        f.client().pause(&f.admin); // Operator may still pause
        assert!(f.client().is_paused_view());
    }

    #[test]
    fn test_transfer_admin_to_new_admin_already_holding_admin_role_emits_no_grant() {
        let f = Fixture::new();
        f.init();
        let new_admin = Address::generate(&f.env);
        f.client().grant_role(&new_admin, &Role::Admin);

        f.client().transfer_admin(&new_admin);

        assert_eq!(
            contract_event_count(&f.env, &f.contract_id, "role_granted"),
            0
        );
        assert_eq!(f.client().get_role(&new_admin), Some(Role::Admin));
    }

    #[test]
    fn test_transfer_admin_to_self_changes_no_roles() {
        let f = Fixture::new();
        f.init();

        f.client().transfer_admin(&f.admin);

        assert_eq!(
            contract_event_count(&f.env, &f.contract_id, "role_revoked"),
            0
        );
        assert_eq!(
            contract_event_count(&f.env, &f.contract_id, "role_granted"),
            0
        );
        assert_eq!(
            contract_event_count(&f.env, &f.contract_id, "admin_transferred"),
            1
        );
        assert_eq!(f.client().admin(), f.admin);
        assert_eq!(f.client().get_role(&f.admin), Some(Role::Admin));
    }

    #[test]
    fn test_stored_admin_keeps_authority_after_renouncing_role() {
        let f = Fixture::new();
        f.init();
        f.client().renounce_role(&f.admin);
        assert!(!f.client().has_role(&f.admin, &Role::Viewer));

        // The stored admin is the root of trust: every role-gated
        // entrypoint still accepts it without a role entry.
        f.client().pause(&f.admin);
        assert!(f.client().is_paused_view());
        f.client().set_withdraw_limits(&f.admin, &Some(500), &None);
        f.mint_usdc(&f.contract_id, 500);
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &f.treasury, &500);
        assert_eq!(f.usdc_balance(&f.treasury), 500);
    }

    #[test]
    #[should_panic(expected = "pause requires at least the Operator role")]
    fn test_revoked_operator_can_no_longer_pause() {
        let f = Fixture::new();
        f.init();
        let operator = Address::generate(&f.env);
        f.client().grant_role(&operator, &Role::Operator);
        f.client().revoke_role(&operator);
        f.client().pause(&operator);
    }

    #[test]
    fn test_demoted_admin_role_holder_loses_rescue_but_keeps_pause() {
        let f = Fixture::new();
        f.init();
        let ops = Address::generate(&f.env);
        f.client().grant_role(&ops, &Role::Admin);
        f.client().grant_role(&ops, &Role::Operator);

        f.mint_usdc(&f.contract_id, 10);
        let rescue = f.client().try_rescue_tokens(&ops, &f.usdc, &ops, &10);
        assert!(rescue.is_err());
        assert_eq!(f.usdc_balance(&f.contract_id), 10);

        f.client().pause(&ops);
        assert!(f.client().is_paused_view());
    }

    // ── Storage footprint tests (Issue #395 - Part 2, Issue #636) ─────────────

    fn has_instance_key(f: &Fixture, key: &DataKey) -> bool {
        f.env
            .as_contract(&f.contract_id, || f.env.storage().instance().has(key))
    }

    fn instance_config(f: &Fixture) -> Option<Config> {
        f.env
            .as_contract(&f.contract_id, || f.env.storage().instance().get(&DataKey::Config))
    }

    fn daily_withdrawn_slot(f: &Fixture) -> Option<(u64, i128)> {
        f.env.as_contract(&f.contract_id, || {
            f.env.storage().instance().get(&DataKey::DailyWithdrawn)
        })
    }

    #[test]
    fn test_init_packs_config_into_single_slot() {
        let f = Fixture::new();
        f.init();
        // Issue #636: admin, treasury, and paused live in one packed slot.
        assert!(has_instance_key(&f, &DataKey::Config));
        assert!(!has_instance_key(&f, &DataKey::Admin));
        assert!(!has_instance_key(&f, &DataKey::Treasury));
        assert!(!has_instance_key(&f, &DataKey::Paused));

        let cfg = instance_config(&f).expect("Config slot present after init");
        assert_eq!(cfg.admin, f.admin);
        assert_eq!(cfg.treasury, f.treasury);
        assert!(!cfg.paused);
        assert!(!f.client().is_paused_view());
    }

    #[test]
    fn test_pause_and_unpause_write_packed_config() {
        let f = Fixture::new();
        f.init();
        f.client().pause(&f.admin);
        let cfg = instance_config(&f).unwrap();
        assert!(cfg.paused);
        assert!(f.client().is_paused_view());
        // The legacy Paused key is never (re)created.
        assert!(!has_instance_key(&f, &DataKey::Paused));

        f.client().unpause();
        let cfg = instance_config(&f).unwrap();
        assert!(!cfg.paused);
        assert!(!f.client().is_paused_view());
    }

    #[test]
    fn test_config_reads_legacy_layout_until_first_write() {
        // Simulate a pre-#636 instance that still holds the per-key layout,
        // then verify the packed reader falls back and the first write
        // migrates (retires the legacy keys).
        let f = Fixture::new();
        f.init();
        // Downgrade to the legacy layout.
        f.env.as_contract(&f.contract_id, || {
            let cfg = f.env.storage().instance().get::<_, Config>(&DataKey::Config).unwrap();
            f.env.storage().instance().set(&DataKey::Admin, &cfg.admin);
            f.env
                .storage()
                .instance()
                .set(&DataKey::Treasury, &cfg.treasury);
            f.env
                .storage()
                .instance()
                .set(&DataKey::Paused, &cfg.paused);
            f.env.storage().instance().remove(&DataKey::Config);
        });
        assert!(!has_instance_key(&f, &DataKey::Config));
        assert!(has_instance_key(&f, &DataKey::Admin));

        // Reads fall back to the legacy keys.
        assert_eq!(f.client().admin(), f.admin);
        assert_eq!(f.client().treasury(), f.treasury);
        assert!(!f.client().is_paused_view());

        // A write migrates: packed slot present, legacy keys gone.
        f.client().pause(&f.admin);
        assert!(has_instance_key(&f, &DataKey::Config));
        assert!(!has_instance_key(&f, &DataKey::Admin));
        assert!(!has_instance_key(&f, &DataKey::Treasury));
        assert!(!has_instance_key(&f, &DataKey::Paused));
        let cfg = instance_config(&f).unwrap();
        assert_eq!(cfg.admin, f.admin);
        assert_eq!(cfg.treasury, f.treasury);
        assert!(cfg.paused);
    }

    #[test]
    fn test_update_treasury_and_transfer_admin_write_packed_config() {
        let f = Fixture::new();
        f.init();
        let new_treasury = Address::generate(&f.env);
        let new_admin = Address::generate(&f.env);
        f.client().update_treasury(&new_treasury);
        f.client().transfer_admin(&new_admin);

        let cfg = instance_config(&f).unwrap();
        assert_eq!(cfg.treasury, new_treasury);
        assert_eq!(cfg.admin, new_admin);
        assert!(!has_instance_key(&f, &DataKey::Admin));
        assert!(!has_instance_key(&f, &DataKey::Treasury));
    }

    #[test]
    fn test_reentrancy_guard_leaves_no_temporary_entry_behind() {
        let f = Fixture::new();
        f.init();
        let amount: i128 = 1_000_000;
        f.mint_usdc(&f.payer, amount);
        f.mint_xlm(&f.payer, amount);

        f.client()
            .pay_usdc(&f.payer, &amount, &order_bytes(&f.env, "tmp-1"));
        f.client()
            .pay_xlm(&f.payer, &amount, &order_bytes(&f.env, "tmp-2"));
        // A failed transfer must clean up too.
        let _ = f
            .client()
            .try_pay_usdc(&f.payer, &amount, &order_bytes(&f.env, "tmp-3"));

        let present = f.env.as_contract(&f.contract_id, || {
            f.env.storage().temporary().has(&DataKey::ReentrancyGuard)
        });
        assert!(!present, "guard entry must be removed, not set to false");
    }

    #[test]
    fn test_daily_withdrawn_uses_one_slot_across_days() {
        let f = Fixture::new();
        f.init();
        f.client()
            .set_withdraw_limits(&f.admin, &None, &Some(1_000));
        f.mint_usdc(&f.contract_id, 10_000);
        let destination = Address::generate(&f.env);

        for day in 0..5u64 {
            f.client()
                .rescue_tokens(&f.admin, &f.usdc, &destination, &600);
            f.client()
                .rescue_tokens(&f.admin, &f.usdc, &destination, &400);
            let today = f.env.ledger().timestamp() / 86_400;
            assert_eq!(
                daily_withdrawn_slot(&f),
                Some((today, 1_000)),
                "day {}",
                day
            );
            f.env.ledger().with_mut(|li| li.timestamp += 86_400);
        }
        assert_eq!(f.usdc_balance(&destination), 5_000);
    }

    #[test]
    fn test_failed_first_rescue_of_the_day_leaves_no_accumulator_slot() {
        let f = Fixture::new();
        f.init();
        // The contract holds nothing, so the transfer fails.
        let result = f
            .client()
            .try_rescue_tokens(&f.admin, &f.usdc, &f.treasury, &100);
        assert_eq!(result, Err(Ok(Error::TransferFailed)));
        assert_eq!(daily_withdrawn_slot(&f), None);
    }

    #[test]
    fn test_failed_rescue_restores_todays_total() {
        let f = Fixture::new();
        f.init();
        f.mint_usdc(&f.contract_id, 100);
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &f.treasury, &100);

        let result = f
            .client()
            .try_rescue_tokens(&f.admin, &f.usdc, &f.treasury, &50);
        assert_eq!(result, Err(Ok(Error::TransferFailed)));
        let today = f.env.ledger().timestamp() / 86_400;
        assert_eq!(daily_withdrawn_slot(&f), Some((today, 100)));
    }

    #[test]
    fn test_stale_daily_slot_from_previous_day_reads_as_zero() {
        let f = Fixture::new();
        f.init();
        f.env.as_contract(&f.contract_id, || {
            assert_eq!(Stellar_CardReceiver::withdrawn_on(&f.env, 0), 0);
            Stellar_CardReceiver::set_withdrawn(&f.env, 3, 900);
            assert_eq!(Stellar_CardReceiver::withdrawn_on(&f.env, 3), 900);
            assert_eq!(Stellar_CardReceiver::withdrawn_on(&f.env, 4), 0);
            Stellar_CardReceiver::set_withdrawn(&f.env, 4, 0);
            assert!(!f.env.storage().instance().has(&DataKey::DailyWithdrawn));
        });
    }

    #[test]
    fn test_regranting_same_role_writes_no_ledger_entries() {
        let f = Fixture::new();
        f.init();
        let user = Address::generate(&f.env);

        f.client().grant_role(&user, &Role::Operator);
        let first = f.env.cost_estimate().resources();

        f.client().grant_role(&user, &Role::Operator);
        let repeat = f.env.cost_estimate().resources();

        // Both calls also write the admin's auth nonce, so the difference is
        // exactly the role entry the repeat grant no longer rewrites.
        assert_eq!(
            repeat.write_entries,
            first.write_entries - 1,
            "re-granting an unchanged role must not rewrite its entry"
        );
        assert_eq!(f.client().get_role(&user), Some(Role::Operator));
    }

    #[test]
    fn test_instance_storage_does_not_grow_with_payments() {
        let f = Fixture::new();
        f.init();
        let amount: i128 = 1_000;
        f.mint_usdc(&f.payer, amount * 11);

        // The first payment creates the treasury's balance entry, so measure
        // from the second one, once every touched entry already exists.
        f.client()
            .pay_usdc(&f.payer, &amount, &order_bytes(&f.env, "size-0"));
        f.client()
            .pay_usdc(&f.payer, &amount, &order_bytes(&f.env, "size-1"));
        let baseline = f.env.cost_estimate().resources().read_bytes;
        for i in 2..10 {
            let id = [b's', b'-', b'0' + i as u8];
            f.client()
                .pay_usdc(&f.payer, &amount, &Bytes::from_slice(&f.env, &id));
        }
        let after = f.env.cost_estimate().resources().read_bytes;
        // The temporary PaymentRateLimit vector records one ledger number per
        // in-window payment (~8 bytes each), so a bounded increase is expected.
        // Anything beyond that means instance storage is growing per payment.
        assert!(
            after <= baseline + 256,
            "payment read footprint grew from {} to {} bytes",
            baseline,
            after
        );
    }

    // ── Admin config update event tests ───────────────────────────────────────

    #[test]
    fn test_update_treasury_emits_event() {
        let f = Fixture::new();
        f.init();

        let new_treasury = Address::generate(&f.env);
        f.client().update_treasury(&new_treasury);

        // Verify event was emitted. `events().all()` covers only the latest
        // invocation, so read it before any further client calls.
        let events = f.env.events().all();
        let event = events.last().unwrap();
        assert_eq!(event.0, f.contract_id);

        let topics = event.1;
        let t0: Symbol = topics.get(0).unwrap().try_into_val(&f.env).unwrap();
        let t1: Address = topics.get(1).unwrap().try_into_val(&f.env).unwrap();
        let t2: Address = topics.get(2).unwrap().try_into_val(&f.env).unwrap();
        assert_eq!(t0, Symbol::new(&f.env, "treasury_updated"));
        assert_eq!(t1, f.treasury); // old treasury
        assert_eq!(t2, new_treasury); // new treasury

        let data: Address = event.2.try_into_val(&f.env).unwrap();
        assert_eq!(data, f.admin); // admin is in event data

        // Verify treasury was actually updated
        assert_eq!(f.client().treasury(), new_treasury);
    }

    #[test]
    fn test_update_usdc_contract_emits_event() {
        let f = Fixture::new();
        f.init();

        let new_usdc = Address::generate(&f.env);
        f.client().update_usdc_contract(&new_usdc);

        // `events().all()` covers only the latest invocation, so read it
        // before any further client calls.
        let events = f.env.events().all();
        let event = events.last().unwrap();
        assert_eq!(event.0, f.contract_id);

        let topics = event.1;
        let t0: Symbol = topics.get(0).unwrap().try_into_val(&f.env).unwrap();
        let t1: Symbol = topics.get(1).unwrap().try_into_val(&f.env).unwrap();
        let t2: Address = topics.get(2).unwrap().try_into_val(&f.env).unwrap();
        let t3: Address = topics.get(3).unwrap().try_into_val(&f.env).unwrap();
        assert_eq!(t0, Symbol::new(&f.env, "token_contract_updated"));
        assert_eq!(t1, symbol_short!("USDC")); // asset symbol
        assert_eq!(t2, f.usdc); // old contract
        assert_eq!(t3, new_usdc); // new contract

        let data: Address = event.2.try_into_val(&f.env).unwrap();
        assert_eq!(data, f.admin); // admin is in event data

        // Verify USDC contract was actually updated
        assert_eq!(f.client().usdc_contract(), new_usdc);
    }

    #[test]
    fn test_update_xlm_contract_emits_event() {
        let f = Fixture::new();
        f.init();

        let new_xlm = Address::generate(&f.env);
        f.client().update_xlm_contract(&new_xlm);

        // `events().all()` covers only the latest invocation, so read it
        // before any further client calls.
        let events = f.env.events().all();
        let event = events.last().unwrap();
        assert_eq!(event.0, f.contract_id);

        let topics = event.1;
        let t0: Symbol = topics.get(0).unwrap().try_into_val(&f.env).unwrap();
        let t1: Symbol = topics.get(1).unwrap().try_into_val(&f.env).unwrap();
        let t2: Address = topics.get(2).unwrap().try_into_val(&f.env).unwrap();
        let t3: Address = topics.get(3).unwrap().try_into_val(&f.env).unwrap();
        assert_eq!(t0, Symbol::new(&f.env, "token_contract_updated"));
        assert_eq!(t1, symbol_short!("XLM")); // asset symbol
        assert_eq!(t2, f.xlm_sac); // old contract
        assert_eq!(t3, new_xlm); // new contract

        let data: Address = event.2.try_into_val(&f.env).unwrap();
        assert_eq!(data, f.admin); // admin is in event data

        // Verify XLM contract was actually updated
        assert_eq!(f.client().xlm_contract(), new_xlm);
    }

    // ── Documentation consistency tests (Issue #396 - Part 2) ─────────────────

    /// The `Error` docs promise stable numeric codes that clients match on;
    /// renumbering a variant would silently break every client.
    #[test]
    fn test_error_codes_match_documented_abi() {
        assert_eq!(Error::InvalidAmount as u32, 1);
        assert_eq!(Error::TransferFailed as u32, 2);
        assert_eq!(Error::ContractPaused as u32, 3);
        assert_eq!(Error::WithdrawLimitExceeded as u32, 4);
        assert_eq!(Error::DailyWithdrawLimitExceeded as u32, 5);
        assert_eq!(Error::InvalidRecipient as u32, 6);
        assert_eq!(Error::InvalidTreasurySplits as u32, 7);
        assert_eq!(Error::InvalidDiscount as u32, 14);
        assert_eq!(Error::InvalidMetadata as u32, 8);
    assert_eq!(Error::ArithmeticOverflow as u32, 9);
    assert_eq!(Error::RateLimitExceeded as u32, 10);
    assert_eq!(Error::InvalidRateLimit as u32, 11);
    }

    /// The crate docs state `TOKEN_DECIMALS` is 7 and that the TTL threshold
    /// is half the max; keep the documented values honest.
    #[test]
    fn test_documented_constants() {
        assert_eq!(TOKEN_DECIMALS, 7);
        assert_eq!(INSTANCE_TTL_THRESHOLD * 2, INSTANCE_TTL_MAX);
    }

    // ── Issue #682: ledger close boundary conditions ────────────────────────

    /// The daily withdraw accumulator is keyed to `ledger.timestamp / 86_400`,
    /// so it must reset when the ledger clock crosses the day boundary.
    #[test]
    fn test_withdrawn_today_resets_at_day_ledger_boundary() {
        let f = Fixture::new();
        f.init();

        f.client()
            .set_withdraw_limits(&f.admin, &Some(500_000), &Some(1_000_000));
        f.mint_usdc(&f.contract_id, 750_000);

        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &f.treasury, &250_000);
        assert_eq!(
            f.client().withdrawn_today(),
            250_000,
            "today's accumulator should reflect the rescue"
        );

        // Cross the ledger day boundary (00:00 UTC rollover).
        f.env.ledger().with_mut(|li| li.timestamp += 86_400);

        assert_eq!(
            f.client().withdrawn_today(),
            0,
            "withdrawn_today must reset at the ledger day boundary"
        );

        // The full daily budget is available again on the new day.
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &f.treasury, &500_000);
        assert_eq!(
            f.client().withdrawn_today(),
            500_000,
            "new day's accumulator should reflect the second rescue"
        );
    }

    /// The instance TTL threshold is deliberately half the max: a write near
    /// ledger close extends to INSTANCE_TTL_MAX without re-billing an entry
    /// that already carries full TTL.
    #[test]
    fn test_instance_ttl_threshold_boundary() {
        assert_eq!(INSTANCE_TTL_THRESHOLD * 2, INSTANCE_TTL_MAX);
        assert!(INSTANCE_TTL_THRESHOLD < INSTANCE_TTL_MAX);

        let f = Fixture::new();
        f.init();

        f.client()
            .set_withdraw_limits(&f.admin, &Some(100_000), &Some(200_000));

        // The write landed, proving instance TTL was extended at the boundary.
        let (per_call, per_day) = f.client().withdraw_limits();
        assert_eq!(per_call, Some(100_000));
        assert_eq!(per_day, Some(200_000));
    }

    /// Exhausting the daily budget just before ledger close must not block a
    /// rescue seconds after close: the daily limit rolls over at day boundary.
    #[test]
    fn test_rescue_daily_limit_boundary_at_day_rollover() {
        let f = Fixture::new();
        f.init();

        f.client()
            .set_withdraw_limits(&f.admin, &Some(100_000), &Some(100_000));
        f.mint_usdc(&f.contract_id, 200_000);

        // Exhaust the entire day's budget just before the boundary.
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &f.treasury, &100_000);
        assert_eq!(
            f.client()
                .try_rescue_tokens(&f.admin, &f.usdc, &f.treasury, &1),
            Err(Ok(Error::DailyWithdrawLimitExceeded)),
            "same-day rescue past the daily limit must be rejected"
        );

        // Cross the ledger day boundary.
        f.env.ledger().with_mut(|li| li.timestamp += 86_400);

        // A fresh day means a fresh budget.
        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &f.treasury, &100_000);
        assert_eq!(
            f.client().withdrawn_today(),
            100_000,
            "new day's accumulator holds only the new day's rescue"
        );
    }

    // ── Issue #678: Zero-amount token transfer validation ──────────────────────────

    #[test]
    fn test_pay_usdc_with_zero_amount_returns_invalid_amount() {
        let f = Fixture::new();
        f.init();
        let result = f.client().try_pay_usdc(&f.payer, &0, &order_bytes(&f.env, "zero"));
        assert_eq!(result, Err(Ok(Error::InvalidAmount)));
    }

    #[test]
    fn test_pay_usdc_with_negative_amount_returns_invalid_amount() {
        let f = Fixture::new();
        f.init();
        let result = f.client().try_pay_usdc(&f.payer, &-100, &order_bytes(&f.env, "neg"));
        assert_eq!(result, Err(Ok(Error::InvalidAmount)));
    }

    #[test]
    fn test_pay_xlm_with_zero_amount_returns_invalid_amount() {
        let f = Fixture::new();
        f.init();
        let result = f.client().try_pay_xlm(&f.payer, &0, &order_bytes(&f.env, "zero"));
        assert_eq!(result, Err(Ok(Error::InvalidAmount)));
    }

    #[test]
    fn test_pay_xlm_with_negative_amount_returns_invalid_amount() {
        let f = Fixture::new();
        f.init();
        let result = f.client().try_pay_xlm(&f.payer, &-100, &order_bytes(&f.env, "neg"));
        assert_eq!(result, Err(Ok(Error::InvalidAmount)));
    }

    // ── Issue #679: Treasury split routing ─────────────────────────────────────────

    #[test]
    fn test_set_treasury_splits_with_valid_splits() {
        let f = Fixture::new();
        f.init();
        let treasury2 = Address::generate(&f.env);
        let treasury3 = Address::generate(&f.env);

        let splits = soroban_sdk::vec![
            &f.env,
            TreasurySplit {
                address: f.treasury.clone(),
                percentage: 50,
            },
            TreasurySplit {
                address: treasury2.clone(),
                percentage: 30,
            },
            TreasurySplit {
                address: treasury3.clone(),
                percentage: 20,
            },
        ];

        let result = f.client().try_set_treasury_splits(&f.admin, &splits);
        assert!(result.is_ok());

        let retrieved = f.client().get_treasury_splits();
        assert!(retrieved.is_some());
        if let Some(splits) = retrieved {
            assert_eq!(splits.len(), 3);
        }
    }

    #[test]
    fn test_set_treasury_splits_with_invalid_percentages() {
        let f = Fixture::new();
        f.init();
        let treasury2 = Address::generate(&f.env);

        let splits = soroban_sdk::vec![
            &f.env,
            TreasurySplit {
                address: f.treasury.clone(),
                percentage: 60,
            },
            TreasurySplit {
                address: treasury2.clone(),
                percentage: 30,
            },
        ];

        let result = f.client().try_set_treasury_splits(&f.admin, &splits);
        assert_eq!(result, Err(Ok(Error::InvalidTreasurySplits)));
    }

    #[test]
    fn test_set_treasury_splits_with_empty_list() {
        let f = Fixture::new();
        f.init();
        let splits = soroban_sdk::vec![&f.env];

        let result = f.client().try_set_treasury_splits(&f.admin, &splits);
        assert_eq!(result, Err(Ok(Error::InvalidTreasurySplits)));
    }

    #[test]
    fn test_clear_treasury_splits() {
        let f = Fixture::new();
        f.init();
        let treasury2 = Address::generate(&f.env);

        let splits = soroban_sdk::vec![
            &f.env,
            TreasurySplit {
                address: f.treasury.clone(),
                percentage: 50,
            },
            TreasurySplit {
                address: treasury2.clone(),
                percentage: 50,
            },
        ];

        f.client().set_treasury_splits(&f.admin, &splits);
        assert!(f.client().get_treasury_splits().is_some());

        f.client().clear_treasury_splits(&f.admin);
        assert!(f.client().get_treasury_splits().is_none());
    }

    // ── Issue #680: Property-based arithmetic testing ───────────────────────────────

    #[test]
    fn test_arithmetic_saturating_add_properties() {
        let amounts = [
            (0i128, 0i128, 0i128),
            (100i128, 200i128, 300i128),
            (i128::MAX, 0i128, i128::MAX),
            (i128::MAX, i128::MAX, i128::MAX),
            (1000i128, 2000i128, 3000i128),
        ];

        for (a, b, expected) in &amounts {
            assert_eq!(a.saturating_add(*b), *expected);
        }
    }

    #[test]
    fn test_withdraw_limit_calculation_properties() {
        let test_cases = [
            (0i128, 0i128, 0i128),
            (1000i128, 500i128, 1500i128),
            (100i128, 0i128, 100i128),
            (i128::MAX, 0i128, i128::MAX),
        ];

        for (initial, withdrawal, expected) in &test_cases {
            let new_total = initial.saturating_add(*withdrawal);
            assert_eq!(new_total, *expected);
        }
    }

    #[test]
    fn test_percentage_split_arithmetic_properties() {
        let test_cases = [
            (1000i128, 50u32, 500i128),
            (1000i128, 25u32, 250i128),
            (1000i128, 100u32, 1000i128),
            (2000i128, 50u32, 1000i128),
            (9999i128, 33u32, 3299i128),
        ];

        for (amount, percentage, expected) in &test_cases {
            let split_amount = (*amount as u128 * *percentage as u128 / 100u128) as i128;
            assert_eq!(split_amount, *expected);
        }
    }

    #[test]
    fn test_role_hierarchy_ordering_properties() {
        assert!(Stellar_CardReceiver::is_role_sufficient(&Role::Admin, &Role::Admin));
        assert!(Stellar_CardReceiver::is_role_sufficient(&Role::Admin, &Role::Operator));
        assert!(Stellar_CardReceiver::is_role_sufficient(&Role::Admin, &Role::Viewer));

        assert!(!Stellar_CardReceiver::is_role_sufficient(&Role::Operator, &Role::Admin));
        assert!(Stellar_CardReceiver::is_role_sufficient(&Role::Operator, &Role::Operator));
        assert!(Stellar_CardReceiver::is_role_sufficient(&Role::Operator, &Role::Viewer));

        assert!(!Stellar_CardReceiver::is_role_sufficient(&Role::Viewer, &Role::Admin));
        assert!(!Stellar_CardReceiver::is_role_sufficient(&Role::Viewer, &Role::Operator));
        assert!(Stellar_CardReceiver::is_role_sufficient(&Role::Viewer, &Role::Viewer));
    }

    #[test]
    fn test_daily_limit_reset_on_day_boundary() {
        let f = Fixture::new();
        f.init();
        f.mint_usdc(&f.contract_id, 10_000);

        let day1 = f.env.ledger().timestamp() / 86_400;
        let amount = 1000i128;

        f.client()
            .set_withdraw_limits(&f.admin, &Some(5_000), &Some(10_000));

        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &f.treasury, &amount);
        assert_eq!(f.client().withdrawn_today(), amount);

        f.env.ledger().with_mut(|li| li.timestamp += 86_400);
        let day2 = f.env.ledger().timestamp() / 86_400;
        assert_ne!(day1, day2);

        assert_eq!(f.client().withdrawn_today(), 0);

        f.client()
            .rescue_tokens(&f.admin, &f.usdc, &f.treasury, &amount);
        assert_eq!(f.client().withdrawn_today(), amount);
    }

    // ── decommission tests (Issue #671) ───────────────────────────────────────

    fn decommissioned_fixture() -> Fixture {
        let f = Fixture::new();
        f.init();
        f.client().decommission(&Vec::new(&f.env));
        f
    }

    #[test]
    fn test_decommission_sets_permanent_pause_and_sweeps_balances() {
        let f = Fixture::new();
        f.init();
        f.mint_usdc(&f.contract_id, 500);
        f.mint_xlm(&f.contract_id, 300);

        f.client().decommission(&Vec::new(&f.env));

        // `events().all()` covers only the latest invocation, so assert the
        // event before any further client calls.
        assert_eq!(
            contract_event_count(&f.env, &f.contract_id, "contract_decommissioned"),
            1
        );
        assert!(f.client().is_decommissioned_view());
        assert!(f.client().is_paused_view());
        assert_eq!(f.usdc_balance(&f.contract_id), 0);
        assert_eq!(f.xlm_balance(&f.contract_id), 0);
        assert_eq!(f.usdc_balance(&f.treasury), 500);
        assert_eq!(f.xlm_balance(&f.treasury), 300);
    }

    #[test]
    fn test_decommission_sweeps_extra_tokens() {
        let f = Fixture::new();
        f.init();
        let other = f
            .env
            .register_stellar_asset_contract_v2(f.admin.clone())
            .address();
        token::StellarAssetClient::new(&f.env, &other).mint(&f.contract_id, &42);

        let mut extra = Vec::new(&f.env);
        extra.push_back(other.clone());
        f.client().decommission(&extra);

        let other_client = token::Client::new(&f.env, &other);
        assert_eq!(other_client.balance(&f.contract_id), 0);
        assert_eq!(other_client.balance(&f.treasury), 42);
    }

    #[test]
    fn test_payments_rejected_after_decommission() {
        let f = decommissioned_fixture();
        f.mint_usdc(&f.payer, 100);
        f.mint_xlm(&f.payer, 100);
        let order = order_bytes(&f.env, "order-1");
        assert_eq!(
            f.client().try_pay_usdc(&f.payer, &10, &order),
            Err(Ok(Error::ContractDecommissioned))
        );
        assert_eq!(
            f.client().try_pay_xlm(&f.payer, &10, &order),
            Err(Ok(Error::ContractDecommissioned))
        );
    }

    #[test]
    #[should_panic(expected = "contract is decommissioned")]
    fn test_unpause_locked_after_decommission() {
        decommissioned_fixture().client().unpause();
    }

    #[test]
    #[should_panic(expected = "contract is decommissioned")]
    fn test_decommission_cannot_run_twice() {
        let f = decommissioned_fixture();
        f.client().decommission(&Vec::new(&f.env));
    }

    #[test]
    fn test_admin_functions_locked_after_decommission() {
        let f = decommissioned_fixture();
        let other = Address::generate(&f.env);
        let c = f.client();
        assert!(c.try_pause(&f.admin).is_err());
        assert!(c.try_upgrade(&BytesN::from_array(&f.env, &[0u8; 32])).is_err());
        assert!(c
            .try_rescue_tokens(&f.admin, &f.usdc, &other, &1)
            .is_err());
        assert!(c.try_set_withdraw_limits(&f.admin, &None, &None).is_err());
        assert!(c.try_transfer_admin(&other).is_err());
        assert!(c.try_grant_role(&other, &Role::Operator).is_err());
        assert!(c.try_revoke_role(&other).is_err());
        assert!(c.is_decommissioned_view());
        assert!(c.is_paused_view());
    }

    #[test]
    fn test_contract_decommissioned_error_code() {
        assert_eq!(Error::ContractDecommissioned as u32, 13);
    }

    // ── Discount tier tests (Issue #657) ──────────────────────────────────────

    #[test]
    fn test_set_discount_by_operator() {
        let f = Fixture::new();
        f.init();
        let operator = Address::generate(&f.env);
        f.client().grant_role(&operator, &Role::Operator);

        let vip = Address::generate(&f.env);
        f.client().set_discount(&operator, &vip, &500);
        assert_eq!(f.client().get_discount(&vip), 500);
    }

    #[test]
    fn test_set_discount_by_admin() {
        let f = Fixture::new();
        f.init();

        let vip = Address::generate(&f.env);
        f.client().set_discount(&f.admin, &vip, &1000);
        assert_eq!(f.client().get_discount(&vip), 1000);
    }

    #[test]
    #[should_panic(expected = "set_discount requires at least the Operator role")]
    fn test_set_discount_requires_operator_role() {
        let f = Fixture::new();
        f.init();

        let viewer = Address::generate(&f.env);
        f.client().grant_role(&viewer, &Role::Viewer);

        let vip = Address::generate(&f.env);
        f.client().set_discount(&viewer, &vip, &500);
    }

    #[test]
    fn test_set_discount_rejects_over_max() {
        let f = Fixture::new();
        f.init();

        let vip = Address::generate(&f.env);
        let result = f.client().try_set_discount(&f.admin, &vip, &10001);
        assert_eq!(result, Err(Ok(Error::InvalidDiscount)));
    }

    #[test]
    fn test_set_discount_accepts_max_discount() {
        let f = Fixture::new();
        f.init();

        let vip = Address::generate(&f.env);
        f.client().set_discount(&f.admin, &vip, &10000);
        assert_eq!(f.client().get_discount(&vip), 10000);
    }

    #[test]
    fn test_set_discount_zero_removes_entry() {
        let f = Fixture::new();
        f.init();

        let vip = Address::generate(&f.env);
        f.client().set_discount(&f.admin, &vip, &500);
        assert_eq!(f.client().get_discount(&vip), 500);

        f.client().set_discount(&f.admin, &vip, &0);
        assert_eq!(f.client().get_discount(&vip), 0);
    }

    #[test]
    fn test_get_discount_returns_zero_for_no_discount() {
        let f = Fixture::new();
        f.init();

        let regular = Address::generate(&f.env);
        assert_eq!(f.client().get_discount(&regular), 0);
    }

    #[test]
    fn test_pay_usdc_applies_discount() {
        let f = Fixture::new();
        f.init();

        let vip = Address::generate(&f.env);
        // Set 10% discount (1000 bps)
        f.client().set_discount(&f.admin, &vip, &1000);

        let payment_amount: i128 = 10_000_000; // 1.0 USDC (7 decimals)
        f.mint_usdc(&vip, payment_amount);

        f.client()
            .pay_usdc(&vip, &payment_amount, &order_bytes(&f.env, "vip-001"));

        // Treasury should receive 90% of the amount (10% discount)
        let expected = 9_000_000;
        assert_eq!(f.usdc_balance(&f.treasury), expected);
    }

    #[test]
    fn test_pay_xlm_applies_discount() {
        let f = Fixture::new();
        f.init();

        let vip = Address::generate(&f.env);
        // Set 25% discount (2500 bps)
        f.client().set_discount(&f.admin, &vip, &2500);

        let payment_amount: i128 = 20_000_000; // 2.0 XLM (7 decimals)
        f.mint_xlm(&vip, payment_amount);

        f.client()
            .pay_xlm(&vip, &payment_amount, &order_bytes(&f.env, "vip-xlm-001"));

        // Treasury should receive 75% of the amount (25% discount)
        let expected = 15_000_000;
        assert_eq!(f.xlm_balance(&f.treasury), expected);
    }

    #[test]
    fn test_discount_calculation_handles_i128_max_without_intermediate_overflow() {
        let f = Fixture::new();
        f.init();

        let vip = Address::generate(&f.env);
        f.client().set_discount(&f.admin, &vip, &5000);
        f.mint_usdc(&vip, i128::MAX);
        f.client()
            .pay_usdc(&vip, &i128::MAX, &order_bytes(&f.env, "max-discount"));

        assert_eq!(f.usdc_balance(&f.treasury), i128::MAX - (i128::MAX / 2));
    }

    #[test]
    fn test_pay_usdc_no_discount_for_regular_user() {
        let f = Fixture::new();
        f.init();

        let regular = Address::generate(&f.env);
        let payment_amount: i128 = 10_000_000;
        f.mint_usdc(&regular, payment_amount);

        f.client()
            .pay_usdc(&regular, &payment_amount, &order_bytes(&f.env, "regular-001"));

        // Treasury should receive full amount
        assert_eq!(f.usdc_balance(&f.treasury), payment_amount);
    }

    #[test]
    fn test_100_percent_discount() {
        let f = Fixture::new();
        f.init();

        let vip = Address::generate(&f.env);
        // Set 100% discount (10000 bps)
        f.client().set_discount(&f.admin, &vip, &10000);

        let payment_amount: i128 = 10_000_000;
        f.mint_usdc(&vip, payment_amount);

        f.client()
            .pay_usdc(&vip, &payment_amount, &order_bytes(&f.env, "free-001"));

        // Treasury should receive nothing (100% discount)
        assert_eq!(f.usdc_balance(&f.treasury), 0);
    }

    #[test]
    fn test_discount_calculation_rounds_correctly() {
        let f = Fixture::new();
        f.init();

        let vip = Address::generate(&f.env);
        // Set 5% discount (500 bps)
        f.client().set_discount(&f.admin, &vip, &500);

        // Test with amount that doesn't divide evenly
        let payment_amount: i128 = 999;
        f.mint_usdc(&vip, payment_amount);

        f.client()
            .pay_usdc(&vip, &payment_amount, &order_bytes(&f.env, "round-001"));

        // 999 - (999 * 500 / 10000) = 999 - 49 = 950
        assert_eq!(f.usdc_balance(&f.treasury), 950);
    }
}
