import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Stellar_CardClient } from '../client';
import {
  createTelemetryCollector,
  createTelemetryEndpoint,
  isTelemetryEnabled,
} from '../telemetry';

const previousTelemetryEnv = process.env.STELLAR_CARD_TELEMETRY;

beforeEach(() => {
  delete process.env.STELLAR_CARD_TELEMETRY;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204 }));
});

afterEach(() => {
  if (previousTelemetryEnv === undefined) delete process.env.STELLAR_CARD_TELEMETRY;
  else process.env.STELLAR_CARD_TELEMETRY = previousTelemetryEnv;
  vi.unstubAllGlobals();
});

describe('telemetry opt-in', () => {
  it('does not ping on client initialization by default', () => {
    new Stellar_CardClient({ apiKey: 'private-api-key', baseUrl: 'https://api.example.com/v1' });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('pings on client initialization when explicitly enabled', () => {
    new Stellar_CardClient({
      apiKey: 'private-api-key',
      baseUrl: 'https://api.example.com/v1',
      telemetry: true,
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/telemetry');
    expect(request?.credentials).toBe('omit');
    expect(request?.headers).toEqual({ 'Content-Type': 'application/json' });
    const payload = JSON.parse(request?.body as string) as Record<string, unknown>;
    expect(payload).toEqual({
      sdk_version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      os_type: expect.any(String),
      feature_error_frequency: {},
    });
    expect(JSON.stringify(payload)).not.toContain('private-api-key');
  });

  it('enables telemetry only for the exact environment opt-in value', () => {
    process.env.STELLAR_CARD_TELEMETRY = 'true';
    expect(isTelemetryEnabled()).toBe(false);
    process.env.STELLAR_CARD_TELEMETRY = '1';
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('lets an explicit false option silence pings even with the environment opt-in', () => {
    process.env.STELLAR_CARD_TELEMETRY = '1';
    new Stellar_CardClient({
      apiKey: 'private-api-key',
      baseUrl: 'https://api.example.com/v1',
      telemetry: false,
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('records only allowlisted feature error counts after opt-in', () => {
    const collector = createTelemetryCollector({
      enabled: true,
      endpoint: 'https://api.example.com/v1/telemetry',
    });

    collector.recordFeatureError('orders');
    collector.recordFeatureError('orders');

    const [, request] = vi.mocked(fetch).mock.calls[2]!;
    const payload = JSON.parse(request?.body as string) as {
      feature_error_frequency: Record<string, number>;
    };
    expect(payload.feature_error_frequency).toEqual({ orders: 2 });
  });

  it('aggregates failed order requests without including request identifiers', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, status: 204 } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_amount' }),
      } as Response)
      .mockResolvedValueOnce({ ok: true, status: 204 } as Response);
    const client = new Stellar_CardClient({
      apiKey: 'sensitive-api-key',
      baseUrl: 'https://api.example.com/v1',
      telemetry: true,
      retry: { attempts: 0 },
    });

    await expect(client.createOrder({ amount_usdc: '1.00' })).rejects.toThrow();

    const [, telemetryRequest] = vi.mocked(fetch).mock.calls[2]!;
    const payload = JSON.parse(telemetryRequest?.body as string) as {
      feature_error_frequency: Record<string, number>;
    };
    expect(payload.feature_error_frequency).toEqual({ orders: 1 });
    expect(JSON.stringify(payload)).not.toContain('sensitive-api-key');
    expect(JSON.stringify(payload)).not.toContain('order-id');
  });

  it('strips query parameters and fragments from the telemetry endpoint', () => {
    expect(
      createTelemetryEndpoint('https://api.example.com/v1/orders/private-id?token=secret#fragment'),
    ).toBe('https://api.example.com/v1/telemetry');
  });

  it('does not propagate network failures to SDK initialization', () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network unavailable'));

    expect(() =>
      createTelemetryCollector({
        enabled: true,
        endpoint: 'https://api.example.com/v1/telemetry',
      }),
    ).not.toThrow();
  });
});
