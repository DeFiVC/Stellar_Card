// Unit tests for src/utils/qr.ts — QR code generation for payment
// addresses and order URLs (issue #727).

import { describe, it, expect } from 'vitest';
import { generatePaymentQrCode } from '../utils/qr';
import { parseSep7Uri } from '../utils/sep7';

const VALID_DESTINATION = 'GCY5PWJB77OWDLLJ7QLW3KZUKFQSNGZVAOCP4XEWIUORVCKVJBDNR5FK';
const VALID_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

describe('generatePaymentQrCode — basic encoding', () => {
  it('encodes a plain checkout URL and returns all representations', () => {
    const qr = generatePaymentQrCode('https://app.stellar_card.com/checkout/ord_123');
    expect(qr.data).toBe('https://app.stellar_card.com/checkout/ord_123');
    expect(qr.moduleCount).toBeGreaterThan(0);
    expect(typeof qr.terminal).toBe('string');
    expect(qr.terminal.length).toBeGreaterThan(0);
    expect(qr.svg.startsWith('<svg')).toBe(true);
    expect(qr.svg.endsWith('</svg>')).toBe(true);
    expect(qr.pngDataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('throws on an empty string', () => {
    expect(() => generatePaymentQrCode('')).toThrow(/non-empty string/);
  });

  it('produces a larger module count for longer payloads', () => {
    const short = generatePaymentQrCode('https://a.co/1');
    const long = generatePaymentQrCode(`https://app.stellar_card.com/checkout/${'x'.repeat(300)}`);
    expect(long.moduleCount).toBeGreaterThan(short.moduleCount);
  });

  it('respects a custom error correction level without throwing', () => {
    for (const level of ['L', 'M', 'Q', 'H'] as const) {
      const qr = generatePaymentQrCode('https://app.stellar_card.com/checkout/ord_1', {
        errorCorrectionLevel: level,
      });
      expect(qr.moduleCount).toBeGreaterThan(0);
    }
  });

  it('respects custom cellSize and margin for SVG sizing', () => {
    const small = generatePaymentQrCode('https://a.co/x', { cellSize: 2, margin: 2 });
    const large = generatePaymentQrCode('https://a.co/x', { cellSize: 8, margin: 2 });
    const smallWidthMatch = small.svg.match(/width="(\d+)"/);
    const largeWidthMatch = large.svg.match(/width="(\d+)"/);
    expect(smallWidthMatch).not.toBeNull();
    expect(largeWidthMatch).not.toBeNull();
    expect(Number(largeWidthMatch![1])).toBeGreaterThan(Number(smallWidthMatch![1]));
  });
});

describe('generatePaymentQrCode — SEP-0007 integration', () => {
  it('encodes a SEP-0007 pay URI built from structured params', () => {
    const qr = generatePaymentQrCode('', {
      sep7: {
        destination: VALID_DESTINATION,
        amount: '10.00',
        assetCode: 'USDC',
        assetIssuer: VALID_ISSUER,
        memo: 'ord_123',
      },
    });
    expect(qr.data.startsWith('web+stellar:pay?')).toBe(true);
    const parsed = parseSep7Uri(qr.data);
    expect(parsed.destination).toBe(VALID_DESTINATION);
    expect(parsed.amount).toBe('10.00');
    expect(parsed.assetCode).toBe('USDC');
    expect(parsed.memo).toBe('ord_123');
  });

  it('propagates SEP-0007 validation errors (invalid destination)', () => {
    expect(() =>
      generatePaymentQrCode('', {
        sep7: { destination: 'not-a-valid-address' },
      }),
    ).toThrow(/invalid destination/);
  });

  it('encodes a native XLM payment (no asset code/issuer required)', () => {
    const qr = generatePaymentQrCode('', {
      sep7: { destination: VALID_DESTINATION, amount: '25.5' },
    });
    const parsed = parseSep7Uri(qr.data);
    expect(parsed.destination).toBe(VALID_DESTINATION);
    expect(parsed.amount).toBe('25.5');
    expect(parsed.assetCode).toBeUndefined();
  });
});

describe('generatePaymentQrCode — terminal rendering', () => {
  it('renders using only block characters and spaces', () => {
    const qr = generatePaymentQrCode('https://app.stellar_card.com/checkout/ord_1');
    const allowedChars = new Set(['█', '▀', '▄', ' ', '\n']);
    for (const ch of qr.terminal) {
      expect(allowedChars.has(ch)).toBe(true);
    }
  });

  it('produces roughly square output (within one row of the module+margin size)', () => {
    const qr = generatePaymentQrCode('https://app.stellar_card.com/checkout/ord_1', {
      margin: 4,
    });
    const lines = qr.terminal.split('\n');
    const expectedLines = Math.ceil((qr.moduleCount + 8) / 2);
    expect(lines.length).toBe(expectedLines);
    expect(lines[0].length).toBe(qr.moduleCount + 8);
  });
});

describe('generatePaymentQrCode — SVG output', () => {
  it('contains only rect elements, a white background, and black fill group', () => {
    const qr = generatePaymentQrCode('https://app.stellar_card.com/checkout/ord_1');
    expect(qr.svg).toContain('fill="#ffffff"');
    expect(qr.svg).toContain('fill="#000000"');
    expect(qr.svg).toContain('<rect');
  });
});

describe('generatePaymentQrCode — PNG output', () => {
  it('produces a valid PNG signature and IHDR/IDAT/IEND chunk structure', () => {
    const qr = generatePaymentQrCode('https://app.stellar_card.com/checkout/ord_1');
    const base64 = qr.pngDataUrl.replace('data:image/png;base64,', '');
    const buf = Buffer.from(base64, 'base64');

    // PNG signature
    expect(buf.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    // First chunk after the signature must be IHDR
    const ihdrType = buf.subarray(12, 16).toString('ascii');
    expect(ihdrType).toBe('IHDR');

    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    expect(width).toBe(height);
    expect(width).toBeGreaterThan(0);

    // Must contain IDAT and end with IEND
    expect(buf.includes(Buffer.from('IDAT', 'ascii'))).toBe(true);
    const tail = buf.subarray(buf.length - 8, buf.length - 4).toString('ascii');
    expect(tail).toBe('IEND');
  });

  it('scales PNG dimensions with cellSize', () => {
    const small = generatePaymentQrCode('https://app.stellar_card.com/checkout/ord_1', {
      cellSize: 2,
    });
    const large = generatePaymentQrCode('https://app.stellar_card.com/checkout/ord_1', {
      cellSize: 6,
    });
    const widthOf = (dataUrl: string): number => {
      const buf = Buffer.from(dataUrl.replace('data:image/png;base64,', ''), 'base64');
      return buf.readUInt32BE(16);
    };
    expect(widthOf(large.pngDataUrl)).toBeGreaterThan(widthOf(small.pngDataUrl));
  });
});
