import { describe, expect, it } from 'vitest';

import {
  Stellar_CardError,
  NetworkError,
  TimeoutError,
  SorobanRpcError,
  HorizonError,
  WalletError,
  wrapError,
  wrapNetworkError,
  wrapTimeoutError,
  wrapSorobanError,
  wrapHorizonError,
  wrapWalletError,
  parseApiError,
} from '../errors';
import { parseContractError } from '../soroban';

// ── wrapError ────────────────────────────────────────────────────────────────

describe('wrapError', () => {
  it('returns a Stellar_CardError when passed a plain Error', () => {
    const original = new Error('something broke');
    const wrapped = wrapError(original, { operation: 'test_op' });

    expect(wrapped).toBeInstanceOf(Stellar_CardError);
    expect(wrapped.message).toBe('something broke');
    expect(wrapped.code).toBe('unknown_error');
    expect(wrapped.status).toBe(0);
    expect(wrapped.context?.operation).toBe('test_op');
    expect(wrapped.context?.cause).toBe(original);
  });

  it('wraps a non-Error value as a string message', () => {
    const wrapped = wrapError('string error', { source: 'test' });

    expect(wrapped).toBeInstanceOf(Stellar_CardError);
    expect(wrapped.message).toBe('string error');
    expect(wrapped.context?.cause).toBeInstanceOf(Error);
    expect(wrapped.context?.cause?.message).toBe('string error');
  });

  it('enhances an existing Stellar_CardError with additional context', () => {
    const base = new Stellar_CardError('original', 'base_code', 500);
    const enhanced = wrapError(base, { operation: 'enhanced_op', source: 'new_source' });

    expect(enhanced).toBeInstanceOf(Stellar_CardError);
    expect(enhanced.message).toBe('original');
    expect(enhanced.code).toBe('base_code');
    expect(enhanced.status).toBe(500);
    expect(enhanced.context?.operation).toBe('enhanced_op');
    expect(enhanced.context?.source).toBe('new_source');
  });

  it('existing Stellar_CardError context is preserved when not overridden', () => {
    const base = new Stellar_CardError('msg', 'code', 400, undefined, {
      source: 'original_source',
      recoveryHint: 'try again',
    });
    const enhanced = wrapError(base, { operation: 'new_op' });

    expect(enhanced.context?.source).toBe('original_source');
    expect(enhanced.context?.recoveryHint).toBe('try again');
    expect(enhanced.context?.operation).toBe('new_op');
  });

  it('wraps null gracefully', () => {
    const wrapped = wrapError(null, {});
    expect(wrapped).toBeInstanceOf(Stellar_CardError);
    expect(wrapped.message).toBe('null');
  });
});

// ── wrapNetworkError ──────────────────────────────────────────────────────────

describe('wrapNetworkError', () => {
  it('preserves a fetch TypeError as the native cause and retains its invocation stack', () => {
    const failFetch = () => {
      throw new TypeError('fetch failed');
    };
    const failure = (() => {
      try {
        failFetch();
      } catch (error) {
        return error as TypeError;
      }
      throw new Error('Expected fetch to fail');
    })();
    const invokeNetworkRequest = () =>
      wrapNetworkError(failure, 'https://api.stellar_card.com', 'create_order');

    const wrapped = invokeNetworkRequest();

    expect(wrapped).toBeInstanceOf(NetworkError);
    expect(wrapped.cause).toBe(failure);
    expect(wrapped.context?.cause).toBe(failure);
    expect(wrapped.stack?.split('\n')[1]).toContain('invokeNetworkRequest');
    expect(failure.stack).toContain('error-wrapping.test.ts');
    expect(failure.stack).not.toContain('wrapNetworkError');
  });

  it('returns a NetworkError with the original message and endpoint', () => {
    const cause = new Error('ECONNREFUSED');
    const wrapped = wrapNetworkError(cause, 'https://api.stellar_card.com', 'create_order');

    expect(wrapped).toBeInstanceOf(NetworkError);
    expect(wrapped).toBeInstanceOf(Stellar_CardError);
    expect(wrapped.endpoint).toBe('https://api.stellar_card.com');
    expect(wrapped.context?.operation).toBe('create_order');
    expect(wrapped.context?.cause).toBe(cause);
    expect(wrapped.message).toContain('ECONNREFUSED');
  });

  it('works without an endpoint or operation', () => {
    const wrapped = wrapNetworkError(new Error('timeout'));

    expect(wrapped).toBeInstanceOf(NetworkError);
    expect(wrapped.endpoint).toBeUndefined();
    expect(wrapped.context?.operation).toBeUndefined();
  });

  it('handles non-Error values', () => {
    const wrapped = wrapNetworkError('connection refused');

    expect(wrapped).toBeInstanceOf(NetworkError);
    expect(wrapped.message).toContain('Unknown network error');
    expect(wrapped.context?.cause).toBeUndefined();
  });

  it('includes a recovery hint', () => {
    const wrapped = wrapNetworkError(new Error('DNS lookup failed'));
    expect(wrapped.context?.recoveryHint).toBeTruthy();
    expect(wrapped.context?.recoveryHint).toContain('connection');
  });
});

describe('error response and serialization', () => {
  it('preserves status and the raw JSON body from an RPC error response', () => {
    const body = {
      error: 'rpc_unavailable',
      message: 'RPC is unavailable',
      details: { retry_after: 3 },
    };
    const wrapped = parseApiError(503, body);

    expect(wrapped.status).toBe(503);
    expect(wrapped.raw).toBe(body);
    expect(wrapped.toString()).toContain(wrapped.message);
    expect(JSON.parse(JSON.stringify(wrapped))).toMatchObject({
      message: 'RPC is unavailable',
      code: 'rpc_unavailable',
      status: 503,
    });
  });

  it('retains the originating stack and raw trap when wrapping a contract trap', () => {
    const trap = new Error('Error(Contract, #1)');
    const invokeContract = () => parseContractError(trap);

    const wrapped = invokeContract();

    expect(wrapped.raw).toBe(trap);
    expect(wrapped.cause).toBe(trap);
    expect(wrapped.context?.cause).toBe(trap);
    expect(trap.stack).toContain('error-wrapping.test.ts');
    expect(wrapped.stack?.split('\n')[1]).toContain('invokeContract');
    expect(wrapped.toString()).toContain('ContractExecutionError');
    expect(JSON.parse(JSON.stringify(wrapped))).toMatchObject({
      name: 'ContractExecutionError',
      status: 400,
    });
  });
});

// ── wrapTimeoutError ──────────────────────────────────────────────────────────

describe('wrapTimeoutError', () => {
  it('returns a TimeoutError with the operation and duration', () => {
    const wrapped = wrapTimeoutError('waitForCard', 30000);

    expect(wrapped).toBeInstanceOf(TimeoutError);
    expect(wrapped).toBeInstanceOf(Stellar_CardError);
    expect(wrapped.message).toContain('waitForCard');
    expect(wrapped.message).toContain('30000ms');
    expect(wrapped.code).toBe('timeout');
  });

  it('includes a recovery hint referencing the timeout value', () => {
    const wrapped = wrapTimeoutError('createOrder', 5000);
    expect(wrapped.context?.recoveryHint).toContain('5000');
  });

  it('attaches the cause when provided', () => {
    const cause = new Error('abort');
    const wrapped = wrapTimeoutError('pollStatus', 10000, cause);
    expect(wrapped.context?.cause).toBe(cause);
  });

  it('works without a cause', () => {
    const wrapped = wrapTimeoutError('someOp', 1000);
    expect(wrapped.context?.cause).toBeUndefined();
  });
});

// ── wrapSorobanError ──────────────────────────────────────────────────────────

describe('wrapSorobanError', () => {
  it('returns a SorobanRpcError with the error message', () => {
    const cause = new Error('RPC unreachable');
    const wrapped = wrapSorobanError(cause, 'https://soroban.example.com', 'submit_tx');

    expect(wrapped).toBeInstanceOf(SorobanRpcError);
    expect(wrapped).toBeInstanceOf(Stellar_CardError);
    expect(wrapped.rpcUrl).toBe('https://soroban.example.com');
    expect(wrapped.context?.operation).toBe('submit_tx');
    expect(wrapped.context?.cause).toBe(cause);
    expect(wrapped.message).toContain('RPC unreachable');
  });

  it('includes a recovery hint referencing the rpcUrl when provided', () => {
    const wrapped = wrapSorobanError(new Error('err'), 'https://rpc.example.com');
    expect(wrapped.context?.recoveryHint).toContain('rpc.example.com');
  });

  it('includes a generic hint when no rpcUrl is provided', () => {
    const wrapped = wrapSorobanError(new Error('err'));
    expect(wrapped.context?.recoveryHint).toContain('sorobanRpcUrl');
  });

  it('handles non-Error values', () => {
    const wrapped = wrapSorobanError({ code: 404 });
    expect(wrapped).toBeInstanceOf(SorobanRpcError);
    expect(wrapped.message).toContain('[object Object]');
  });
});

// ── wrapHorizonError ──────────────────────────────────────────────────────────

describe('wrapHorizonError', () => {
  it('returns a HorizonError with the error message and endpoint', () => {
    const cause = new Error('Horizon 503');
    const wrapped = wrapHorizonError(cause, 'https://horizon.stellar.org', 'submit_payment');

    expect(wrapped).toBeInstanceOf(HorizonError);
    expect(wrapped).toBeInstanceOf(Stellar_CardError);
    expect(wrapped.endpoint).toBe('https://horizon.stellar.org');
    expect(wrapped.context?.operation).toBe('submit_payment');
    expect(wrapped.context?.cause).toBe(cause);
    expect(wrapped.message).toContain('Horizon 503');
  });

  it('works without endpoint or operation', () => {
    const wrapped = wrapHorizonError(new Error('fail'));
    expect(wrapped).toBeInstanceOf(HorizonError);
    expect(wrapped.endpoint).toBeUndefined();
  });

  it('includes a recovery hint about rate-limiting', () => {
    const wrapped = wrapHorizonError(new Error('429'));
    expect(wrapped.context?.recoveryHint).toContain('rate-limited');
  });
});

// ── wrapWalletError ───────────────────────────────────────────────────────────

describe('wrapWalletError', () => {
  it('returns a WalletError with the error message', () => {
    const cause = new Error('vault decrypt failed');
    const wrapped = wrapWalletError(cause, 'decrypt');

    expect(wrapped).toBeInstanceOf(WalletError);
    expect(wrapped).toBeInstanceOf(Stellar_CardError);
    expect(wrapped.operation).toBe('decrypt');
    expect(wrapped.context?.cause).toBe(cause);
    expect(wrapped.message).toContain('vault decrypt failed');
  });

  it('works without an operation', () => {
    const wrapped = wrapWalletError(new Error('unknown'));
    expect(wrapped).toBeInstanceOf(WalletError);
    expect(wrapped.operation).toBeUndefined();
  });

  it('handles non-Error values', () => {
    const wrapped = wrapWalletError('bad passphrase');
    expect(wrapped).toBeInstanceOf(WalletError);
    expect(wrapped.message).toContain('bad passphrase');
  });
});
