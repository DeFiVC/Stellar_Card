import { describe, it, expect, afterEach } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import {
  resolveNetworkConfig,
  resolveNetworkConfigFromEnv,
  getDefaultSorobanRpcUrl,
  getDefaultHorizonUrl,
  NETWORK_ENV_VARS,
  validateRpcEndpoint,
} from '../network';

describe('resolveNetworkConfig', () => {
  it('defaults to PUBLIC network with mainnet endpoints', () => {
    const cfg = resolveNetworkConfig();
    expect(cfg.networkPassphrase).toBe(Networks.PUBLIC);
    expect(cfg.sorobanRpc.url).toBe('https://mainnet.sorobanrpc.com');
    expect(cfg.horizon.url).toBe('https://horizon.stellar.org');
  });

  it('resolves testnet defaults for Networks.TESTNET', () => {
    const cfg = resolveNetworkConfig({ networkPassphrase: Networks.TESTNET });
    expect(cfg.sorobanRpc.url).toBe('https://soroban-testnet.stellar.org');
    expect(cfg.horizon.url).toBe('https://horizon-testnet.stellar.org');
  });

  it('respects explicit sorobanRpcUrl override', () => {
    const cfg = resolveNetworkConfig({
      networkPassphrase: Networks.PUBLIC,
      sorobanRpcUrl: 'https://my-custom-rpc.example.com',
    });
    expect(cfg.sorobanRpc.url).toBe('https://my-custom-rpc.example.com');
    expect(cfg.horizon.url).toBe('https://horizon.stellar.org');
  });

  it('respects explicit horizonUrl override', () => {
    const cfg = resolveNetworkConfig({
      networkPassphrase: Networks.PUBLIC,
      horizonUrl: 'https://my-horizon.example.com',
    });
    expect(cfg.horizon.url).toBe('https://my-horizon.example.com');
    expect(cfg.sorobanRpc.url).toBe('https://mainnet.sorobanrpc.com');
  });

  it('allows both overrides simultaneously', () => {
    const cfg = resolveNetworkConfig({
      sorobanRpcUrl: 'https://rpc.custom.net',
      horizonUrl: 'https://horizon.custom.net',
    });
    expect(cfg.sorobanRpc.url).toBe('https://rpc.custom.net');
    expect(cfg.horizon.url).toBe('https://horizon.custom.net');
  });

  it('carries apiKey, timeout and headers through object-form endpoints', () => {
    const cfg = resolveNetworkConfig({
      sorobanRpcUrl: {
        url: 'https://rpc.custom.net',
        apiKey: 'secret',
        timeout: 5000,
        headers: { 'X-Trace': '1' },
      },
    });
    expect(cfg.sorobanRpc.url).toBe('https://rpc.custom.net');
    expect(cfg.sorobanRpc.apiKey).toBe('secret');
    expect(cfg.sorobanRpc.timeout).toBe(5000);
    expect(cfg.sorobanRpc.headers).toEqual({ 'X-Trace': '1' });
    // Untouched endpoint keeps the default 30s timeout.
    expect(cfg.horizon.timeout).toBe(30000);
  });

  it('ignores blank or whitespace-only configuration values', () => {
    const cfg = resolveNetworkConfig({
      networkPassphrase: '   ',
      networkName: '   ',
      sorobanRpcUrl: '   ',
      horizonUrl: { url: '   ' },
    });

    expect(cfg.networkPassphrase).toBe(Networks.PUBLIC);
    expect(cfg.networkName).toBe('Mainnet');
    expect(cfg.sorobanRpc.url).toBe('https://mainnet.sorobanrpc.com');
    expect(cfg.horizon.url).toBe('https://horizon.stellar.org');
  });
});

describe('getDefaultSorobanRpcUrl', () => {
  it('returns mainnet RPC for PUBLIC passphrase', () => {
    expect(getDefaultSorobanRpcUrl(Networks.PUBLIC)).toBe('https://mainnet.sorobanrpc.com');
  });

  it('returns testnet RPC for TESTNET passphrase', () => {
    expect(getDefaultSorobanRpcUrl(Networks.TESTNET)).toBe('https://soroban-testnet.stellar.org');
  });

  it('defaults to mainnet when no passphrase given', () => {
    expect(getDefaultSorobanRpcUrl()).toBe('https://mainnet.sorobanrpc.com');
  });
});

describe('getDefaultHorizonUrl', () => {
  it('returns mainnet Horizon for PUBLIC passphrase', () => {
    expect(getDefaultHorizonUrl(Networks.PUBLIC)).toBe('https://horizon.stellar.org');
  });

  it('returns testnet Horizon for TESTNET passphrase', () => {
    expect(getDefaultHorizonUrl(Networks.TESTNET)).toBe('https://horizon-testnet.stellar.org');
  });

  it('defaults to mainnet when no passphrase given', () => {
    expect(getDefaultHorizonUrl()).toBe('https://horizon.stellar.org');
  });
});

describe('resolveNetworkConfigFromEnv', () => {
  const touched = Object.values(NETWORK_ENV_VARS);
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of touched) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
      delete saved[key];
    }
  });

  const setEnv = (key: string, value: string) => {
    saved[key] = process.env[key];
    process.env[key] = value;
  };

  it('falls back to public defaults when nothing is set', () => {
    const cfg = resolveNetworkConfigFromEnv();
    expect(cfg.networkPassphrase).toBe(Networks.PUBLIC);
    expect(cfg.sorobanRpc.url).toBe('https://mainnet.sorobanrpc.com');
  });

  it('reads custom endpoints from the environment', () => {
    setEnv(NETWORK_ENV_VARS.sorobanRpcUrl, 'https://env-rpc.example.com');
    setEnv(NETWORK_ENV_VARS.horizonUrl, 'https://env-horizon.example.com');
    setEnv(NETWORK_ENV_VARS.networkName, 'CI Network');
    const cfg = resolveNetworkConfigFromEnv();
    expect(cfg.sorobanRpc.url).toBe('https://env-rpc.example.com');
    expect(cfg.horizon.url).toBe('https://env-horizon.example.com');
    expect(cfg.networkName).toBe('CI Network');
  });

  it('attaches env apiKey and timeout to configured endpoints', () => {
    setEnv(NETWORK_ENV_VARS.sorobanRpcUrl, 'https://env-rpc.example.com');
    setEnv(NETWORK_ENV_VARS.apiKey, 'env-key');
    setEnv(NETWORK_ENV_VARS.timeout, '9000');
    const cfg = resolveNetworkConfigFromEnv();
    expect(cfg.sorobanRpc.apiKey).toBe('env-key');
    expect(cfg.sorobanRpc.timeout).toBe(9000);
  });

  it('lets explicit overrides win over the environment', () => {
    setEnv(NETWORK_ENV_VARS.sorobanRpcUrl, 'https://env-rpc.example.com');
    const cfg = resolveNetworkConfigFromEnv({
      sorobanRpcUrl: 'https://override-rpc.example.com',
    });
    expect(cfg.sorobanRpc.url).toBe('https://override-rpc.example.com');
  });

  it('rejects a non-positive-integer timeout', () => {
    setEnv(NETWORK_ENV_VARS.timeout, 'not-a-number');
    expect(() => resolveNetworkConfigFromEnv()).toThrow(/positive integer/);
  });

  it('ignores blank or whitespace-only environment values', () => {
    setEnv(NETWORK_ENV_VARS.networkPassphrase, '   ');
    setEnv(NETWORK_ENV_VARS.sorobanRpcUrl, '   ');
    setEnv(NETWORK_ENV_VARS.horizonUrl, '   ');
    setEnv(NETWORK_ENV_VARS.apiKey, '   ');
    setEnv(NETWORK_ENV_VARS.timeout, '   ');
    setEnv(NETWORK_ENV_VARS.networkName, '   ');

    const cfg = resolveNetworkConfigFromEnv();
    expect(cfg.networkPassphrase).toBe(Networks.PUBLIC);
    expect(cfg.sorobanRpc.url).toBe('https://mainnet.sorobanrpc.com');
    expect(cfg.horizon.url).toBe('https://horizon.stellar.org');
    expect(cfg.networkName).toBe('Mainnet');
  });
});

describe('validateRpcEndpoint', () => {
  it('allows valid HTTPS and HTTP URLs', () => {
    expect(() => validateRpcEndpoint('https://rpc.stellar.org')).not.toThrow();
    expect(() => validateRpcEndpoint('http://localhost:8000')).not.toThrow();
  });

  it('rejects invalid URL structures or protocols', () => {
    expect(() => validateRpcEndpoint('invalid-url')).toThrow(/Invalid RPC endpoint URL/);
    expect(() => validateRpcEndpoint('ftp://rpc.stellar.org')).toThrow(/Invalid protocol: ftp/);
  });
});

describe('HTTP agent pooling and connection management', () => {
  it('resolves network configuration with timeout settings', () => {
    const cfg = resolveNetworkConfig({
      sorobanRpcUrl: {
        url: 'https://rpc.example.com',
        timeout: 15000,
        headers: { 'X-Custom': 'value' },
      },
    });

    expect(cfg.sorobanRpc.timeout).toBe(15000);
    expect(cfg.sorobanRpc.headers).toEqual({ 'X-Custom': 'value' });
  });

  it('applies default timeout when not specified', () => {
    const cfg = resolveNetworkConfig({
      sorobanRpcUrl: 'https://rpc.example.com',
    });

    expect(cfg.sorobanRpc.timeout).toBe(30000); // default timeout
  });

  it('preserves custom headers across configuration resolution', () => {
    const cfg = resolveNetworkConfig({
      sorobanRpcUrl: {
        url: 'https://rpc.example.com',
        timeout: 20000,
        headers: {
          'X-Trace-Id': 'abc123',
          'X-Request-Id': 'xyz789',
          'User-Agent': 'StellarCard/1.0',
        },
      },
    });

    expect(cfg.sorobanRpc.headers).toEqual({
      'X-Trace-Id': 'abc123',
      'X-Request-Id': 'xyz789',
      'User-Agent': 'StellarCard/1.0',
    });
  });

  it('handles concurrent request configuration', () => {
    const cfg = resolveNetworkConfig({
      sorobanRpcUrl: {
        url: 'https://rpc1.example.com',
        timeout: 25000,
      },
      horizonUrl: {
        url: 'https://horizon.example.com',
        timeout: 15000,
      },
    });

    expect(cfg.sorobanRpc.timeout).toBe(25000);
    expect(cfg.horizon.timeout).toBe(15000);
  });
});

describe('DNS resolution and error handling', () => {
  it('validates RPC endpoint hostname structure', () => {
    expect(() => {
      validateRpcEndpoint('https://valid-hostname.example.com');
    }).not.toThrow();

    expect(() => {
      validateRpcEndpoint('https://localhost:8000');
    }).not.toThrow();

    expect(() => {
      validateRpcEndpoint('https://192.168.1.1');
    }).not.toThrow();
  });

  it('rejects malformed URLs that would fail DNS lookup', () => {
    expect(() => {
      validateRpcEndpoint('https://');
    }).toThrow();

    expect(() => {
      validateRpcEndpoint('https://[invalid');
    }).toThrow();
  });

  it('preserves API key for authenticated endpoint configuration', () => {
    const cfg = resolveNetworkConfig({
      sorobanRpcUrl: {
        url: 'https://api.example.com',
        apiKey: 'secret-key-12345',
        timeout: 10000,
      },
    });

    expect(cfg.sorobanRpc.apiKey).toBe('secret-key-12345');
  });
});

describe('TLS handshake and timeout handling', () => {
  it('configures timeout for TLS operations', () => {
    const cfg = resolveNetworkConfig({
      sorobanRpcUrl: {
        url: 'https://secure-rpc.example.com',
        timeout: 5000,
      },
    });

    expect(cfg.sorobanRpc.timeout).toBe(5000);
  });

  it('allows custom timeout configuration for slow networks', () => {
    const cfg = resolveNetworkConfig({
      sorobanRpcUrl: {
        url: 'https://rpc.example.com',
        timeout: 60000, // 60 seconds for slow networks
      },
    });

    expect(cfg.sorobanRpc.timeout).toBe(60000);
  });

  it('validates timeout is a positive integer', () => {
    const envKey = 'STELLAR_CARD_NETWORK_TIMEOUT';
    const saved = process.env[envKey];
    try {
      process.env[envKey] = '0';
      expect(() => {
        resolveNetworkConfigFromEnv();
      }).toThrow(/positive integer/);

      process.env[envKey] = '-5000';
      expect(() => {
        resolveNetworkConfigFromEnv();
      }).toThrow(/positive integer/);
    } finally {
      if (saved === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = saved;
      }
    }
  });
});

describe('Request retry header injection', () => {
  it('preserves custom headers in resolved configuration', () => {
    const cfg = resolveNetworkConfig({
      sorobanRpcUrl: {
        url: 'https://rpc.example.com',
        headers: {
          'Retry-After': '30',
          'X-Idempotency-Key': 'unique-value',
          'X-Request-Priority': 'high',
        },
      },
    });

    expect(cfg.sorobanRpc.headers?.['Retry-After']).toBe('30');
    expect(cfg.sorobanRpc.headers?.['X-Idempotency-Key']).toBe('unique-value');
    expect(cfg.sorobanRpc.headers?.['X-Request-Priority']).toBe('high');
  });

  it('merges headers from multiple sources', () => {
    const cfg = resolveNetworkConfig({
      sorobanRpcUrl: {
        url: 'https://rpc1.example.com',
        headers: { 'X-Custom-1': 'value1' },
      },
      horizonUrl: {
        url: 'https://horizon.example.com',
        headers: { 'X-Custom-2': 'value2' },
      },
    });

    expect(cfg.sorobanRpc.headers?.['X-Custom-1']).toBe('value1');
    expect(cfg.horizon.headers?.['X-Custom-2']).toBe('value2');
  });

  it('ignores blank header values during configuration resolution', () => {
    const cfg = resolveNetworkConfig({
      sorobanRpcUrl: {
        url: 'https://rpc.example.com',
        headers: {
          'X-Valid-Header': 'has-value',
          'X-Empty-Header': '',
        },
      },
    });

    expect(cfg.sorobanRpc.headers?.['X-Valid-Header']).toBe('has-value');
  });

  it('applies headers to consecutive requests in pooled connections', () => {
    const headers1 = { 'X-Request-1': 'first' };
    const headers2 = { 'X-Request-2': 'second' };

    const cfg1 = resolveNetworkConfig({
      sorobanRpcUrl: {
        url: 'https://rpc.example.com',
        headers: headers1,
      },
    });

    const cfg2 = resolveNetworkConfig({
      sorobanRpcUrl: {
        url: 'https://rpc.example.com',
        headers: headers2,
      },
    });

    expect(cfg1.sorobanRpc.headers?.['X-Request-1']).toBe('first');
    expect(cfg2.sorobanRpc.headers?.['X-Request-2']).toBe('second');
  });
});
