import { z } from 'zod';

/**
 * Bounds, in one place.
 *
 * Every one of these exists because its absence is a denial of service: an
 * unbounded page size is the whole catalogue serialised on one request, an
 * unbounded line count is a transaction that never commits, and an unbounded
 * search term is a scan per keystroke.
 */
export const UUID = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'not a uuid',
  );

/** Halalas as a decimal string. Never a number: JSON floats lose halalas. */
export const MINOR = z.string().regex(/^(0|[1-9][0-9]{0,14})$/, 'not an integer amount');

/** Scaled by 1000. Same reasoning, and the same refusal to accept a float. */
export const SCALED_QUANTITY = z
  .string()
  .regex(/^[1-9][0-9]{0,11}$/, 'not a positive scaled quantity');

export const MAX_PAGE_SIZE = 50;
export const MAX_CART_LINES = 200;

export const productQuery = z.object({
  q: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
});

export const currentShiftQuery = z.object({ terminalId: UUID });

export const openShiftBody = z.object({
  terminalId: UUID,
  openingFloatMinor: MINOR,
});

export const checkoutBody = z.object({
  operationId: UUID,
  terminalId: UUID,
  cashReceivedMinor: MINOR,
  lines: z
    .array(z.object({ productId: UUID, quantityScaled: SCALED_QUANTITY }))
    .min(1)
    .max(MAX_CART_LINES)
    // Two lines for one product would each pass a stock check their sum fails.
    // One line per product, with the quantity summed by the client.
    .refine((lines) => new Set(lines.map((line) => line.productId)).size === lines.length, {
      message: 'duplicate product line',
    }),
});

/**
 * The fields a client may never send.
 *
 * Rejected rather than ignored. Silently dropping `unitPrice` would let a
 * client believe it had set one, and the first person to notice would be an
 * auditor comparing a receipt to a database row.
 */
export const FORBIDDEN_FIELDS = [
  'tenantId',
  'userId',
  'cashierId',
  'branchId',
  'unitPrice',
  'unitPriceMinor',
  'subtotal',
  'netMinor',
  'vatMinor',
  'totalMinor',
  'changeMinor',
  'sequence',
  'invoiceNumber',
  'role',
  'roles',
  'permissions',
  'maxDiscountBasisPoints',
  'discount',
] as const;

export function namesForbiddenField(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  for (const field of FORBIDDEN_FIELDS) {
    if (Object.hasOwn(body, field)) return field;
  }
  return null;
}
