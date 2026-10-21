/**
 * QR code generation for Stellar payment addresses and order URLs.
 *
 * Wraps the zero-runtime-dependency `qrcode-generator` library (MIT) to
 * produce:
 *   - ANSI terminal output (for the CLI, `stellar_card qr <order-id>`)
 *   - An SVG string (for web embedding)
 *   - A base64 PNG data URL (for web embedding without SVG support)
 *
 * The payload encoded is a SEP-0007 `web+stellar:pay` URI (see
 * `./sep7.ts`) carrying the destination address plus, when supplied,
 * the order amount and currency/asset — the same scheme Lobstr,
 * Vibrant and other Stellar wallets already deep-link against.
 */

import { deflateSync } from 'node:zlib';
import qrcodeFactory from 'qrcode-generator';
import { buildSep7PayUri, type Sep7PayParams } from './sep7';

/** Error-correction level passed through to the underlying QR encoder. */
export type QrErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

/** Options accepted by {@link generatePaymentQrCode}. */
export interface GeneratePaymentQrCodeOptions {
  /**
   * Error correction level. Defaults to `'M'` (~15% recovery), a good
   * balance for payment URIs that may be printed at small sizes or
   * scanned from a phone screen.
   */
  errorCorrectionLevel?: QrErrorCorrectionLevel;
  /** Pixels (or terminal cells) per QR module. Defaults to 4 for raster/SVG output, 1 for ANSI. */
  cellSize?: number;
  /** Quiet-zone margin, in modules. Defaults to 4 per the QR spec's recommended minimum. */
  margin?: number;
  /**
   * Whether to also build and return `paymentUrl` as a SEP-0007 URI from
   * structured pay params instead of treating the first argument as an
   * already-built URI/string. See {@link generatePaymentQrCode}.
   */
  sep7?: Sep7PayParams;
}

/** All representations returned by {@link generatePaymentQrCode}. */
export interface PaymentQrCode {
  /** The exact string encoded into the QR code (a URI, usually SEP-0007). */
  data: string;
  /** ANSI/Unicode block-art rendering suitable for a terminal (CLI usage). */
  terminal: string;
  /** `<svg>...</svg>` markup string, suitable for inline web embedding. */
  svg: string;
  /** `data:image/png;base64,...` data URL, suitable for an `<img src>`. */
  pngDataUrl: string;
  /** Module count (QR code is `moduleCount x moduleCount`), for diagnostics/tests. */
  moduleCount: number;
}

const DEFAULT_ERROR_CORRECTION: QrErrorCorrectionLevel = 'M';
const DEFAULT_RASTER_CELL_SIZE = 4;
const DEFAULT_MARGIN = 4;

/**
 * Build the QR module matrix for arbitrary text using `qrcode-generator`.
 * `0` as the type number lets the library auto-select the smallest QR
 * version that fits the payload at the requested error-correction level.
 */
function buildMatrix(
  text: string,
  errorCorrectionLevel: QrErrorCorrectionLevel,
): { isDark: (row: number, col: number) => boolean; moduleCount: number } {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('generatePaymentQrCode: payment URL/data must be a non-empty string');
  }
  const qr = qrcodeFactory(0, errorCorrectionLevel);
  qr.addData(text);
  qr.make();
  return { isDark: (r, c) => qr.isDark(r, c), moduleCount: qr.getModuleCount() };
}

/**
 * Render the QR matrix as ANSI/Unicode block art for terminal output.
 * Uses half-height block characters (▀▄█ space) to pack two QR module
 * rows into one terminal line, matching common terminal QR renderers.
 */
function renderTerminal(
  isDark: (row: number, col: number) => boolean,
  moduleCount: number,
  margin: number,
): string {
  const size = moduleCount + margin * 2;
  const dark = (row: number, col: number): boolean => {
    const r = row - margin;
    const c = col - margin;
    if (r < 0 || c < 0 || r >= moduleCount || c >= moduleCount) return false;
    return isDark(r, c);
  };

  const lines: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let line = '';
    for (let x = 0; x < size; x++) {
      const top = dark(y, x);
      const bottom = y + 1 < size ? dark(y + 1, x) : false;
      if (top && bottom) line += '█';
      else if (top && !bottom) line += '▀';
      else if (!top && bottom) line += '▄';
      else line += ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** Render the QR matrix as an inline SVG string. */
function renderSvg(
  isDark: (row: number, col: number) => boolean,
  moduleCount: number,
  cellSize: number,
  margin: number,
): string {
  const size = (moduleCount + margin * 2) * cellSize;
  const rects: string[] = [];
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (!isDark(row, col)) continue;
      const x = (col + margin) * cellSize;
      const y = (row + margin) * cellSize;
      rects.push(`<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" />`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `width="${size}" height="${size}" shape-rendering="crispEdges">` +
    `<rect x="0" y="0" width="${size}" height="${size}" fill="#ffffff"/>` +
    `<g fill="#000000">${rects.join('')}</g>` +
    `</svg>`
  );
}

/**
 * CRC-32 implementation (PNG chunk checksums use the same polynomial as
 * zlib/gzip). Implemented locally so PNG encoding has no dependency
 * beyond Node's built-in `zlib` for the IDAT deflate stream.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/**
 * Encode the QR matrix as a real (non-fake) 1-bit grayscale PNG, using
 * only Node's built-in `zlib` for the DEFLATE-compressed IDAT stream —
 * no image library dependency. Produces a valid PNG per the spec
 * (8-byte signature, IHDR, IDAT with per-row filter byte 0, IEND).
 */
function renderPngDataUrl(
  isDark: (row: number, col: number) => boolean,
  moduleCount: number,
  cellSize: number,
  margin: number,
): string {
  const size = (moduleCount + margin * 2) * cellSize;
  const dark = (row: number, col: number): boolean => {
    const r = row - margin;
    const c = col - margin;
    if (r < 0 || c < 0 || r >= moduleCount || c >= moduleCount) return false;
    return isDark(r, c);
  };

  // 1-bit grayscale (color type 0, bit depth 1): 0 = black, 1 = white.
  // Each scanline is prefixed with a filter-type byte (0 = "None").
  const bytesPerRow = Math.ceil(size / 8);
  const raw = Buffer.alloc((bytesPerRow + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (bytesPerRow + 1);
    raw[rowStart] = 0; // filter: None
    const moduleY = Math.floor(y / cellSize);
    for (let x = 0; x < size; x++) {
      const moduleX = Math.floor(x / cellSize);
      const isBlack = dark(moduleY, moduleX);
      if (!isBlack) {
        // bit = 1 means white; buffer defaults to 0 (black), so only set the bit for white pixels
        const byteIndex = rowStart + 1 + Math.floor(x / 8);
        const bitIndex = 7 - (x % 8);
        raw[byteIndex] |= 1 << bitIndex;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  const idatData = deflateSync(raw);

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idatData),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);

  return `data:image/png;base64,${png.toString('base64')}`;
}

/**
 * Generate a QR code for a Stellar payment address or order URL, in all
 * three forms the SDK's surfaces need: ANSI terminal art (CLI), SVG
 * markup, and a base64 PNG data URL (web).
 *
 * @param paymentUrl - Either an already-built URI/URL string to encode
 *   verbatim (e.g. a checkout URL, or a pre-built `web+stellar:pay?...`
 *   URI), or, when `options.sep7` is supplied, this value is ignored in
 *   favor of a SEP-0007 URI built from `options.sep7`.
 * @param options - Rendering + SEP-0007 options. See {@link GeneratePaymentQrCodeOptions}.
 *
 * @example
 * ```typescript
 * // Encode a plain checkout URL
 * const qr = generatePaymentQrCode('https://app.stellar_card.com/checkout/ord_123');
 * console.log(qr.terminal); // print to CLI
 * ```
 *
 * @example
 * ```typescript
 * // Encode a SEP-0007 payment URI with amount + asset embedded
 * const qr = generatePaymentQrCode('', {
 *   sep7: { destination: 'GABC...', amount: '10.00', assetCode: 'USDC', assetIssuer: 'GA5Z...' },
 * });
 * ```
 */
export function generatePaymentQrCode(
  paymentUrl: string,
  options: GeneratePaymentQrCodeOptions = {},
): PaymentQrCode {
  const errorCorrectionLevel = options.errorCorrectionLevel ?? DEFAULT_ERROR_CORRECTION;
  const margin = options.margin ?? DEFAULT_MARGIN;
  const cellSize = options.cellSize ?? DEFAULT_RASTER_CELL_SIZE;

  const data = options.sep7 ? buildSep7PayUri(options.sep7) : paymentUrl;

  const { isDark, moduleCount } = buildMatrix(data, errorCorrectionLevel);

  return {
    data,
    terminal: renderTerminal(isDark, moduleCount, margin),
    svg: renderSvg(isDark, moduleCount, cellSize, margin),
    pngDataUrl: renderPngDataUrl(isDark, moduleCount, cellSize, margin),
    moduleCount,
  };
}
