import { beforeEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@korvi/domain';
import { createCheckoutService } from '../checkout/service.js';
import {
  MemoryBusinessStore,
  memoryAuditRepository,
  memoryIdempotencyRepository,
  memoryInventoryRepository,
  memoryProductRepository,
  memorySaleRepository,
  memoryShiftRepository,
  memoryTenantRepository,
  seedStore,
} from './support/memory-business.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { CheckoutService } from '../checkout/service.js';
import type { Fixture } from './support/memory-business.js';

const A: Fixture = {
  tenant: '018f3100-0000-7000-8000-00000000000a',
  branch: '018f3100-0000-7000-8000-0000000000a1',
  terminal: '018f3100-0000-7000-8000-0000000000a2',
  shift: '018f3100-0000-7000-8000-0000000000a3',
  user: '018f3100-0000-7000-8000-0000000000a4',
  milk: '018f3100-0000-7000-8000-0000000000a5',
  rice: '018f3100-0000-7000-8000-0000000000a6',
};
const OPERATION = '018f3100-0000-7000-8000-0000000000f1';

let store: MemoryBusinessStore;
let service: CheckoutService;
let counter = 0;

function principal(): AuthenticatedPrincipal {
  return {
    tenantId: A.tenant,
    tenantSlug: 'restaurant',
    userId: A.user,
    sessionId: '018f3100-0000-7000-8000-0000000000e1',
    email: 'cashier@korvi.test',
    displayName: 'كاشير',
    roles: ['cashier'],
    permissions: [...ROLE_PERMISSIONS.cashier],
    maxDiscountBasisPoints: 0n,
    branchId: A.branch,
  };
}

beforeEach(() => {
  store = new MemoryBusinessStore();
  seedStore(store, A);
  counter = 0;
  service = createCheckoutService({
    tenants: memoryTenantRepository(store),
    products: memoryProductRepository(store),
    inventory: memoryInventoryRepository(store),
    shifts: memoryShiftRepository(store),
    sales: memorySaleRepository(store),
    idempotency: memoryIdempotencyRepository(store),
    audit: memoryAuditRepository(store),
    now: () => new Date('2026-09-19T00:00:00.000Z'),
    newId: () => {
      counter += 1;
      return `018f3100-0000-7000-8000-${String(counter).padStart(12, '0')}`;
    },
  });
});

function checkout(overrides: Partial<Parameters<CheckoutService['checkout']>[0]> = {}) {
  return service.checkout({
    principal: principal(),
    operationId: OPERATION,
    terminalId: A.terminal,
    cashReceivedMinor: '5000',
    lines: [{ productId: A.milk, quantityScaled: '1000' }],
    ...overrides,
  });
}

describe('restaurant order context authority', () => {
  it('requires an explicit service mode for restaurant tenants', async () => {
    store.settings[0] = { ...store.settings[0]!, vertical: 'restaurant' };
    await expect(checkout()).resolves.toMatchObject({
      outcome: 'failure',
      reason: 'order-type-required',
    });
    expect(store.sales).toHaveLength(0);
  });

  it('persists and echoes the recorded mode without changing fiscal math', async () => {
    store.settings[0] = { ...store.settings[0]!, vertical: 'restaurant' };
    const result = await checkout({ orderType: 'dine-in' });
    expect(result).toMatchObject({
      outcome: 'success',
      sale: { orderType: 'dine-in', totalMinor: '1150', vatMinor: '150' },
    });
    expect(store.sales[0]?.orderType).toBe('dine-in');
    expect(
      store.audit.find((event) => event.eventType === 'sale.completed')?.metadata,
    ).toMatchObject({ orderType: 'dine-in' });
  });

  it('refuses restaurant service metadata for non-restaurant tenants', async () => {
    await expect(checkout({ orderType: 'delivery' })).resolves.toMatchObject({
      outcome: 'failure',
      reason: 'order-type-not-applicable',
    });
    expect(store.sales).toHaveLength(0);
  });

  it('binds order type into the idempotent checkout intent', async () => {
    store.settings[0] = { ...store.settings[0]!, vertical: 'restaurant' };
    expect((await checkout({ orderType: 'takeaway' })).outcome).toBe('success');
    await expect(checkout({ orderType: 'dine-in' })).resolves.toMatchObject({
      outcome: 'failure',
      reason: 'idempotency-conflict',
    });
    expect(store.sales).toHaveLength(1);
    expect(store.sales[0]?.orderType).toBe('takeaway');
  });
});
