import { PERMISSIONS, ROLE_MAX_DISCOUNT_BP, ROLE_PERMISSIONS, newId } from '@korvi/domain';
import { withTenant, withoutTenant } from '../tenant-context.js';
import { tenantParam } from '../repositories/mapping.js';
import type { Permission, RoleName, TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';

/**
 * The application's own vocabulary, installed into the database.
 *
 * `Record<Permission, ...>` rather than an array: the type system then refuses
 * to compile if a permission is added to the domain and not described here, so
 * the two catalogues cannot drift without somebody noticing at build time.
 * A test asserts the reverse direction — nothing described here that the domain
 * does not define.
 */
export const PERMISSION_CATALOGUE: Readonly<
  Record<Permission, { readonly ar: string; readonly en: string }>
> = {
  'product.read': { ar: 'عرض المنتجات', en: 'View products' },
  'product.write': { ar: 'تعديل المنتجات', en: 'Edit products' },
  'inventory.read': { ar: 'عرض المخزون', en: 'View inventory' },
  'inventory.adjust': { ar: 'تسوية المخزون', en: 'Adjust inventory' },
  'sale.create': { ar: 'إتمام عملية بيع', en: 'Complete a sale' },
  'sale.discount': { ar: 'منح خصم', en: 'Grant a discount' },
  'sale.refund': { ar: 'استرجاع مبيعات', en: 'Refund a sale' },
  'sale.void': { ar: 'إلغاء فاتورة', en: 'Void an invoice' },
  'shift.open': { ar: 'فتح وردية', en: 'Open a shift' },
  'shift.close': { ar: 'إغلاق وردية', en: 'Close a shift' },
  'shift.cash-movement': { ar: 'تسجيل حركة نقدية', en: 'Record a cash movement' },
  'customer.read': { ar: 'عرض العملاء', en: 'View customers' },
  'customer.write': { ar: 'تعديل بيانات العملاء', en: 'Edit customers' },
  'report.read': { ar: 'عرض التقارير', en: 'View reports' },
  'settings.manage': { ar: 'إدارة الإعدادات', en: 'Manage settings' },
  'users.manage': { ar: 'إدارة المستخدمين', en: 'Manage users' },
  'zatca.manage': { ar: 'إدارة تكامل هيئة الزكاة والضريبة والجمارك', en: 'Manage ZATCA' },
};

export const DEFAULT_ROLES: Readonly<
  Record<RoleName, { readonly ar: string; readonly en: string }>
> = {
  owner: { ar: 'مالك', en: 'Owner' },
  admin: { ar: 'مدير النظام', en: 'Administrator' },
  manager: { ar: 'مشرف', en: 'Manager' },
  cashier: { ar: 'كاشير', en: 'Cashier' },
};

/**
 * Install the permission catalogue into the global table.
 *
 * Global because the vocabulary is the application's, identical for every
 * tenant and derived from nobody's data (ADR-0004). Idempotent: running it on
 * every boot is the intended usage, and it must never disturb a tenant's own
 * role bindings, which live in the tenant-owned role_permissions table.
 */
export async function provisionPermissionCatalogue(prisma: PrismaClient): Promise<number> {
  return withoutTenant(prisma, async (tx) => {
    for (const key of PERMISSIONS) {
      const described = PERMISSION_CATALOGUE[key];
      await tx.permission.upsert({
        where: { key },
        create: { key, descriptionAr: described.ar, descriptionEn: described.en },
        update: { descriptionAr: described.ar, descriptionEn: described.en },
      });
    }
    return PERMISSIONS.length;
  });
}

export interface ProvisionedRole {
  readonly key: RoleName;
  readonly id: string;
  readonly permissions: readonly Permission[];
}

/**
 * Install Korvi's default roles for one tenant.
 *
 * The role set, the permissions each grants and the discount ceiling all come
 * from @korvi/domain — this function copies them into the database, it does not
 * decide them. Inventing a second definition here is how a POS ends up with a
 * cashier who can discount in the database and cannot in the code.
 *
 * Internal by design: there is no HTTP route that reaches it.
 */
export async function provisionTenantRbac(
  prisma: PrismaClient,
  scope: TenantScope,
  nextId: () => string = newId,
): Promise<readonly ProvisionedRole[]> {
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    const provisioned: ProvisionedRole[] = [];

    for (const key of Object.keys(DEFAULT_ROLES) as RoleName[]) {
      const label = DEFAULT_ROLES[key];
      const existing = await tx.role.findFirst({ where: { tenantId: tenant, key } });
      const id = existing?.id ?? nextId();

      if (existing === null) {
        await tx.role.create({
          data: {
            id,
            tenantId: tenant,
            key,
            nameAr: label.ar,
            nameEn: label.en,
            maxDiscountBasisPoints: Number(ROLE_MAX_DISCOUNT_BP[key]),
            isSystem: true,
          },
        });
      } else {
        await tx.role.updateMany({
          where: { id, tenantId: tenant },
          data: {
            nameAr: label.ar,
            nameEn: label.en,
            maxDiscountBasisPoints: Number(ROLE_MAX_DISCOUNT_BP[key]),
            isSystem: true,
          },
        });
      }

      const granted = ROLE_PERMISSIONS[key];
      for (const permissionKey of granted) {
        const already = await tx.rolePermission.findFirst({
          where: { tenantId: tenant, roleId: id, permissionKey },
        });
        if (already === null) {
          await tx.rolePermission.create({
            data: { id: nextId(), tenantId: tenant, roleId: id, permissionKey },
          });
        }
      }

      // Anything this role was granted that the default no longer includes is
      // removed, so lowering a default actually lowers it.
      await tx.rolePermission.deleteMany({
        where: { tenantId: tenant, roleId: id, permissionKey: { notIn: [...granted] } },
      });

      provisioned.push({ key, id, permissions: granted });
    }

    return provisioned;
  });
}

/** Bind a user to one of the tenant's roles. Idempotent. */
export async function assignRole(
  prisma: PrismaClient,
  scope: TenantScope,
  userId: string,
  role: RoleName,
  nextId: () => string = newId,
): Promise<void> {
  await withTenant(prisma, scope.tenantId, async (tx) => {
    const tenant = tenantParam(scope);
    const target = await tx.role.findFirst({ where: { tenantId: tenant, key: role } });
    if (target === null) {
      throw new Error(`Role "${role}" is not provisioned for this tenant.`);
    }
    const existing = await tx.userRole.findFirst({
      where: { tenantId: tenant, userId, roleId: target.id },
    });
    if (existing === null) {
      await tx.userRole.create({
        data: { id: nextId(), tenantId: tenant, userId, roleId: target.id },
      });
    }
  });
}
