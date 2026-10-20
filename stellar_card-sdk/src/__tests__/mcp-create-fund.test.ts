// Tests for the create_and_fund_card MCP tool (#735).
//
// Covers: happy path field shape, the $500 hard cap (rejected before any
// side effect — asserting createOrder is never called), the inclusive
// boundary at exactly $500, and failure propagation from the simulated
// payment / activation step as a tool error.

import { describe, it, expect, vi } from 'vitest';
import { handleCreateAndFundCard, McpToolError, MAX_CARD_FUNDING_USD } from '../mcp';
import type { OrderResponse, CardDetails } from '../client';

const ENV = {
  apiKey: 'test-api-key',
  baseUrl: 'https://api.example.test/v1',
  walletName: 'test-wallet',
  passphrase: 'test-passphrase',
  vaultPath: undefined,
};

function makeOrderResponse(overrides: Partial<OrderResponse> = {}): OrderResponse {
  return {
    order_id: 'ord_abc123',
    status: 'pending_payment',
    payment: {
      type: 'soroban_contract',
      contract_id: 'C' + 'A'.repeat(55),
      order_id: 'ord_abc123',
      usdc: { amount: '25.00', asset: 'USDC:ISSUER' },
    },
    poll_url: 'https://api.example.test/v1/orders/ord_abc123',
    budget: {
      spent_usdc: '0',
      in_flight_usdc: '25.00',
      committed_usdc: '25.00',
      limit_usdc: null,
      remaining_usdc: null,
    },
    ...overrides,
  };
}

describe('create_and_fund_card (#735)', () => {
  it('happy path returns all required fields', async () => {
    const createOrder = vi.fn().mockResolvedValue(makeOrderResponse());
    const payViaContractOWS = vi.fn().mockResolvedValue({
      hash: 'tx_hash_abc123',
      feeCharged: '100',
      feeRefunded: '0',
      maxFee: '100',
    });
    const card: CardDetails = {
      number: '4111111111111111',
      cvv: '123',
      expiry: '12/28',
      brand: 'Visa',
    };
    const waitForCard = vi.fn().mockResolvedValue(card);

    const result = await handleCreateAndFundCard(
      { amount: '25.00', merchant_tags: ['groceries'] },
      ENV,
      { createOrder, payViaContractOWS, waitForCard },
    );

    expect(result.order_id).toBe('ord_abc123');
    expect(result.card_token).toBe('4111111111111111');
    expect(result.masked_pan).toBe('•••• •••• •••• 1111');
    expect(result.expiration_date).toBe('12/28');
    expect(result.tx_hash).toBe('tx_hash_abc123');

    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(payViaContractOWS).toHaveBeenCalledTimes(1);
    expect(waitForCard).toHaveBeenCalledTimes(1);
  });

  it('rejects an amount over $500 before any side effect', async () => {
    const createOrder = vi.fn();
    const payViaContractOWS = vi.fn();
    const waitForCard = vi.fn();

    await expect(
      handleCreateAndFundCard({ amount: '500.01' }, ENV, {
        createOrder,
        payViaContractOWS,
        waitForCard,
      }),
    ).rejects.toThrow(McpToolError);

    expect(createOrder).not.toHaveBeenCalled();
    expect(payViaContractOWS).not.toHaveBeenCalled();
    expect(waitForCard).not.toHaveBeenCalled();
  });

  it('rejects a large amount before any side effect and reports the limit in the message', async () => {
    const createOrder = vi.fn();
    await expect(
      handleCreateAndFundCard({ amount: '10000.00' }, ENV, { createOrder }),
    ).rejects.toThrow(/\$500\.00/);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('allows exactly the $500.00 boundary (inclusive)', async () => {
    const createOrder = vi.fn().mockResolvedValue(
      makeOrderResponse({
        payment: {
          type: 'soroban_contract',
          contract_id: 'C' + 'A'.repeat(55),
          order_id: 'ord_abc123',
          usdc: { amount: MAX_CARD_FUNDING_USD.toFixed(2), asset: 'USDC:ISSUER' },
        },
      }),
    );
    const payViaContractOWS = vi.fn().mockResolvedValue({
      hash: 'tx_hash_boundary',
      feeCharged: '100',
      feeRefunded: '0',
      maxFee: '100',
    });
    const waitForCard = vi.fn().mockResolvedValue({
      number: '4000000000000000',
      cvv: '999',
      expiry: '01/29',
      brand: 'Visa',
    });

    const result = await handleCreateAndFundCard({ amount: MAX_CARD_FUNDING_USD.toFixed(2) }, ENV, {
      createOrder,
      payViaContractOWS,
      waitForCard,
    });

    expect(result.tx_hash).toBe('tx_hash_boundary');
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it('propagates a simulated payment failure as a tool error', async () => {
    const createOrder = vi.fn().mockResolvedValue(makeOrderResponse());
    const payViaContractOWS = vi.fn().mockRejectedValue(new Error('Soroban simulation failed'));
    const waitForCard = vi.fn();

    await expect(
      handleCreateAndFundCard({ amount: '25.00' }, ENV, {
        createOrder,
        payViaContractOWS,
        waitForCard,
      }),
    ).rejects.toThrow('Soroban simulation failed');

    expect(waitForCard).not.toHaveBeenCalled();
  });

  it('propagates a card-activation (waitForCard) failure as a tool error', async () => {
    const createOrder = vi.fn().mockResolvedValue(makeOrderResponse());
    const payViaContractOWS = vi.fn().mockResolvedValue({
      hash: 'tx_hash_abc123',
      feeCharged: '100',
      feeRefunded: '0',
      maxFee: '100',
    });
    const waitForCard = vi.fn().mockRejectedValue(new Error('Timed out waiting for card'));

    await expect(
      handleCreateAndFundCard({ amount: '25.00' }, ENV, {
        createOrder,
        payViaContractOWS,
        waitForCard,
      }),
    ).rejects.toThrow('Timed out waiting for card');
  });

  it('rejects a non-string / malformed amount', async () => {
    const createOrder = vi.fn();
    await expect(handleCreateAndFundCard({ amount: 25 }, ENV, { createOrder })).rejects.toThrow(
      McpToolError,
    );
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('rejects an amount below the minimum', async () => {
    const createOrder = vi.fn();
    await expect(handleCreateAndFundCard({ amount: '0.00' }, ENV, { createOrder })).rejects.toThrow(
      McpToolError,
    );
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('rejects malformed merchant_tags', async () => {
    const createOrder = vi.fn();
    await expect(
      handleCreateAndFundCard({ amount: '10.00', merchant_tags: [1, 2] }, ENV, { createOrder }),
    ).rejects.toThrow(McpToolError);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('rejects an invalid payment_asset', async () => {
    const createOrder = vi.fn();
    await expect(
      handleCreateAndFundCard({ amount: '10.00', payment_asset: 'btc' }, ENV, { createOrder }),
    ).rejects.toThrow(McpToolError);
    expect(createOrder).not.toHaveBeenCalled();
  });
});
