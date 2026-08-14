import { TENANT_LIFECYCLE_STATES } from '@korvi/domain';
import { withTenant } from '../tenant-context.js';
import { oneOf, rate, scoped, tenantParam } from './mapping.js';
import type {
  PriceMode,
  Tenant,
  TenantRepository,
  TenantScope,
  TenantSettings,
  TenantStatus,
  Vertical,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

const STATUSES: readonly TenantStatus[] = [...TENANT_LIFECYCLE_STATES];
const VERTICALS: readonly Vertical[] = ['retail', 'grocery', 'restaurant', 'pharmacy'];
const PRICE_MODES: readonly PriceMode[] = ['tax-inclusive', 'tax-exclusive'];

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  vatNumber: string | null;
  status: string;
}

interface SettingsRow {
  tenantId: string;
  vertical: string;
  priceMode: string;
  defaultVatBasisPoints: number;
  currency: string;
  requireBarcode: boolean;
  allowWeightedItems: boolean;
  trackInventory: boolean;
  allowNegativeStock: boolean;
  receiptHeaderAr: string | null;
  receiptFooterAr: string | null;
}

/**
 * Reads about the tenant itself.
 *
 * `current()` takes a scope and can only ever return the tenant that scope
 * names — there is no findById, because a method that takes an arbitrary
 * tenant id and returns that tenant is exactly the cross-tenant read this
 * layer exists to prevent.
 */
export function createTenantRepository(prisma: PrismaClient): TenantRepository {
  return {
    async current(scope: TenantScope): Promise<Tenant | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: TenantRow | null = await tx.tenant.findFirst({
          where: { id: tenantParam(scope) },
        });
        if (row === null) return null;
        return {
          id: scoped(scope, row.id),
          slug: row.slug,
          name: row.name,
          status: oneOf(STATUSES, row.status, 'tenants.status'),
          vatNumber: row.vatNumber,
        };
      });
    },

    async settings(scope: TenantScope): Promise<TenantSettings | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: SettingsRow | null = await tx.tenantSettings.findFirst({
          where: { tenantId: tenantParam(scope) },
        });
        if (row === null) return null;
        return {
          tenantId: scoped(scope, row.tenantId),
          vertical: oneOf(VERTICALS, row.vertical, 'tenant_settings.vertical'),
          priceMode: oneOf(PRICE_MODES, row.priceMode, 'tenant_settings.priceMode'),
          defaultVatBasisPoints: rate(row.defaultVatBasisPoints),
          currency: row.currency,
          requireBarcode: row.requireBarcode,
          allowWeightedItems: row.allowWeightedItems,
          trackInventory: row.trackInventory,
          allowNegativeStock: row.allowNegativeStock,
          receiptHeaderAr: row.receiptHeaderAr,
          receiptFooterAr: row.receiptFooterAr,
        };
      });
    },
  };
}

/*
 * No `findBySlug`, and no unscoped tenant lookup of any kind — see the note in
 * @korvi/domain's ports/persistence.ts. Hostname-to-tenant resolution runs
 * before a scope exists and therefore belongs with authentication, which this
 * strike does not build. A "temporary" unscoped lookup added here would become
 * the method every later caller reaches for.
 */
