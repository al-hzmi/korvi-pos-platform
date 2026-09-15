import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@korvi/domain';
import {
  createPrismaClient,
  provisionPermissionCatalogue,
  withLoginSlug,
  withTenant,
} from '@korvi/database';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { PrismaClient } from '@korvi/database';

/**
 * Gate 12 — the supported customer-provisioning chain against real PostgreSQL.
 *
 * This is deliberately HTTP-first. The individual authorities already have
 * lower-level live tests; this file proves that the supported operator and
 * merchant surfaces actually connect into one usable merchant rather than
 * stopping at a collection of independently-correct endpoints.
 *
 * Opt-in. KORVI_TEST_DATABASE_URL must point at a throwaway database with all
 * migrations applied and connected as the ordinary application role.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const ORIGIN = 'http://localhost:3000';
const PLATFORM_ACCESS_KEY = 'gate12-access-'.padEnd(48, 'a');
const PLATFORM_SIGNING_KEY = 'gate12-session-'.padEnd(48, 'b');
const BOOTSTRAP_SIGNING_KEY = 'gate12-bootstrap-'.padEnd(48, 'c');
const PLATFORM_ACTOR = 'platform:test/gate-12';
const OWNER_PASSWORD = 'Gate12-Owner-Password-9!';

interface TenantCreated {
  readonly id: string;
  readonly slug: string;
  readonly status: string;
  readonly created: boolean;
}

interface OwnerCapability {
  readonly capability: string;
  readonly created: boolean;
}

interface OperationsCreated {
  readonly branch: { readonly id: string; readonly code: string };
  readonly terminal: { readonly id: string; readonly code: string; readonly branchId: string };
  readonly replayed: boolean;
}

interface MerchantLogin {
  readonly user: { readonly id: string; readonly email: string };
  readonly tenant: { readonly id: string; readonly slug: string };
  readonly branchId: string | null;
  readonly permissions: readonly string[];
}

interface ProductCreated {
  readonly id: string;
}

interface ShiftOpened {
  readonly shift: { readonly id: string; readonly branchId: string; readonly terminalId: string };
}

interface SaleCreated {
  readonly sale: { readonly saleId: string; readonly branchId: string; readonly terminalId: string };
  readonly replayed: boolean;
}

function cookieFrom(response: LightMyRequestResponse): string {
  const raw = response.headers['set-cookie'];
  if (raw === undefined) throw new Error('expected HttpOnly session cookie');
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) throw new Error('expected session cookie value');
  return value.split(';', 1)[0] ?? '';
}

function writeHeaders(cookie?: string): Record<string, string> {
  return {
    origin: ORIGIN,
    ...(cookie === undefined ? {} : { cookie }),
  };
}

describe.skipIf(url === '')('Gate 12 platform provisioning to first sale, live', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let slug: string;
  let ownerEmail: string;
  let previousDatabaseUrl: string | undefined;
  let previousBootstrapKey: string | undefined;

  async function purge(): Promise<void> {
    const tenantId = await withLoginSlug(prisma, slug, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "tenants" WHERE "slug" = ${slug} LIMIT 1
      `;
      return rows[0]?.id ?? null;
    });
    if (tenantId === null) return;
    await withTenant(prisma, tenantId, async (tx) => {
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  }

  beforeAll(async () => {
    const run = newId().replaceAll('-', '').slice(-12);
    slug = `gate12-${run}`;
    ownerEmail = `owner-${run}@gate12.test`;

    previousDatabaseUrl = process.env['DATABASE_URL'];
    previousBootstrapKey = process.env['BOOTSTRAP_SIGNING_KEY'];
    // The Platform issuer modules intentionally read deployment secrets rather
    // than accepting browser/config authority. Mirror the deployment contract.
    process.env['DATABASE_URL'] = url;
    process.env['BOOTSTRAP_SIGNING_KEY'] = BOOTSTRAP_SIGNING_KEY;

    prisma = createPrismaClient(url);
    await provisionPermissionCatalogue(prisma);

    app = buildServer(
      loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'fatal',
        APP_ORIGINS: ORIGIN,
        DATABASE_URL: url,
        BOOTSTRAP_SIGNING_KEY,
        PLATFORM_ADMIN_ACCESS_KEY: PLATFORM_ACCESS_KEY,
        PLATFORM_SESSION_SIGNING_KEY: PLATFORM_SIGNING_KEY,
        PLATFORM_ADMIN_ACTOR_REF: PLATFORM_ACTOR,
        PLATFORM_SESSION_TTL_HOURS: '1',
        SESSION_TTL_HOURS: '1',
      }),
    );
    await app.ready();
  }, 90_000);

  afterAll(async () => {
    if (app !== undefined) await app.close();
    if (prisma !== undefined) {
      await purge();
      await prisma.$disconnect();
    }
    if (previousDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = previousDatabaseUrl;
    if (previousBootstrapKey === undefined) delete process.env['BOOTSTRAP_SIGNING_KEY'];
    else process.env['BOOTSTRAP_SIGNING_KEY'] = previousBootstrapKey;
  }, 90_000);

  it('provisions a tenant through Platform Admin and reaches a real cashier sale as the initial Owner', async () => {
    // 1 — Platform Admin sign-in.
    const platformLogin = await app.inject({
      method: 'POST',
      url: '/v1/platform/session',
      headers: writeHeaders(),
      payload: { accessKey: PLATFORM_ACCESS_KEY },
    });
    expect(platformLogin.statusCode).toBe(200);
    const platformCookie = cookieFrom(platformLogin);

    // 2 — Tenant/business creation through the supported platform workflow.
    const createTenant = await app.inject({
      method: 'POST',
      url: '/v1/platform/tenants',
      headers: writeHeaders(platformCookie),
      payload: {
        operationId: newId(),
        slug,
        name: 'متجر إثبات Gate 12',
        vatNumber: '300000000000003',
        vertical: 'retail',
      },
    });
    expect(createTenant.statusCode).toBe(201);
    const tenant = createTenant.json<TenantCreated>();
    expect(tenant).toMatchObject({ slug, status: 'provisioning', created: true });

    // 3 — Commercial plan + entitlement assignment.
    const plan = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenant.id}/plan`,
      headers: writeHeaders(platformCookie),
      payload: {
        operationId: newId(),
        planKey: 'commercial',
        planRevision: 1,
        accountState: 'active',
        entitlements: [
          { key: 'users.max', kind: 'limit', limit: '10' },
          { key: 'pos.enabled', kind: 'flag', enabled: true },
        ],
      },
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json()).toMatchObject({ planKey: 'commercial', planRevision: 1, state: 'active' });

    // 4 — Issue the initial-owner one-time capability, then accept it through
    // the public bootstrap surface. This intentionally happens before branch
    // creation to exercise the real documented Gate 12 ordering.
    const ownerIssue = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenant.id}/owner-bootstrap`,
      headers: writeHeaders(platformCookie),
      payload: {
        operationId: newId(),
        email: ownerEmail,
        displayName: 'مالك Gate 12',
      },
    });
    expect(ownerIssue.statusCode).toBe(201);
    const ownerCapability = ownerIssue.json<OwnerCapability>();
    expect(ownerCapability.created).toBe(true);
    expect(ownerCapability.capability.length).toBeGreaterThan(32);

    const ownerAccept = await app.inject({
      method: 'POST',
      url: '/v1/bootstrap/owner',
      headers: writeHeaders(),
      payload: { token: ownerCapability.capability, password: OWNER_PASSWORD },
    });
    expect(ownerAccept.statusCode).toBe(204);

    // 5 + 6 — First branch and terminal, atomically. This is the operation that
    // must also pin the previously-created Owner membership to the branch.
    const operational = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenant.id}/operational-bootstrap`,
      headers: writeHeaders(platformCookie),
      payload: {
        operationId: newId(),
        branch: { code: 'BR-01', nameAr: 'الفرع الرئيسي', nameEn: 'Main Branch' },
        terminal: { code: 'POS-01', label: 'الكاشير الرئيسي' },
      },
    });
    expect(operational.statusCode).toBe(201);
    const operations = operational.json<OperationsCreated>();
    expect(operations).toMatchObject({
      branch: { code: 'BR-01' },
      terminal: { code: 'POS-01' },
      replayed: false,
    });
    expect(operations.terminal.branchId).toBe(operations.branch.id);

    const activate = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenant.id}/activate`,
      headers: writeHeaders(platformCookie),
      payload: { operationId: newId() },
    });
    expect(activate.statusCode).toBe(200);
    expect(activate.json()).toMatchObject({ id: tenant.id, status: 'active', changed: true });

    // 7 + 8 — The owner signs in using only tenant code/email/password. The
    // branch id must now be server-derived from the membership we just bound.
    const merchantLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: writeHeaders(),
      payload: { tenantSlug: slug, email: ownerEmail, password: OWNER_PASSWORD },
    });
    expect(merchantLogin.statusCode).toBe(200);
    const merchant = merchantLogin.json<MerchantLogin>();
    expect(merchant.tenant).toEqual({ id: tenant.id, slug });
    expect(merchant.branchId).toBe(operations.branch.id);
    expect(merchant.permissions).toContain('shift.open');
    expect(merchant.permissions).toContain('sale.create');
    const merchantCookie = cookieFrom(merchantLogin);

    const terminals = await app.inject({
      method: 'GET',
      url: '/v1/terminals',
      headers: { cookie: merchantCookie },
    });
    expect(terminals.statusCode).toBe(200);
    expect(terminals.json()).toMatchObject({
      branchId: operations.branch.id,
      terminals: [
        {
          id: operations.terminal.id,
          branchId: operations.branch.id,
          code: 'POS-01',
        },
      ],
    });

    // 9 — Minimal merchant configuration and catalogue bootstrap through the
    // merchant administration surface. Inventory is disabled only in this
    // proof so the first-sale assertion isolates customer provisioning; the
    // inventory-integrity gates are covered independently and are extended in
    // the full Gate 12 acceptance run.
    const settings = await app.inject({
      method: 'PATCH',
      url: '/v1/admin/settings',
      headers: writeHeaders(merchantCookie),
      payload: { trackInventory: false, requireBarcode: false },
    });
    expect(settings.statusCode).toBe(200);

    const productResponse = await app.inject({
      method: 'POST',
      url: '/v1/admin/products',
      headers: writeHeaders(merchantCookie),
      payload: {
        sku: 'GATE12-ITEM-1',
        nameAr: 'صنف اختبار التجهيز',
        nameEn: 'Provisioning proof item',
        productType: 'unit',
        unitLabel: 'حبة',
        priceMinor: '1000',
        vatBasisPoints: 1500,
        barcode: null,
      },
    });
    expect(productResponse.statusCode).toBe(201);
    const product = productResponse.json<ProductCreated>();

    // 10 — Open the cashier/shift on the terminal created by Platform Admin.
    const shiftResponse = await app.inject({
      method: 'POST',
      url: '/v1/shifts/open',
      headers: writeHeaders(merchantCookie),
      payload: { terminalId: operations.terminal.id, openingFloatMinor: '5000' },
    });
    expect(shiftResponse.statusCode).toBe(201);
    const shift = shiftResponse.json<ShiftOpened>();
    expect(shift.shift).toMatchObject({
      branchId: operations.branch.id,
      terminalId: operations.terminal.id,
    });

    // 11 — Complete the first representative cash sale through normal checkout.
    const saleResponse = await app.inject({
      method: 'POST',
      url: '/v1/sales',
      headers: writeHeaders(merchantCookie),
      payload: {
        operationId: newId(),
        terminalId: operations.terminal.id,
        expectedShiftId: shift.shift.id,
        cashReceivedMinor: '5000',
        lines: [{ productId: product.id, quantityScaled: '1000' }],
      },
    });
    expect(saleResponse.statusCode).toBe(201);
    const sale = saleResponse.json<SaleCreated>();
    expect(sale.replayed).toBe(false);
    expect(sale.sale).toMatchObject({
      branchId: operations.branch.id,
      terminalId: operations.terminal.id,
    });

    // Database evidence closes the exact gap that previously existed: the
    // Owner membership is branch-bound, the assignment is audited as a Platform
    // action, and the sale made it into authoritative persistence.
    await withTenant(prisma, tenant.id, async (tx) => {
      const membership = await tx.tenantMembership.findFirst({
        where: { tenantId: tenant.id, userId: merchant.user.id },
        select: { defaultBranchId: true },
      });
      expect(membership?.defaultBranchId).toBe(operations.branch.id);

      const assignmentAudit = await tx.auditEvent.findFirst({
        where: {
          tenantId: tenant.id,
          eventType: 'platform.owner-default-branch-assigned',
          entityId: merchant.user.id,
        },
        select: { actorUserId: true, metadata: true },
      });
      expect(assignmentAudit).not.toBeNull();
      expect(assignmentAudit?.actorUserId).toBeNull();
      expect(assignmentAudit?.metadata).toMatchObject({
        controlPlaneActorRef: PLATFORM_ACTOR,
        branchId: operations.branch.id,
      });

      const persistedSale = await tx.sale.findFirst({
        where: { tenantId: tenant.id, id: sale.sale.saleId },
        select: { id: true, branchId: true, terminalId: true },
      });
      expect(persistedSale).toEqual({
        id: sale.sale.saleId,
        branchId: operations.branch.id,
        terminalId: operations.terminal.id,
      });
    });
  }, 120_000);
});
