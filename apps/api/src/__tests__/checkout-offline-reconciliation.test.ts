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

const FIXTURE: Fixture = {
  tenant: '018f6100-0000-7000-8000-00000000000a',
  branch: '018f6100-0000-7000-8000-0000000000a1',
  terminal: '018f6100-0000-7000-8000-0000000000a2',
  shift: '018f6100-0000-7000-8000-0000000000a3',
  user: '018f6100-0000-7000-8000-0000000000a4',
  milk: '018f6100-0000-7000-8000-0000000000a5',
  rice: '018f6100-0000-7000-8000-0000000000a6',
};

const OPERATION_ID = '018f6100-0001-7000-8000-000000000001';
const OTHER_SHIFT_ID = '018f6100-0000-7000-8000-0000000000b3';

let store: MemoryBusinessStore;
let service: CheckoutService;
let nextId = 0;

function principal(): AuthenticatedPrincipal {
  return {
    tenantId: FIXTURE.tenant,
    tenantSlug: 'offline-proof',
    userId: FIXTURE.user,
    sessionId: '018f6100-0000-7000-8000-0000000000e1',
    email: 'cashier@offline-proof.test',
    displayName: 'سارة',
    roles: ['cashier'],
    permissions: [...ROLE_PERMISSIONS.cashier],
    maxDiscountBasisPoints: 0n,
    branchId: FIXTURE.branch,
  };
}

beforeEach(() => {
  store = new MemoryBusinessStore();
  seedStore(store, FIXTURE);
  nextId = 0;
  service = createCheckoutService({
    tenants: memoryTenantRepository(store),
    products: memoryProductRepository(store),
    inventory: memoryInventoryRepository(store),
    shifts: memoryShiftRepository(store),
    sales: memorySaleRepository(store),
    idempotency: memoryIdempotencyRepository(store),
    audit: memoryAuditRepository(store),
    now: () => new Date('2026-09-12T09:00:00.000Z'),
    newId: () => {
      nextId += 1;
      return `018f6100-0002-7000-8000-${String(nextId).padStart(12, '0')}`;
    },
  });
});

function checkout(expectedShiftId = FIXTURE.shift) {
  return service.checkout({
    principal: principal(),
    operationId: OPERATION_ID,
    terminalId: FIXTURE.terminal,
    expectedShiftId,
    cashReceivedMinor: '5000',
    lines: [{ productId: FIXTURE.milk, quantityScaled: '1000' }],
  });
}

describe('offline checkout reconciliation shift boundary', () => {
  it('refuses to move delayed cash into another shift on the same terminal', async () => {
    const result = await checkout(OTHER_SHIFT_ID);
    expect(result.outcome === 'failure' && result.reason).toBe('shift-invalid');
    expect(store.sales).toHaveLength(0);
    expect(store.movements).toHaveLength(0);
  });

  it('replays a committed operation after its original shift has closed', async () => {
    const first = await checkout();
    if (first.outcome !== 'success') throw new Error(first.reason);

    store.shifts[0] = { ...store.shifts[0]!, status: 'closed' };
    const replay = await checkout();
    if (replay.outcome !== 'success') throw new Error(replay.reason);

    expect(replay.replayed).toBe(true);
    expect(replay.sale.saleId).toBe(first.sale.saleId);
    expect(replay.sale.shiftId).toBe(FIXTURE.shift);
    expect(store.sales).toHaveLength(1);
    expect(store.movements).toHaveLength(1);
  });

  it('does not let the same operation id be reinterpreted under another shift', async () => {
    const first = await checkout();
    if (first.outcome !== 'success') throw new Error(first.reason);

    const changed = await checkout(OTHER_SHIFT_ID);
    expect(changed.outcome === 'failure' && changed.reason).toBe('idempotency-conflict');
    expect(store.sales).toHaveLength(1);
    expect(store.movements).toHaveLength(1);
  });
});
