import { looksLikeCardNumber } from '@korvi/domain';
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

/** Basis points, as an integer. The same scale the domain and the database use. */
export const BASIS_POINTS = z.number().int().min(0).max(10_000);

export const MAX_TENDERS = 8;
export const MAX_TENDER_REFERENCE = 64;
export const MAX_DISCOUNT_REASON = 120;
export const MAX_CASH_MOVEMENT_REASON = 240;

const BIGINT_MINOR = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/, 'not an integer amount')
  .refine(
    (value) => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n,
    'amount exceeds BIGINT',
  );

export const closeShiftBody = z.object({
  operationId: UUID,
  terminalId: UUID,
  shiftId: UUID,
  declaredCashMinor: BIGINT_MINOR,
});

export const manualCashMovementBody = z.object({
  operationId: UUID,
  terminalId: UUID,
  shiftId: UUID,
  kind: z.enum(['pay-in', 'pay-out']),
  amountMinor: BIGINT_MINOR.refine((value) => value !== '0', 'amount must be positive'),
  reason: z.string().trim().min(1).max(MAX_CASH_MOVEMENT_REASON),
});

/**
 * A payment that happened.
 *
 * `cash` is money in the drawer. `electronic` is a payment approved somewhere
 * else — a Mada terminal, a wallet, an acquirer — that Korvi is recording as
 * settled. Korvi does not talk to a bank, and this shape is careful not to
 * suggest it does: there is a scheme, there is somebody else's reference, and
 * there is nothing that could carry an instruction to move money.
 */
export const tenderBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cash'),
    amountMinor: MINOR,
  }),
  z.object({
    kind: z.literal('electronic'),
    amountMinor: MINOR,
    scheme: z.enum(['mada', 'visa', 'mastercard', 'amex', 'apple-pay', 'other']),
    reference: z.string().trim().min(1).max(MAX_TENDER_REFERENCE),
  }),
]);

/**
 * Card data this API refuses to receive.
 *
 * Rejected rather than ignored, and named in the response. A client sending a
 * PAN has a bug that will keep sending it, and the first person to find out
 * should be the developer rather than an auditor reading a database. Korvi is
 * not in the cardholder-data business and this is where that is enforced.
 */
export const FORBIDDEN_CARD_FIELDS = [
  'pan',
  'cardNumber',
  'card_number',
  'cardnumber',
  'cvv',
  'cvv2',
  'cvc',
  'track1',
  'track2',
  'trackData',
  'expiry',
  'expiryMonth',
  'expiryYear',
  'pin',
  'pinBlock',
  'emvData',
] as const;

/**
 * A discount as requested. What is granted is decided on the server.
 *
 * `rate` is basis points; `fixed` is halalas. Both are checked against the
 * principal's own ceiling before anything is priced, and a fixed amount is
 * converted to the rate it really represents so it cannot walk under the
 * ceiling (ADR-0015).
 */
export const discountBody = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('basis-points'),
    value: BASIS_POINTS,
    reason: z.string().trim().max(MAX_DISCOUNT_REASON).optional(),
  }),
  z.object({
    mode: z.literal('fixed'),
    amountMinor: MINOR,
    reason: z.string().trim().max(MAX_DISCOUNT_REASON).optional(),
  }),
]);

export const productQuery = z.object({
  q: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
});

export const currentShiftQuery = z.object({ terminalId: UUID });

export const openShiftBody = z.object({
  terminalId: UUID,
  openingFloatMinor: MINOR,
});

/**
 * A checkout, in either of the two shapes a client may send.
 *
 * The cash-only shape is what the till in production sends today and it keeps
 * working unchanged. The tender list is the general shape. They are mutually
 * exclusive on purpose: a request carrying both is a client that does not know
 * which one it means, and guessing on its behalf is how a sale gets settled
 * twice over.
 *
 * Both normalise into one settlement engine downstream. There is no second
 * checkout path and there must never be one.
 */
export const checkoutBody = z
  .object({
    operationId: UUID,
    terminalId: UUID,
    cashReceivedMinor: MINOR.optional(),
    tenders: z.array(tenderBody).min(1).max(MAX_TENDERS).optional(),
    basketDiscount: discountBody.optional(),
    lines: z
      .array(
        z.object({
          productId: UUID,
          quantityScaled: SCALED_QUANTITY,
          discount: discountBody.optional(),
        }),
      )
      .min(1)
      .max(MAX_CART_LINES)
      // Two lines for one product would each pass a stock check their sum
      // fails. One line per product, with the quantity summed by the client.
      .refine((lines) => new Set(lines.map((line) => line.productId)).size === lines.length, {
        message: 'duplicate product line',
      }),
  })
  .refine((body) => (body.cashReceivedMinor === undefined) !== (body.tenders === undefined), {
    message: 'send either cashReceivedMinor or tenders, not both and not neither',
  });

/**
 * A return, as a client may state it.
 *
 * Quantities and identifiers, and nothing that decides money. The refund
 * amount is absent because the client does not get a say in it: the lines it
 * asks to send back determine what is owed, and the server prorates that from
 * the sale it already wrote (ADR-0016).
 */
export const MAX_RETURN_LINES = 200;
export const MAX_RETURN_REASON = 200;

export const refundBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cash') }),
  z.object({
    kind: z.literal('electronic'),
    scheme: z.enum(['mada', 'visa', 'mastercard', 'amex', 'apple-pay', 'other']),
    reference: z.string().trim().min(1).max(MAX_TENDER_REFERENCE),
  }),
]);

export const returnBody = z.object({
  operationId: UUID,
  terminalId: UUID,
  saleId: UUID,
  reason: z.string().trim().max(MAX_RETURN_REASON).optional(),
  refund: refundBody,
  lines: z
    .array(
      z.object({
        saleLineId: UUID,
        quantityScaled: SCALED_QUANTITY,
      }),
    )
    .min(1)
    .max(MAX_RETURN_LINES)
    // Two rows for one line would each pass a remaining-quantity check their
    // sum fails. One row per line, with the quantity summed by the client.
    .refine((lines) => new Set(lines.map((line) => line.saleLineId)).size === lines.length, {
      message: 'duplicate return line',
    }),
});

export const saleLookupQuery = z.object({
  q: z.string().trim().min(1).max(64),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

export const saleIdParams = z.object({ saleId: UUID });

/**
 * The fields a client may never send.
 *
 * Rejected rather than ignored. Silently dropping `unitPrice` would let a
 * client believe it had set one, and the first person to notice would be an
 * auditor comparing a receipt to a database row.
 */
export const FORBIDDEN_FIELDS = [
  'expectedCashMinor',
  'varianceMinor',
  'cashSalesMinor',
  'cashRefundsMinor',
  'paidInMinor',
  'paidOutMinor',
  'closedByUserId',
  'tenantId',
  'branchId',
  'userId',
  'status',
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
  // A return decides none of these either. `refundTotal` and `returnTotal` are
  // named because a client that computed one has a bug that will keep sending
  // it, and the first person to notice should not be an auditor.
  'shiftId',
  'terminalCode',
  'refundTotal',
  'refundTotalMinor',
  'returnTotal',
  'returnTotalMinor',
  'returnNumber',
  'grossMinor',
  'lineDiscountMinor',
  'basketDiscountMinor',
  'vatBasisPoints',
  'currency',
  'price',
] as const;

export function namesForbiddenField(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  for (const field of FORBIDDEN_FIELDS) {
    if (Object.hasOwn(body, field)) return field;
  }
  return null;
}

/**
 * Look for cardholder data anywhere in the request, not just at the top.
 *
 * A PAN arrives nested inside a tender far more plausibly than at the root, so
 * a top-level check would be theatre. Bounded depth, because the thing being
 * defended against is hostile input and an unbounded walk is its own problem.
 */
/**
 * A card number sent as a value rather than as a field name.
 *
 * Refusing keys called `pan` or `cardNumber` is necessary and nowhere near
 * sufficient: a broken integration will put a card number in a field called
 * `reference`, and it would be persisted. So values are inspected too, with
 * the domain's own conservative test — 13 to 19 digits that satisfy Luhn.
 *
 * Bounded depth, like the field scan. Nothing here is logged or echoed: a
 * refusal that quotes the number is a refusal that writes it down.
 */
export function carriesCardNumber(body: unknown, depth = 0): boolean {
  if (depth > 4 || body === null) return false;
  if (typeof body === 'string') return looksLikeCardNumber(body);
  if (typeof body !== 'object') return false;

  if (Array.isArray(body)) {
    return body.some((entry) => carriesCardNumber(entry, depth + 1));
  }
  return Object.values(body as Record<string, unknown>).some((value) =>
    carriesCardNumber(value, depth + 1),
  );
}

export function namesCardField(body: unknown, depth = 0): string | null {
  if (depth > 4 || body === null || typeof body !== 'object') return null;

  if (Array.isArray(body)) {
    for (const entry of body) {
      const found = namesCardField(entry, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }

  const record = body as Record<string, unknown>;
  for (const field of FORBIDDEN_CARD_FIELDS) {
    if (Object.hasOwn(record, field)) return field;
  }
  for (const value of Object.values(record)) {
    const found = namesCardField(value, depth + 1);
    if (found !== null) return found;
  }
  return null;
}
