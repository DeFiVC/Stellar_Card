// Zod schemas for client options and order inputs (browser-safe).
// Re-exported from ./config for Node callers.

import { z } from 'zod';
import { ConfigurationError, InvalidAmountError, ValidationError } from './errors';

const httpUrl = z
  .string()
  .url('must be a valid URL')
  .refine((u) => /^https?:\/\//i.test(u), 'must use http or https');

/** Schema for {@link Stellar_CardClient} constructor options. */
export const clientOptionsSchema = z
  .object({
    // Empty/missing keys fall back to env/config and raise AuthError later.
    apiKey: z.string({ invalid_type_error: 'must be a string' }).optional(),
    baseUrl: httpUrl.optional(),
    network: z.enum(['mainnet', 'testnet', 'futurenet']).optional(),
    rpcUrl: httpUrl.optional(),
    timeout: z
      .number()
      .int('must be an integer')
      .positive('must be greater than 0')
      .max(600_000, 'must be at most 600000ms')
      .optional(),
    retry: z
      .object({
        attempts: z.number().int().min(0).optional(),
        baseDelayMs: z.number().min(0).optional(),
        maxDelayMs: z.number().min(0).optional(),
      })
      .optional(),
    headers: z.record(z.string()).optional(),
    disableVersionCheck: z.boolean().optional(),
    telemetry: z.boolean().optional(),
  })
  .passthrough();

/** Schema for `createOrder` inputs. */
export const createOrderSchema = z
  .object({
    amount_usdc: z
      .string()
      .regex(/^\d+(\.\d{1,7})?$/, 'must be a decimal string with up to 7 decimals')
      .refine((v) => Number(v) > 0, 'must be greater than 0'),
    webhook_url: z
      .string()
      .url('must be a valid URL')
      .refine((u) => u.startsWith('https://'), 'must use https')
      .optional(),
  })
  .passthrough();

/** One issue per field (the first reported), so messages stay readable. */
function toIssues(error: z.ZodError): { field: string; message: string }[] {
  const seen = new Map<string, string>();
  for (const i of error.issues) {
    const field = i.path.join('.') || '(root)';
    if (!seen.has(field)) seen.set(field, i.message);
  }
  return [...seen].map(([field, message]) => ({ field, message }));
}

/** Validate client options, throwing {@link ConfigurationError} with every bad field. */
export function validateClientOptions<T>(opts: T): T {
  const result = clientOptionsSchema.safeParse(opts ?? {});
  if (!result.success) throw new ConfigurationError(toIssues(result.error));
  return opts;
}

/**
 * Validate `createOrder` inputs. Bad amounts throw {@link InvalidAmountError}
 * (matching the backend's error); any other bad field throws {@link ValidationError}.
 */
export function validateCreateOrderInput<T>(opts: T): T {
  const result = createOrderSchema.safeParse(opts);
  if (!result.success) {
    const [first] = toIssues(result.error);
    if (first?.field === 'amount_usdc') {
      throw new InvalidAmountError(`Invalid amount_usdc — ${first.message}.`);
    }
    throw new ValidationError(first?.field ?? 'order', first?.message ?? 'invalid');
  }
  return opts;
}
