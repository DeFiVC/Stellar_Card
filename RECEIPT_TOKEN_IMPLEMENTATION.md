# Receipt Token Minting Hook Implementation

## Overview
Implements optional receipt token minting for loyalty rewards upon successful payment.

## Implementation Plan (#669)

### 1. DataKey Extension
Add to `DataKey` enum (line ~205):
```rust
/// Optional receipt/loyalty token contract address. Admin-configurable.
ReceiptToken,
```

### 2. Admin Configuration Function
```rust
/// Set the optional receipt token contract address.
/// Only callable by Admin. Emits `receipt_token_set` event.
pub fn set_receipt_token(env: Env, receipt_token: Address) -> Result<(), Error> {
    require_admin(&env)?;
    env.storage().instance().set(&DataKey::ReceiptToken, &receipt_token);
    env.events().publish(
        (symbol_short!("receipt_token_set"),),
        receipt_token
    );
    Ok(())
}
```

### 3. Receipt Minting Hook (Fail-Safe)
Add to `pay_usdc` and `pay_xlm` after successful payment:
```rust
// Optional: mint receipt token (soft failure, don't abort payment)
if let Some(receipt_token) = env.storage().instance().get::<_, Address>(&DataKey::ReceiptToken) {
    let mint_result = env.invoke_contract::<()>(
        &receipt_token,
        &Symbol::new(&env, "mint"),
        vec![&env, from.into_val(&env), amount.into_val(&env)]
    );
    
    match mint_result {
        Ok(_) => {
            env.events().publish(
                (symbol_short!("receipt_minted"), from),
                amount
            );
        }
        Err(_) => {
            // Soft failure: log but don't abort payment
            env.events().publish(
                (symbol_short!("receipt_mint_failed"), from),
                amount
            );
        }
    }
}
```

### 4. Event Documentation Update
Add to events table (line ~56):
```
| `receipt_token_set`   | `admin`                           | `receipt_token_address`                   |
| `receipt_minted`      | `payer`                           | `amount`                                  |
| `receipt_mint_failed` | `payer`                           | `amount`                                  |
```

### 5. Storage Layout Update
Add to storage table (line ~98):
```
| `ReceiptToken`         | instance   | after `set_receipt_token`, if configured  |
```

### 6. Unit Tests Required
```rust
#[test]
fn test_set_receipt_token() {
    // Verify only admin can set receipt token
    // Verify event emission
}

#[test]
fn test_receipt_mint_on_payment() {
    // Configure receipt token
    // Make payment
    // Verify receipt mint call
    // Verify receipt_minted event
}

#[test]
fn test_receipt_mint_failure_does_not_abort_payment() {
    // Configure invalid receipt token
    // Make payment
    // Verify payment succeeds despite mint failure
    // Verify receipt_mint_failed event
}

#[test]
fn test_payment_without_receipt_token() {
    // Make payment with no receipt token configured
    // Verify payment succeeds
    // Verify no receipt events
}
```

## Key Design Decisions

### Fail-Safe Architecture
- Receipt minting wrapped in `match` to catch errors
- Payment success NOT dependent on receipt mint
- Failed mints emit `receipt_mint_failed` event for monitoring

### 1:1 Reward Points
- Mint amount = payment amount
- Simplifies accounting
- Can be adjusted in receipt token contract if needed

### Admin-Only Configuration
- Only Admin can set receipt token address
- Prevents unauthorized loyalty program changes
- Aligned with existing RBAC model

### No Receipt Token Interface Validation
- Contract trusts admin to configure valid token
- Failed calls caught by soft failure mechanism
- Reduces contract complexity

## Testing Strategy
1. Unit tests for happy path (receipt configured and working)
2. Unit tests for soft failure (receipt contract fails)
3. Unit tests for no receipt configured
4. Integration test with real receipt token contract

## Estimated Complexity
- DataKey enum: +1 variant
- Admin function: +20 lines
- Minting hooks: +30 lines (both functions)
- Unit tests: +150 lines
- **Total: ~200 lines** - aligned with High (200 points) complexity

## Next Steps
1. ✅ Review this implementation plan
2. Implement DataKey and admin function
3. Add minting hooks to pay_usdc and pay_xlm
4. Write comprehensive unit tests
5. Run `cargo test` to verify
6. Submit PR with test output

Closes #669
