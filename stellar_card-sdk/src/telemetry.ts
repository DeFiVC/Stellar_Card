export type TelemetryFeature = 'api_request' | 'orders' | 'payments' | 'wallet';

export interface TelemetryPayload {
  sdk_version: string;
  os_type: string;
  feature_error_frequency: Partial<Record<TelemetryFeature, number>>;
}

export interface TelemetryCollector {
  recordFeatureError(feature: TelemetryFeature): void;
}

interface TelemetryOptions {
  enabled: boolean;
  endpoint: string;
}

const ALLOWED_FEATURES = new Set<TelemetryFeature>(['api_request', 'orders', 'payments', 'wallet']);

function readSdkVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

function readOsType(): string {
  if (typeof process !== 'undefined' && process.platform) {
    const supportedPlatforms = new Set([
      'aix',
      'darwin',
      'freebsd',
      'linux',
      'openbsd',
      'sunos',
      'win32',
    ]);
    return supportedPlatforms.has(process.platform) ? process.platform : 'other';
  }

  if (typeof navigator !== 'undefined') {
    const platform = navigator.platform.toLowerCase();
    if (platform.includes('win')) return 'win32';
    if (platform.includes('mac')) return 'darwin';
    if (platform.includes('linux')) return 'linux';
  }
  return 'other';
}

/** `telemetry: false` always overrides the environment opt-in. */
export function isTelemetryEnabled(option?: boolean): boolean {
  if (option !== undefined) return option;
  return typeof process !== 'undefined' && process.env?.STELLAR_CARD_TELEMETRY === '1';
}

/** Build the telemetry path without forwarding base URL query strings or fragments. */
export function createTelemetryEndpoint(baseUrl: string): string {
  const endpoint = new URL(baseUrl);
  endpoint.search = '';
  endpoint.hash = '';
  endpoint.pathname = '/v1/telemetry';
  return endpoint.toString();
}

/** Start an opt-in, best-effort collector. No identifiers or request headers are sent. */
export function createTelemetryCollector(options: TelemetryOptions): TelemetryCollector {
  const featureErrors: Partial<Record<TelemetryFeature, number>> = {};

  const send = (): void => {
    if (!options.enabled || typeof globalThis.fetch !== 'function') return;

    const payload: TelemetryPayload = {
      sdk_version: readSdkVersion(),
      os_type: readOsType(),
      feature_error_frequency: { ...featureErrors },
    };

    try {
      void globalThis
        .fetch(options.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'omit',
          keepalive: true,
          referrerPolicy: 'no-referrer',
        })
        .catch(() => undefined);
    } catch {
      // Telemetry must never affect SDK initialization or feature behavior.
    }
  };

  send();

  return {
    recordFeatureError(feature: TelemetryFeature): void {
      if (!options.enabled || !ALLOWED_FEATURES.has(feature)) return;
      featureErrors[feature] = (featureErrors[feature] ?? 0) + 1;
      send();
    },
  };
}
