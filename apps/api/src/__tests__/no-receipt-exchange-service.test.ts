import { beforeEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, basisPoints, tenantId } from '@korvi/domain';
import { createNoReceiptExchangeService } from '../no-receipt-exchange/service.js';
import type {
  AuthenticatedPrincipal,
  InvoiceRecord,
  NoReceiptExchangeRecord,
  NoReceiptExchangeRepository,
  Product,
  ProductRepository,
  RecordNoReceiptExchangeInput,
  SaleRecord,
  SaleRepository,
  ShiftRecord,
  ShiftRepository,
  TenantRepository,
} from '@korvi/domain';

const TENANT = '018f7100-0000-7000-8000-000000000001';
const BRANCH = '018f7100-0000-7000-8000-000000000002';
const TERMINAL = '018f7100-0000-7000-8000-000000000003';
const SHIFT = '018f7100-0000-7000-8000-000000000004';
const USER = '018f7100-0000-7000-8000-000000000005';
const MILK = '018f7100-0000-7000-8000-000000000006';
const RICE = '018f7100-0000-7000-8000-000000000007';
const OPERATION = '018f7100-0000-7000-8000-000000000008';

const products: readonly Product[] = [
  {
    id: MILK,
    tenantId: tenantId(TENANT),
    categoryId: null,
    sku: 'MILK',
    nameAr: 'حليب',
    nameEn: 'Milk',
    productType: 'unit',
    unitLabel: 'حبة',
    priceMinor: '1150',
    vatBasisPoints: basisPoints(1500),
    primaryBarcode: null,
    barcodes: [],
    trackInventory: true,
    isActive: true,
  },
  {
    id: RICE,
    tenantId: tenantId(TENANT),
    categoryId: null,
    sku: 'RICE',
    nameAr: 'أرز',
    nameEn: 'Rice',
    productType: 'unit',
    unitLabel: 'حبة',
    priceMinor: '3000',
    vatBasisPoints: basisPoints(1500),
    primaryBarcode: null,
    barcodes: [],
    trackInventory: true,
    isActive: true,
  },
];

function principal(role: 'cashier' | 'manager' = 'manager'): AuthenticatedPrincipal {
  return {
    tenantId: TENANT,
    tenantSlug: 'korvi',
    userId: USER,
    sessionId: '018f7100-0000-7000-8000-000000000009',
    email: 'manager@korvi.test',
    displayName: 'مدير',
    roles: [role],
    permissions: [...ROLE_PERMISSIONS[role]],
    maxDiscountBasisPoints: 0n,
    branchId: BRANCH,
  };
}

function shift(): ShiftRecord {
  return {
    id: SHIFT,
    tenantId: tenantId(TENANT),
    branchId: BRANCH,
    terminalId: TERMINAL,
    userId: USER,
    status: 'open',
    openingFloatMinor: '0',
    declaredCashMinor: null,
    expectedCashMinor: null,
    varianceMinor: null,
    closedByUserId: null,
    openedAt: '2026-09-24T10:00:00.000Z',
    closedAt: null,
    reconciliation: null,
    movements: [],
  };
}

let recorded: RecordNoReceiptExchangeInput | null;
let existing: NoReceiptExchangeRecord | null;
let storedSale: SaleRecord | null;
let storedInvoice: InvoiceRecord | null;
let idCounter: number;

function nextId(): string {
  idCounter += 1;
  return '018f7100-0000-7000-8000-' + String(100 + idCounter).padStart(12, '0');
}

function buildSale(input: RecordNoReceiptExchangeInput): SaleRecord {
  const source = input.replacementSale.sale;
  return {
    ...source,
    tenantId: tenantId(TENANT),
    sequence: 7,
  };
}

function buildInvoice(input: RecordNoReceiptExchangeInput): InvoiceRecord {
  return {
    ...input.replacementSale.invoice,
    tenantId: tenantId(TENANT),
    invoiceNumber: '01-000007',
  };
}

function service() {
  const tenants = {
    current: async () => ({
      id: tenantId(TENANT),
      name: 'Korvi',
      slug: 'korvi',
      vatNumber: '310000000000003',
    }),
    settings: async () => ({
      tenantId: tenantId(TENANT),
      vertical: 'retail' as const,
      priceMode: 'tax-inclusive' as const,
      defaultVatBasisPoints: basisPoints(1500),
      currency: 'SAR',
      requireBarcode: false,
      allowWeightedItems: true,
      trackInventory: true,
      allowNegativeStock: false,
      enableProductImages: false,
      receiptHeaderAr: null,
      receiptFooterAr: null,
    }),
  } satisfies TenantRepository;

  const productRepository = {
    findById: async (_scope: unknown, id: string) =>
      products.find((product) => product.id === id) ?? null,
    search: async () => [],
    findBySku: async () => null,
    findByBarcode: async () => null,
    list: async () => products,
  } as ProductRepository;

  const shifts = {
    findOpenForTerminal: async () => shift(),
  } as ShiftRepository;

  const sales = {
    findById: async () => storedSale,
    invoiceForSale: async () => storedInvoice,
  } as SaleRepository;

  const exchanges: NoReceiptExchangeRepository = {
    findByOperationId: async () => existing,
    record: async (_scope, input) => {
      recorded = input;
      storedSale = buildSale(input);
      storedInvoice = buildInvoice(input);
      existing = {
        ...input.exchange,
        tenantId: tenantId(TENANT),
        sequence: 1,
        caseNumber: 'NR-01-000001',
        linkedSaleId: input.replacementSale.sale.id,
        lines: input.lines,
      };
      return existing;
    },
  };

  return createNoReceiptExchangeService({
    tenants,
    products: productRepository,
    shifts,
    sales,
    exchanges,
    now: () => new Date('2026-09-24T12:00:00.000Z'),
    newId: nextId,
  });
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    principal: principal(),
    operationId: OPERATION,
    terminalId: TERMINAL,
    expectedShiftId: SHIFT,
    reason: 'customer-no-receipt' as const,
    approvedAllowanceMinor: '1000',
    acceptedLines: [{ productId: MILK, quantityScaled: '1000' }],
    replacementLines: [{ productId: RICE, quantityScaled: '1000' }],
    tenders: [{ kind: 'cash' as const, amountMinor: '2000' }],
    ...overrides,
  };
}

beforeEach(() => {
  recorded = null;
  existing = null;
  storedSale = null;
  storedInvoice = null;
  idCounter = 0;
});

describe('V2-1 no-receipt exchange service', () => {
  it('refuses a cashier even if the service is called without the route guard', async () => {
    const result = await service().create(request({ principal: principal('cashier') }));
    expect(result).toEqual({ outcome: 'failure', reason: 'permission-denied' });
    expect(recorded).toBeNull();
  });

  it('uses current policy value without inventing original-sale facts', async () => {
    const result = await service().create(request());
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;

    expect(result.case.referenceCeilingMinor).toBe('1150');
    expect(result.case.approvedAllowanceMinor).toBe('1000');
    expect(result.case.reason).toBe('customer-no-receipt');
    expect(recorded?.replacementSale.sale.tenders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'exchange_allowance',
          amountMinor: '1000',
          changeMinor: '0',
          scheme: null,
          reference: null,
        }),
      ]),
    );
    expect(recorded?.intake).toHaveLength(1);
    expect(recorded?.intake[0]?.movement.kind).toBe('no-receipt-exchange-intake');
    expect(recorded?.intake[0]?.movement.quantityScaled).toBe('1000');
    expect(recorded?.replacementSale.cashMovement?.amountMinor).toBe('2000');
    expect(recorded?.audits.map((event) => event.eventType).sort()).toEqual([
      'no-receipt-exchange.completed',
      'sale.completed',
    ]);
  });

  it('refuses allowance above the server-computed current reference ceiling', async () => {
    const result = await service().create(request({ approvedAllowanceMinor: '1151' }));
    expect(result.outcome === 'failure' && result.reason).toBe('invalid-allowance');
    expect(recorded).toBeNull();
  });

  it('refuses a replacement sale below the approved allowance instead of creating residual credit', async () => {
    const result = await service().create(
      request({
        approvedAllowanceMinor: '1150',
        replacementLines: [{ productId: MILK, quantityScaled: '1000' }],
        tenders: [],
      }),
    );
    expect(result.outcome).toBe('success');

    const refused = await service().create(
      request({
        operationId: '018f7100-0000-7000-8000-000000000088',
        approvedAllowanceMinor: '2000',
        replacementLines: [{ productId: MILK, quantityScaled: '1000' }],
        acceptedLines: [{ productId: RICE, quantityScaled: '1000' }],
        tenders: [],
      }),
    );
    expect(refused.outcome === 'failure' && refused.reason).toBe('replacement-below-allowance');
  });

  it('replays the same operation and refuses a different intent under the same id', async () => {
    const first = await service().create(request());
    expect(first.outcome).toBe('success');
    const captured = recorded;

    const replayed = await service().create(request());
    expect(replayed.outcome).toBe('success');
    if (replayed.outcome !== 'success') return;
    expect(replayed.replayed).toBe(true);
    expect(recorded).toBe(captured);

    const conflict = await service().create(request({ approvedAllowanceMinor: '900' }));
    expect(conflict.outcome === 'failure' && conflict.reason).toBe('idempotency-conflict');
  });

  it('never creates a cash payout or persistent customer balance', async () => {
    const result = await service().create(
      request({
        approvedAllowanceMinor: '3000',
        acceptedLines: [{ productId: RICE, quantityScaled: '1000' }],
        replacementLines: [{ productId: RICE, quantityScaled: '1000' }],
        tenders: [],
      }),
    );
    expect(result.outcome).toBe('success');
    expect(recorded?.replacementSale.cashMovement).toBeNull();
    expect(JSON.stringify(recorded)).not.toContain('refund');
    expect(JSON.stringify(recorded)).not.toContain('storeCredit');
  });
});
