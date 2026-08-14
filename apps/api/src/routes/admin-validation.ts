import { z } from 'zod';
import {
  MAX_ADMIN_CODE,
  MAX_ADMIN_LIST_PAGE,
  MAX_ADMIN_NAME,
  MAX_RECEIPT_LINE,
} from '@korvi/domain';
import { UUID } from './validation.js';

/**
 * What a merchant administrator may say, and nothing else.
 *
 * Every schema here is `.strict()`. The cashier's routes reject a named list of
 * forbidden fields, which is the right shape for a surface where new legitimate
 * fields keep arriving; administration is the opposite case. It is small, it
 * changes rarely, and the fields it must never accept are exactly "everything
 * nobody thought to name" — a client that sends `tenantId`, `permissions` or
 * `authVersion` should be told, not quietly ignored.
 *
 * `FORBIDDEN_ADMIN_FIELDS` is checked as well, before parsing, so the answer to
 * an attempt at authority is a specific one rather than "unrecognized key".
 */

/**
 * A page and a place to continue from.
 *
 * The cursor is an opaque token the server minted; it is bounded so a client
 * cannot post a megabyte of base64, and it carries no tenant and no actor —
 * scope comes from the session, and the server refuses anything it did not
 * mint rather than treating it as "start again".
 */
const CURSOR = z.string().min(1).max(512);

export const adminListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_ADMIN_LIST_PAGE).default(50),
    cursor: CURSOR.optional(),
  })
  .strict();

export const terminalListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_ADMIN_LIST_PAGE).default(50),
    branchId: UUID.optional(),
    cursor: CURSOR.optional(),
  })
  .strict();

/**
 * The settings a merchant may change about their own shop.
 *
 * Absent on purpose: `vertical`, `priceMode`, `defaultVatBasisPoints` and
 * `currency`. Each re-prices or re-taxes every sale that follows, and two of
 * them change how an already-printed receipt should be read. Also absent:
 * anything to do with the tenant's lifecycle status, which is 4A's and is not
 * a setting.
 */
export const settingsPatchBody = z
  .object({
    requireBarcode: z.boolean().optional(),
    allowWeightedItems: z.boolean().optional(),
    trackInventory: z.boolean().optional(),
    allowNegativeStock: z.boolean().optional(),
    enableProductImages: z.boolean().optional(),
    // `null` clears the line; an absent key leaves it alone. A schema that
    // could not say both would make a set footer permanent.
    receiptHeaderAr: z.string().max(MAX_RECEIPT_LINE).nullable().optional(),
    receiptFooterAr: z.string().max(MAX_RECEIPT_LINE).nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'nothing to change' });

const CODE = z.string().min(1).max(MAX_ADMIN_CODE);
const NAME = z.string().min(1).max(MAX_ADMIN_NAME);

export const branchCreateBody = z
  .object({
    code: CODE,
    nameAr: NAME,
    nameEn: z.string().max(MAX_ADMIN_NAME).nullable().optional(),
  })
  .strict();

export const branchPatchBody = z
  .object({
    nameAr: NAME.optional(),
    nameEn: z.string().max(MAX_ADMIN_NAME).nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'nothing to change' });

export const terminalCreateBody = z
  .object({
    branchId: UUID,
    code: CODE,
    label: NAME,
  })
  .strict();

export const terminalPatchBody = z.object({ label: NAME }).strict();

export const activationBody = z.object({ isActive: z.boolean() }).strict();

export const memberCreateBody = z
  .object({
    email: z.string().min(3).max(254),
    displayName: NAME,
    defaultBranchId: UUID.nullable().optional(),
  })
  .strict();

export const memberPatchBody = z
  .object({
    displayName: NAME.optional(),
    defaultBranchId: UUID.nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'nothing to change' });

export const roleAssignmentBody = z.object({ roleId: UUID }).strict();

export const branchParams = z.object({ branchId: UUID }).strict();
export const terminalParams = z.object({ terminalId: UUID }).strict();
export const memberParams = z.object({ userId: UUID }).strict();
export const memberRoleParams = z.object({ userId: UUID, roleId: UUID }).strict();

/**
 * Authority a client may never assert, named so the refusal is legible.
 *
 * `.strict()` would already reject every one of these. They are listed anyway
 * because "unrecognized_keys: tenantId" and "a client tried to set the tenant"
 * are the same event to a parser and very different events to whoever reads
 * the log, and because the list is the documentation of what this surface
 * refuses to be told.
 */
export const FORBIDDEN_ADMIN_FIELDS = [
  'tenantId',
  'tenant',
  'userId',
  'actorUserId',
  'sessionId',
  'role',
  'roles',
  'permissions',
  'permissionKeys',
  'maxDiscountBasisPoints',
  'isSystem',
  'passwordHash',
  'password',
  'tokenHash',
  'authVersion',
  'failedLoginCount',
  'lockedUntil',
  'status',
  'lifecycleProvenance',
  'activatedAt',
  'suspendedAt',
  'suspensionReason',
  'provisioningOperationId',
  'provisioningRequestHash',
  'vertical',
  'priceMode',
  'defaultVatBasisPoints',
  'currency',
] as const;

export function namesAdminAuthorityField(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  for (const field of FORBIDDEN_ADMIN_FIELDS) {
    if (Object.hasOwn(body, field)) return field;
  }
  return null;
}
