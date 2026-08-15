import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId, tenantId as brandTenantId } from '@korvi/domain';
import {
  activateTenant,
  createPrismaClient,
  provisionPermissionCatalogue,
  provisionTenant,
  readTenantOnboardingReadiness,
  withLoginSlug,
  withTenant,
} from '../index.js';
import type { PrismaClient } from '../index.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const SLUG = '4d-readiness-live';
const OPERATOR = 'ops:platform/4d-suite';

describe.skipIf(url === '')('onboarding readiness authority, live', () => {
  let prisma: PrismaClient;
  let tenant: string;
  let branch: string;
  let terminal: string;
  let product: string;
  let administrator: string;

  async function purge(): Promise<void> {
    const id = await withLoginSlug(prisma, SLUG, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "tenants" WHERE "slug" = ${SLUG}`;
      return rows[0]?.id ?? null;
    });

    if (id === null) return;

    await withTenant(prisma, id, async (tx) => {
      await tx.tenant.deleteMany({ where: { id } });
    });
  }

  async function buildReadyMerchant(): Promise<void> {
    const provisioned = await provisionTenant(prisma, {
      operationId: `provision-${newId()}`,
      slug: SLUG,
      name: 'متجر جاهزية 4D',
      vatNumber: '300000000000003',
      vertical: 'retail',
      controlPlaneActorRef: OPERATOR,
    });

    tenant = provisioned.id;

    await activateTenant(prisma, {
      tenantId: tenant,
      operationId: `activate-${newId()}`,
      controlPlaneActorRef: OPERATOR,
    });

    const owner = provisioned.roles.find((role) => role.key === 'owner');
    if (owner === undefined) throw new Error('owner role was not provisioned');

    branch = newId();
    terminal = newId();
    product = newId();
    administrator = newId();

    await withTenant(prisma, tenant, async (tx) => {
      await tx.branch.create({
        data: {
          id: branch,
          tenantId: tenant,
          code: '01',
          nameAr: 'الفرع الرئيسي',
        },
      });

      await tx.terminal.create({
        data: {
          id: terminal,
          tenantId: tenant,
          branchId: branch,
          code: 'T1',
          label: 'الصندوق الرئيسي',
        },
      });

      await tx.product.create({
        data: {
          id: product,
          tenantId: tenant,
          sku: 'READY-001',
          nameAr: 'منتج جاهزية',
          priceMinor: 1000n,
        },
      });

      await tx.user.create({
        data: {
          id: administrator,
          tenantId: tenant,
          email: 'owner@4d-readiness.test',
          displayName: 'مالك المتجر',
          passwordHash: 'test-only-credential-present',
        },
      });

      await tx.tenantMembership.create({
        data: {
          id: newId(),
          tenantId: tenant,
          userId: administrator,
          defaultBranchId: branch,
        },
      });

      await tx.userRole.create({
        data: {
          id: newId(),
          tenantId: tenant,
          userId: administrator,
          roleId: owner.id,
        },
      });
    });
  }

  async function readiness() {
    return readTenantOnboardingReadiness(prisma, {
      tenantId: brandTenantId(tenant),
    });
  }

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await prisma.$connect();
    await provisionPermissionCatalogue(prisma);
  });

  beforeEach(async () => {
    await purge();
    await buildReadyMerchant();
  });

  afterAll(async () => {
    await purge();
    await prisma.$disconnect();
  });

  it('derives a ready merchant from live operational truth', async () => {
    const result = await readiness();

    expect(result?.ready).toBe(true);
    expect(result?.checks.every((check) => check.ready)).toBe(true);
  });

  it('does not leave a stale ready flag when an operational fact changes', async () => {
    await withTenant(prisma, tenant, async (tx) => {
      await tx.terminal.update({
        where: { id: terminal },
        data: { isActive: false },
      });
    });

    const withoutTill = await readiness();
    expect(withoutTill?.ready).toBe(false);
    expect(withoutTill?.checks.find((check) => check.key === 'active-terminal')?.blocker).toBe(
      'no-active-terminal',
    );

    await withTenant(prisma, tenant, async (tx) => {
      await tx.terminal.update({
        where: { id: terminal },
        data: { isActive: true },
      });
      await tx.product.update({
        where: { id: product },
        data: { isActive: false },
      });
    });

    const withoutProduct = await readiness();
    expect(withoutProduct?.ready).toBe(false);
    expect(withoutProduct?.checks.find((check) => check.key === 'active-product')?.blocker).toBe(
      'no-active-product',
    );
  });

  it('does not call an uncredentialed account a viable administrator', async () => {
    await withTenant(prisma, tenant, async (tx) => {
      await tx.user.update({
        where: { id: administrator },
        data: { passwordHash: null },
      });
    });

    const result = await readiness();

    expect(result?.ready).toBe(false);
    expect(result?.checks.find((check) => check.key === 'viable-administrator')?.blocker).toBe(
      'no-viable-administrator',
    );
  });

  it('does not call an inactive membership a viable administrator', async () => {
    await withTenant(prisma, tenant, async (tx) => {
      await tx.tenantMembership.update({
        where: {
          tenantId_userId: {
            tenantId: tenant,
            userId: administrator,
          },
        },
        data: { status: 'inactive' },
      });
    });

    const result = await readiness();

    expect(result?.ready).toBe(false);
    expect(result?.checks.find((check) => check.key === 'viable-administrator')?.blocker).toBe(
      'no-viable-administrator',
    );
  });

  it('derives administrator viability from permissions, not the role name', async () => {
    await withTenant(prisma, tenant, async (tx) => {
      const assignment = await tx.userRole.findFirstOrThrow({
        where: {
          tenantId: tenant,
          userId: administrator,
        },
      });

      await tx.rolePermission.deleteMany({
        where: {
          tenantId: tenant,
          roleId: assignment.roleId,
          permissionKey: 'users.manage',
        },
      });
    });

    const result = await readiness();

    expect(result?.ready).toBe(false);
    expect(result?.checks.find((check) => check.key === 'viable-administrator')?.blocker).toBe(
      'no-viable-administrator',
    );
  });

  it('requires an active branch behind an active terminal', async () => {
    await withTenant(prisma, tenant, async (tx) => {
      await tx.branch.update({
        where: { id: branch },
        data: { isActive: false },
      });
    });

    const result = await readiness();

    expect(result?.ready).toBe(false);
    expect(result?.checks.find((check) => check.key === 'active-branch')?.blocker).toBe(
      'no-active-branch',
    );
    expect(result?.checks.find((check) => check.key === 'active-terminal')?.blocker).toBe(
      'no-active-terminal',
    );
  });
});
