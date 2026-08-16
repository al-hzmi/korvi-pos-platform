import { afterEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@korvi/domain';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import { createAuthService } from '../auth/service.js';
import { hashPassword } from '../auth/password.js';
import { createCheckoutService } from '../checkout/service.js';
import { createReturnService } from '../returns/service.js';
import { createDrawerService } from '../shifts/service.js';
import {
  MemoryAuthStore,
  memoryAuditRepository as memoryAuthAudit,
  memoryAuthRepository,
} from './support/memory-auth.js';
import {
  MemoryBusinessStore,
  memoryAuditRepository,
  memoryDashboardRepository,
  memoryIdempotencyRepository,
  memoryInventoryRepository,
  memoryProductRepository,
  memoryReturnRepository,
  memorySaleRepository,
  memoryShiftRepository,
  memoryTenantRepository,
  memoryTerminalRepository,
  seedStore,
} from './support/memory-business.js';
import type { MerchantProductService, ProductAdminResult } from '../catalog/service.js';
import type { Fixture } from './support/memory-business.js';
import type { ProductBootstrapDraft, RoleName } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

const FAST = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'a-real-password-9!';

const A: Fixture = {
  tenant: '018fb000-0000-7000-8000-00000000000a',
  branch: '018fb000-0000-7000-8000-0000000000a1',
  terminal: '018fb000-0000-7000-8000-0000000000a2',
  shift: '018fb000-0000-7000-8000-0000000000a3',
  user: '018fb000-0000-7000-8000-0000000000a4',
  milk: '018fb000-0000-7000-8000-0000000000a5',
  rice: '018fb000-0000-7000-8000-0000000000a6',
};

const PRODUCT = {
  sku: 'SKU-NEW',
  nameAr: 'منتج جديد',
  nameEn: null,
  productType: 'unit' as const,
  unitLabel: 'each',
  priceMinor: '1250',
  vatBasisPoints: 1500,
  barcode: '6281000000012',
};

let app: FastifyInstance;
let seen: ProductBootstrapDraft[];
let answer: ProductAdminResult;

function recordingService(): MerchantProductService {
  return {
    async create(_principal, input) {
      seen.push(input);
      return answer;
    },
  };
}

async function build(role: RoleName): Promise<FastifyInstance> {
  const business = new MemoryBusinessStore();
  seedStore(business, A, true);

  const auth = new MemoryAuthStore();
  auth.tenants.push({ id: A.tenant, slug: 'korvi-a', name: 'Korvi A', status: 'active' });
  auth.users.push({
    id: A.user,
    tenantId: A.tenant,
    email: 'sara@korvi-a.test',
    displayName: 'سارة',
    passwordHash: await hashPassword(PASSWORD, FAST),
    isActive: true,
    failedLoginCount: 0,
    lockedUntil: null,
    authVersion: 1,
    lastLoginAt: null,
  });
  auth.memberships.push({
    tenantId: A.tenant,
    userId: A.user,
    status: 'active',
    defaultBranchId: A.branch,
  });
  auth.grants.push({
    tenantId: A.tenant,
    userId: A.user,
    roles: [role],
    permissions: [...ROLE_PERMISSIONS[role]],
  });

  const shifts = memoryShiftRepository(business);
  const terminals = memoryTerminalRepository(business);
  const idempotency = memoryIdempotencyRepository(business);
  const audit = memoryAuditRepository(business);
  seen = [];
  answer = {
    outcome: 'success',
    value: {
      id: '018fb000-0000-7000-8000-0000000000f1',
      sku: 'SKU-NEW',
      nameAr: 'منتج جديد',
      nameEn: null,
      productType: 'unit',
      unitLabel: 'each',
      priceMinor: '1250',
      vatBasisPoints: 1500,
      primaryBarcode: '6281000000012',
      trackInventory: true,
      isActive: true,
      createdAt: '2026-08-16T00:00:00.000Z',
    },
  };

  const server = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }), {
    auth: createAuthService({
      repository: memoryAuthRepository(auth),
      audit: memoryAuthAudit(auth),
      sessionTtlSeconds: 3600,
      scrypt: FAST,
    }),
    business: {
      tenants: memoryTenantRepository(business),
      dashboard: memoryDashboardRepository(business),
      products: memoryProductRepository(business),
      shifts,
      terminals,
      checkout: createCheckoutService({
        tenants: memoryTenantRepository(business),
        products: memoryProductRepository(business),
        inventory: memoryInventoryRepository(business),
        shifts,
        sales: memorySaleRepository(business),
        idempotency,
        audit,
      }),
      returns: createReturnService({
        returns: memoryReturnRepository(business),
        terminals,
        shifts,
        idempotency,
        audit,
      }),
      drawer: createDrawerService({ shifts, terminals, idempotency, audit }),
    },
    catalog: recordingService(),
  });
  await server.ready();
  app = server;
  return server;
}

async function cookieFor(server: FastifyInstance): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { origin: ORIGIN },
    payload: { tenantSlug: 'korvi-a', email: 'sara@korvi-a.test', password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  return header.split(';')[0] ?? '';
}

const send = (cookie: string | null, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/v1/admin/products',
    headers: { origin: ORIGIN, ...(cookie === null ? {} : { cookie }) },
    payload: payload as never,
  });

afterEach(async () => {
  await app.close();
});

describe('product bootstrap HTTP authority', () => {
  it('requires an authenticated session', async () => {
    await build('owner');
    expect((await send(null, PRODUCT)).statusCode).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('requires product.write rather than merely product.read', async () => {
    const server = await build('cashier');
    const cookie = await cookieFor(server);
    expect((await send(cookie, PRODUCT)).statusCode).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('accepts exact money as a string and delegates only the product draft', async () => {
    const server = await build('manager');
    const cookie = await cookieFor(server);
    const response = await send(cookie, PRODUCT);
    expect(response.statusCode).toBe(201);
    expect(seen).toEqual([PRODUCT]);
    expect(JSON.parse(response.body)).toMatchObject({
      sku: 'SKU-NEW',
      priceMinor: '1250',
      isActive: true,
    });
  });

  it('refuses a JSON number for money before the authority sees it', async () => {
    const server = await build('owner');
    const cookie = await cookieFor(server);
    expect((await send(cookie, { ...PRODUCT, priceMinor: 12.5 })).statusCode).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('names fields that try to assert tenant, activation or inventory authority', async () => {
    const server = await build('owner');
    const cookie = await cookieFor(server);
    for (const field of ['tenantId', 'userId', 'isActive', 'trackInventory', 'quantityScaled']) {
      const response = await send(cookie, { ...PRODUCT, [field]: 'anything' });
      expect(response.statusCode, field).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: 'forbidden_field', field });
    }
    expect(seen).toHaveLength(0);
  });

  it('maps authority conflicts to deterministic merchant responses', async () => {
    const server = await build('owner');
    const cookie = await cookieFor(server);
    answer = { outcome: 'failure', reason: 'sku-taken' };
    const response = await send(cookie, PRODUCT);
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ error: 'sku_taken' });
  });
});
