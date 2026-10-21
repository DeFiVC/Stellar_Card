#!/bin/bash
#
# export_contract_interface.sh — Issue #683
#
# Exports the stellar_card_receiver contract interface specification from the
# compiled WASM: the custom contract section (metadata) and a JSON schema of the
# public entrypoints, argument/return types, and error codes.
#
# Usage:
#   ./export_contract_interface.sh --wasm <path> [--out <path>] [--network <testnet|mainnet>] [--contract-id <id>]
#
# Requires: stellar-cli (stellar), jq, and a built contract WASM.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

WASM=""
OUT="$PROJECT_ROOT/contract-interface.json"
NETWORK="testnet"
CONTRACT_ID=""

usage() {
  cat <<EOF
Usage: $0 --wasm <path> [--out <path>] [--network <testnet|mainnet>] [--contract-id <id>]

Options:
  --wasm PATH        Path to the (optimised) contract WASM file. (required)
  --out PATH         Output JSON schema path. Default: ./contract-interface.json
  --network NETWORK  Stellar network for on-chain inspection. Default: testnet
  --contract-id ID   Deployed contract ID to fetch the live interface from.
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --wasm) WASM="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --network) NETWORK="$2"; shift 2 ;;
    --contract-id) CONTRACT_ID="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

if [[ -z "$WASM" ]]; then
  echo "Error: --wasm is required." >&2
  usage
fi

if [[ ! -f "$WASM" ]]; then
  echo "Error: WASM file not found: $WASM" >&2
  exit 1
fi

if ! command -v stellar >/dev/null 2>&1; then
  echo "Error: stellar-cli is not installed. Install with: cargo install --locked stellar-cli" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is not installed. Install it to generate the JSON schema." >&2
  exit 1
fi

echo "==> Exporting contract interface specification"
echo "   WASM: $WASM"
echo "   Out:  $OUT"

# ── 1. Extract the WASM custom contract section (metadata) ──────────────────
# `stellar contract inspect` reads the contract custom section that the
# Soroban SDK embeds at build time (spec / interface documentation).
echo "   [1/3] Inspecting WASM custom contract section..."
if stellar contract inspect --wasm "$WASM" >/dev/null 2>&1; then
  CONTRACT_SPEC=$(stellar contract inspect --wasm "$WASM" 2>/dev/null || true)
else
  CONTRACT_SPEC=""
  echo "   warn: 'stellar contract inspect' unavailable or produced no output; continuing with schema only."

# ── 2. Build a JSON schema of the public entrypoints ───────────────────────
# The schema mirrors the documented ABI in src/lib.rs.
# Error codes (stable ABI — see Error enum in src/lib.rs):
#   1 InvalidAmount, 2 TransferFailed, 3 ContractPaused,
#   4 WithdrawLimitExceeded, 5 DailyWithdrawLimitExceeded, 6 InvalidRecipient

cat > "$OUT" <<JSON
{
  "schema_version": "1.0",
  "contract": "stellar_card_receiver",
  "source": "$WASM",
  "network": "$NETWORK",
  "generated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "entrypoints": [
    {
      "name": "init",
      "args": [
        {"name": "admin", "type": "Address"},
        {"name": "treasury", "type": "Address"},
        {"name": "usdc_contract", "type": "Address"},
        {"name": "xlm_contract", "type": "Address"}
      ],
      "returns": {"type": "Void"},
      "auth": "Admin signature required",
      "idempotent": false,
      "description": "Initialises admin, treasury, and token contracts. Callable once."
    },
    {
      "name": "pay_usdc",
      "args": [
        {"name": "from", "type": "Address"},
        {"name": "amount", "type": "i128"},
        {"name": "order_id", "type": "Bytes"}
      ],
      "returns": {"type": "Void"},
      "auth": "Caller require_auth()",
      "idempotent": false,
      "description": "Transfers USDC from payer to treasury and emits a pay_usdc event."
    },
    {
      "name": "pay_xlm",
      "args": [
        {"name": "from", "type": "Address"},
        {"name": "amount", "type": "i128"},
        {"name": "order_id", "type": "Bytes"}
      ],
      "returns": {"type": "Void"},
      "auth": "Caller require_auth()",
      "idempotent": false,
      "description": "Transfers native XLM from payer to treasury and emits a pay_xlm event."
    },
    {
      "name": "rescue_tokens",
      "args": [
        {"name": "caller", "type": "Address"},
        {"name": "token_contract", "type": "Address"},
        {"name": "to", "type": "Address"},
        {"name": "amount", "type": "i128"}
      ],
      "returns": {"type": "Result<Void, Error>"},
      "auth": "Admin authority required",
      "idempotent": false,
      "description": "Recovers mistakenly sent tokens. Capped by per-call / daily withdraw limits."
    },
    {
      "name": "set_withdraw_limits",
      "args": [
        {"name": "caller", "type": "Address"},
        {"name": "per_call", "type": "Option<i128>"},
        {"name": "per_day", "type": "Option<i128>"}
      ],
      "returns": {"type": "Void"},
      "auth": "Admin authority required",
      "idempotent": false,
      "description": "Sets optional per-call and per-day withdraw limits for rescue_tokens."
    },
    {
      "name": "withdraw_limits",
      "args": [],
      "returns": {"type": "(Option<i128>, Option<i128>)"},
      "auth": "Read-only",
      "idempotent": true,
      "description": "Returns the configured (per_call, per_day) withdraw limits."
    },
    {
      "name": "withdrawn_today",
      "args": [],
      "returns": {"type": "i128"},
      "auth": "Read-only",
      "idempotent": true,
      "description": "Returns the amount rescued today; resets at the UTC day boundary."
    },
    {
      "name": "admin",
      "args": [],
      "returns": {"type": "Address"},
      "auth": "Read-only",
      "idempotent": true,
      "description": "Returns the stored admin address."
    },
    {
      "name": "treasury",
      "args": [],
      "returns": {"type": "Address"},
      "auth": "Read-only",
      "idempotent": true,
      "description": "Returns the treasury address."
    },
    {
      "name": "usdc_contract",
      "args": [],
      "returns": {"type": "Address"},
      "auth": "Read-only",
      "idempotent": true,
      "description": "Returns the USDC Stellar Asset Contract address."
    },
    {
      "name": "xlm_contract",
      "args": [],
      "returns": {"type": "Address"},
      "auth": "Read-only",
      "idempotent": true,
      "description": "Returns the XLM Stellar Asset Contract address."
    },
    {
      "name": "upgrade",
      "args": [
        {"name": "new_wasm_hash", "type": "Bytes"}
      ],
      "returns": {"type": "Void"},
      "auth": "Admin signature required",
      "idempotent": false,
      "description": "Swaps the contract WASM in place (admin only)."
    },
    {
      "name": "pause",
      "args": [{"name": "admin", "type": "Address"}],
      "returns": {"type": "Void"},
      "auth": "Operator or higher",
      "idempotent": false,
      "description": "Pauses all new payments."
    },
    {
      "name": "unpause",
      "args": [{"name": "admin", "type": "Address"}],
      "returns": {"type": "Void"},
      "auth": "Admin only",
      "idempotent": false,
      "description": "Resumes payments after a pause."
    },
    {
      "name": "grant_role",
      "args": [
        {"name": "admin", "type": "Address"},
        {"name": "role", "type": "Symbol"},
        {"name": "address", "type": "Address"}
      ],
      "returns": {"type": "Void"},
      "auth": "Admin signature required",
      "idempotent": false,
      "description": "Grants a role (Admin / Operator / Viewer) to an address."
    },
    {
      "name": "revoke_role",
      "args": [
        {"name": "admin", "type": "Address"},
        {"name": "role", "type": "Symbol"},
        {"name": "address", "type": "Address"}
      ],
      "returns": {"type": "Void"},
      "auth": "Admin signature required",
      "idempotent": false,
      "description": "Revokes a role from an address."
    },
    {
      "name": "renounce_role",
      "args": [
        {"name": "role", "type": "Symbol"},
        {"name": "address", "type": "Address"}
      ],
      "returns": {"type": "Void"},
      "auth": "Address require_auth()",
      "idempotent": false,
      "description": "Voluntarily relinquishes a held role."
    }
  ],
  "error_codes": [
    {"code": 1, "name": "InvalidAmount", "description": "Amount must be positive."},
    {"code": 2, "name": "TransferFailed", "description": "Underlying token transfer failed."},
    {"code": 3, "name": "ContractPaused", "description": "Contract is paused; no new payments accepted."},
    {"code": 4, "name": "WithdrawLimitExceeded", "description": "Rescue amount exceeds per-call limit."},
    {"code": 5, "name": "DailyWithdrawLimitExceeded", "description": "Rescue would exceed daily withdraw limit."},
    {"code": 6, "name": "InvalidRecipient", "description": "Rescue recipient cannot be the contract itself."}
  ],
  "custom_section": $(if [[ -n "$CONTRACT_SPEC" ]]; then echo "$CONTRACT_SPEC" | jq .; else echo "null"; fi),
  "notes": [
    "init is callable exactly once; replaying it panics with 'already initialized'.",
    "pay_usdc / pay_xlm forward funds directly from payer to treasury; the contract never holds payment funds.",
    "The daily withdraw accumulator resets at ledger timestamp / 86400 (00:00 UTC).",
    "rescue_tokens to the contract itself is rejected with InvalidRecipient."
  ]
}
JSON

echo "   [2/3] JSON schema written to $OUT"
jq . "$OUT" >/dev/null 2>&1 && echo "   [2/3] schema validated as valid JSON" || {
  echo "   warn: generated JSON failed validation; inspect $OUT" >&2
}

# ── 3. Optionally inspect the live deployed contract interface ───────────────
if [[ -n "$CONTRACT_ID" ]]; then
  echo "   [3/3] Fetching live interface from $CONTRACT_ID on $NETWORK..."
  if stellar contract invoke --id "$CONTRACT_ID" --network "$NETWORK" -- admin >/dev/null 2>&1; then
    echo "   Live contract is reachable and responded to admin() query."
  else
    echo "   warn: could not query live contract $CONTRACT_ID on $NETWORK." >&2
  fi
else
  echo "   [3/3] Skipped live contract inspection (no --contract-id provided)."
fi

echo "==> Done. Interface specification: $OUT"
fi