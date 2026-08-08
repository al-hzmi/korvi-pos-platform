import { assertSameTenant, basisPointsFromColumn, tenantId } from '@korvi/domain';
import { DatabaseError } from '../errors.js';
import type { BasisPoints, TenantId, TenantScope } from '@korvi/domain';

/**
 * The mapping boundary.
 *
 * Every repository row passes through these helpers on its way out. Three
 * things happen here and nowhere else:
 *
 *   BigInt becomes a string. Prisma hands back a native bigint; JSON.stringify
 *   throws on one, and Number() loses halalas above 2^53 (ADR-0002).
 *
 *   Date becomes ISO 8601. A Date carries a local rendering that survives no
 *   boundary intact.
 *
 *   Free-text status columns are narrowed to their union. A row whose `status`
 *   says something the code has never heard of fails here, loudly, instead of
 *   flowing into a switch that silently takes the default branch.
 *
 * The tenant check is the fourth: `scoped()` refuses a row whose tenantId is
 * not the scope's. Under RLS that row cannot exist, so the assertion is a
 * tripwire on the boundary rather than the boundary itself.
 */

export function minor(value: bigint): string {
  return value.toString();
}

export function minorOrNull(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

export function iso(value: Date): string {
  return value.toISOString();
}

export function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function rate(column: number): BasisPoints {
  return basisPointsFromColumn(column);
}

/** Narrow a row's tenantId, having first proved it belongs to the scope. */
export function scoped(scope: TenantScope, rowTenantId: string): TenantId {
  assertSameTenant(scope, rowTenantId);
  return tenantId(rowTenantId);
}

/** The scope's tenant id as the plain string a query parameter needs. */
export function tenantParam(scope: TenantScope): string {
  return scope.tenantId as string;
}

/**
 * Narrow a text column to a known union.
 *
 * Throws rather than defaulting: a `priceMode` of "tax-inclusiv" that quietly
 * became "tax-exclusive" would misprice every line on the receipt.
 */
export function oneOf<T extends string>(allowed: readonly T[], value: string, column: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new DatabaseError(
      `Column ${column} holds "${value}", which is not one of: ${allowed.join(', ')}.`,
    );
  }
  return match;
}
