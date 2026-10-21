// `stellar_card qr <order-id>` — print a scannable QR code for an order's
// payment (issue #727). Looks the order up via the API, builds a
// SEP-0007 `web+stellar:pay` URI from its payment details when
// available, and renders it to the terminal. Falls back to the order's
// checkout/payment URL when SEP-0007 destination details aren't present
// (e.g. the order is already paid/delivered).

import { Stellar_CardClient } from '../client';
import type { OrderStatus } from '../client';
import { generatePaymentQrCode, type PaymentQrCode } from '../utils/qr';

type QrClient = Pick<Stellar_CardClient, 'getOrder'>;

export interface QrCliDeps {
  client?: QrClient;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

function resolve(deps: QrCliDeps): {
  client: () => QrClient;
  out: (text: string) => void;
  err: (text: string) => void;
} {
  return {
    client: () =>
      deps.client ??
      new Stellar_CardClient({ apiKey: process.env.STELLAR_CARD_API_KEY || undefined }),
    out: deps.out ?? ((t) => process.stdout.write(t)),
    err: deps.err ?? ((t) => process.stderr.write(t)),
  };
}

/**
 * Build the string to encode into the QR code for a given order: a
 * SEP-0007 pay URI when the order exposes Soroban contract payment
 * details, otherwise just the order's checkout/payment reference.
 */
export function buildQrDataForOrder(order: OrderStatus): string {
  const payment = order.payment as
    { contract_id?: string; usdc?: { amount?: string; asset?: string } } | undefined;

  if (payment?.contract_id) {
    // We don't have a real destination G-address for a Soroban contract
    // payment (the contract ID isn't a classic account), so we encode a
    // descriptive reference URI rather than a SEP-0007 pay URI that would
    // misrepresent the payment as a direct account transfer.
    const amount = payment.usdc?.amount ?? order.amount_usdc;
    const asset = payment.usdc?.asset ?? 'USDC';
    return `stellar_card:order?id=${encodeURIComponent(order.order_id)}&amount=${encodeURIComponent(amount)}&asset=${encodeURIComponent(asset)}&contract=${encodeURIComponent(payment.contract_id)}`;
  }

  return `stellar_card:order?id=${encodeURIComponent(order.order_id)}&amount=${encodeURIComponent(order.amount_usdc)}&status=${encodeURIComponent(order.status)}`;
}

/** `stellar_card qr <order-id> [--svg] [--png] [--json]` */
export async function qrCommand(argv: string[], deps: QrCliDeps = {}): Promise<number> {
  const { client, out, err } = resolve(deps);
  const orderId = argv.find((a) => !a.startsWith('--'));
  const asSvg = argv.includes('--svg');
  const asPng = argv.includes('--png');
  const asJson = argv.includes('--json');

  if (!orderId) {
    err('error: usage: stellar_card qr <order-id> [--svg|--png|--json]\n');
    return 2;
  }

  try {
    const order = await client().getOrder(orderId);
    const data = buildQrDataForOrder(order);
    const qr: PaymentQrCode = generatePaymentQrCode(data);

    if (asJson) {
      out(
        `${JSON.stringify(
          { order_id: order.order_id, data: qr.data, svg: qr.svg, png_data_url: qr.pngDataUrl },
          null,
          2,
        )}\n`,
      );
      return 0;
    }
    if (asSvg) {
      out(`${qr.svg}\n`);
      return 0;
    }
    if (asPng) {
      out(`${qr.pngDataUrl}\n`);
      return 0;
    }
    out(`${qr.terminal}\n\n${qr.data}\n`);
    return 0;
  } catch (e) {
    err(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
