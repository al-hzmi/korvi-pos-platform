import { basisPoints, tenantId as brandTenantId } from '@korvi/domain';
import {
  InsufficientStockError,
  OperationAlreadyRecordedError,
  ShiftOpenRefusedError,
  ShiftUnusableError,
} from '@korvi/database';
import type {
  AuditEventInput,
  AuditRepository,
  IdempotencyRecord,
  IdempotencyReservation,
  IdempotencyRepository,
  InventoryBalance,
  InventoryMovementInput,
  InventoryRepository,
  OpenShiftInput,
  Product,
  ProductRepository,
  ProductSearchQuery,
  RecordSaleInput,
  SaleRecord,
  SaleRepository,
  ShiftRecord,
  ShiftRepository,
  Tenant,
  TenantRepository,
  TenantScope,
  TenantSettings,
  Terminal,
  TerminalRepository,
  InvoiceRecord,
} from '@korvi/domain';

/**
 * The cashier's persistence, in memory.
 *
 * It mirrors the two properties of the real adapters that the checkout pipeline
 * depends on and that a looser fake would quietly hide: every read is filtered
 * by the scope's tenant, and `record` is all-or-nothing. A fake that ignored
 * either would make the isolation and atomicity tests pass for the wrong reason.
 *
 * The receipt number is allocated inside `record`, exactly as the adapter does
 * it, because the pipeline is not allowed to supply one.
 */

export interface MemoryProduct extends Product {
  branchStock: Record<string, string>;
}

export class MemoryBusinessStore {
  public tenants: Tenant[] = [];
  public settings: TenantSettings[] = [];
  public terminals: Terminal[] = [];
  public shifts: ShiftRecord[] = [];
  public products: MemoryProduct[] = [];
  public sales: SaleRecord[] = [];
  public invoices: InvoiceRecord[] = [];
  public movements: (InventoryMovementInput & { tenantId: string })[] = [];
  public keys: IdempotencyRecord[] = [];
  /** Drawer effects, so a test can prove what a split payment did to the till. */
  public cashMovements: { kind: string; amountMinor: string; shiftId: string }[] = [];
  public audit: AuditEventInput[] = [];
  /** Opening-float movement ids, so a test can prove none was written. */
  public openingMovements: string[] = [];
  /** Set to make the persisting transaction fail after it has begun. */
  public recordFails = false;
}

function scopeId(scope: TenantScope): string {
  return scope.tenantId as string;
}

export function memoryTenantRepository(store: MemoryBusinessStore): TenantRepository {
  return {
    current: (scope) =>
      Promise.resolve(store.tenants.find((t) => (t.id as string) === scopeId(scope)) ?? null),
    settings: (scope) =>
      Promise.resolve(
        store.settings.find((s) => (s.tenantId as string) === scopeId(scope)) ?? null,
      ),
  };
}

export function memoryTerminalRepository(store: MemoryBusinessStore): TerminalRepository {
  const mine = (scope: TenantScope): Terminal[] =>
    store.terminals.filter((t) => (t.tenantId as string) === scopeId(scope));
  return {
    findById: (scope, id) => Promise.resolve(mine(scope).find((t) => t.id === id) ?? null),
    findByCode: (scope, code) => Promise.resolve(mine(scope).find((t) => t.code === code) ?? null),
    listForBranch: (scope, branchId) =>
      Promise.resolve(mine(scope).filter((t) => t.branchId === branchId)),
    markSeen: () => Promise.resolve(),
  };
}

export function memoryProductRepository(store: MemoryBusinessStore): ProductRepository {
  const mine = (scope: TenantScope): MemoryProduct[] =>
    store.products.filter((p) => (p.tenantId as string) === scopeId(scope));
  return {
    findById: (scope, id) => Promise.resolve(mine(scope).find((p) => p.id === id) ?? null),
    findBySku: (scope, sku) => Promise.resolve(mine(scope).find((p) => p.sku === sku) ?? null),
    findByBarcode: (scope, barcode) =>
      Promise.resolve(mine(scope).find((p) => p.barcodes.includes(barcode)) ?? null),
    search: (scope, query: ProductSearchQuery) => {
      const term = query.term.trim();
      const exact = mine(scope).find(
        (p) => p.isActive && (p.sku === term || p.barcodes.includes(term)),
      );
      if (/^[0-9]{6,14}$/.test(term) && exact !== undefined) return Promise.resolve([exact]);
      return Promise.resolve(
        mine(scope)
          .filter(
            (p) =>
              p.isActive &&
              (p.nameAr.startsWith(term) ||
                (p.nameEn ?? '').toLowerCase().startsWith(term.toLowerCase()) ||
                p.sku.toLowerCase().startsWith(term.toLowerCase()) ||
                p.barcodes.some((code) => code.startsWith(term))),
          )
          .slice(0, query.limit),
      );
    },
    list: (scope, limit) => Promise.resolve(mine(scope).slice(0, limit)),
  };
}

export function memoryInventoryRepository(store: MemoryBusinessStore): InventoryRepository {
  return {
    balance: (scope, branchId, productId) => {
      const product = store.products.find(
        (p) => (p.tenantId as string) === scopeId(scope) && p.id === productId,
      );
      const scaled = product?.branchStock[branchId];
      return Promise.resolve(
        scaled === undefined
          ? null
          : ({
              tenantId: brandTenantId(scopeId(scope)),
              branchId,
              productId,
              quantityScaled: scaled,
            } satisfies InventoryBalance),
      );
    },
    listBalances: () => Promise.resolve([]),
    applyMovement: (scope, movement) => {
      store.movements.push({ ...movement, tenantId: scopeId(scope) });
      return Promise.resolve({
        tenantId: brandTenantId(scopeId(scope)),
        branchId: movement.branchId,
        productId: movement.productId,
        quantityScaled: movement.quantityScaled,
      });
    },
  };
}

export function memoryShiftRepository(store: MemoryBusinessStore): ShiftRepository {
  const mine = (scope: TenantScope): ShiftRecord[] =>
    store.shifts.filter((s) => (s.tenantId as string) === scopeId(scope));
  return {
    findById: (scope, id) => Promise.resolve(mine(scope).find((s) => s.id === id) ?? null),
    findOpenForTerminal: (scope, terminalId) =>
      Promise.resolve(
        mine(scope).find((s) => s.terminalId === terminalId && s.status === 'open') ?? null,
      ),
    open: (scope, input: OpenShiftInput) => {
      const terminal = store.terminals.find(
        (t) => (t.tenantId as string) === scopeId(scope) && t.id === input.terminalId,
      );
      if (terminal === undefined || !terminal.isActive) {
        return Promise.reject(new ShiftOpenRefusedError('unknown-terminal'));
      }
      if (mine(scope).some((s) => s.terminalId === input.terminalId && s.status === 'open')) {
        return Promise.reject(new ShiftOpenRefusedError('already-open'));
      }
      const shift: ShiftRecord = {
        id: input.id,
        tenantId: brandTenantId(scopeId(scope)),
        branchId: input.branchId,
        terminalId: input.terminalId,
        userId: input.userId,
        status: 'open',
        openingFloatMinor: input.openingFloatMinor,
        declaredCashMinor: null,
        expectedCashMinor: null,
        varianceMinor: null,
        openedAt: input.openedAt,
        closedAt: null,
        movements: [],
      };
      store.shifts.push(shift);
      store.openingMovements.push(input.openingMovementId);
      return Promise.resolve(shift);
    },
    recordCashMovement: () => Promise.resolve(),
    close: (scope, input) => {
      const shift = mine(scope).find((s) => s.id === input.shiftId);
      if (shift === undefined) throw new Error('no such shift');
      return Promise.resolve({ ...shift, status: 'closed' });
    },
  };
}

export function memorySaleRepository(store: MemoryBusinessStore): SaleRepository {
  const mine = (scope: TenantScope): SaleRecord[] =>
    store.sales.filter((s) => (s.tenantId as string) === scopeId(scope));

  return {
    findById: (scope, id) => Promise.resolve(mine(scope).find((s) => s.id === id) ?? null),
    findByOperationId: (scope, operationId) =>
      Promise.resolve(mine(scope).find((s) => s.operationId === operationId) ?? null),
    invoiceForSale: (scope, saleId) =>
      Promise.resolve(
        store.invoices.find(
          (i) => (i.tenantId as string) === scopeId(scope) && i.saleId === saleId,
        ) ?? null,
      ),
    record: (scope, input: RecordSaleInput) => {
      // All or nothing, like the transaction it stands in for. Everything is
      // staged and only appended once every step has succeeded, and the three
      // guards the real transaction holds are checked in the same order.
      if (store.recordFails) return Promise.reject(new Error('persistence failed'));

      const tenant = scopeId(scope);

      const shift = store.shifts.find(
        (s) => (s.tenantId as string) === tenant && s.id === input.sale.shiftId,
      );
      if (shift === undefined) return Promise.reject(new ShiftUnusableError('unknown-shift'));
      if (shift.status !== 'open') return Promise.reject(new ShiftUnusableError('shift-closed'));
      if (shift.terminalId !== input.sale.terminalId) {
        return Promise.reject(new ShiftUnusableError('terminal-mismatch'));
      }
      if (shift.branchId !== input.sale.branchId) {
        return Promise.reject(new ShiftUnusableError('branch-mismatch'));
      }
      if (shift.userId !== input.sale.userId) {
        return Promise.reject(new ShiftUnusableError('cashier-mismatch'));
      }

      const allowNegativeStock =
        store.settings.find((s) => (s.tenantId as string) === tenant)?.allowNegativeStock ?? false;
      if (!allowNegativeStock) {
        // The guard lives here, with the write, exactly as the guarded UPDATE
        // does. A fake that checked earlier would hide the race it stands for.
        for (const movement of input.inventory) {
          const product = store.products.find((prod) => prod.id === movement.productId);
          const held = product?.branchStock[movement.branchId];
          if (held === undefined) continue;
          if (BigInt(held) + BigInt(movement.quantityScaled) < 0n) {
            return Promise.reject(new InsufficientStockError('would go below zero'));
          }
        }
      }
      const branchSales = store.sales.filter(
        (s) => (s.tenantId as string) === tenant && s.branchId === input.sale.branchId,
      );
      const sequence = branchSales.reduce((max, s) => Math.max(max, s.sequence), 0) + 1;
      const invoiceNumber = `01-${String(sequence).padStart(6, '0')}`;

      if (
        store.keys.some(
          (k) =>
            (k.tenantId as string) === tenant &&
            k.scope === input.idempotency.scope &&
            k.operationId === input.idempotency.operationId,
        )
      ) {
        // What ON CONFLICT DO NOTHING reports once the competitor has
        // committed: a defined outcome, not a raw constraint violation.
        return Promise.reject(new OperationAlreadyRecordedError(input.idempotency.operationId));
      }

      const sale: SaleRecord = {
        ...input.sale,
        tenantId: brandTenantId(tenant),
        sequence,
      };
      const invoice: InvoiceRecord = {
        ...input.invoice,
        tenantId: brandTenantId(tenant),
        invoiceNumber,
      };

      store.sales.push(sale);
      if (input.cashMovement !== null) {
        store.cashMovements.push({
          kind: input.cashMovement.kind,
          amountMinor: input.cashMovement.amountMinor,
          shiftId: input.cashMovement.shiftId,
        });
      }
      store.invoices.push(invoice);
      for (const movement of input.inventory) {
        store.movements.push({ ...movement, tenantId: tenant });
        const product = store.products.find((p) => p.id === movement.productId);
        const held = product?.branchStock[movement.branchId];
        if (product !== undefined && held !== undefined) {
          product.branchStock[movement.branchId] = (
            BigInt(held) + BigInt(movement.quantityScaled)
          ).toString();
        }
      }
      store.keys.push({
        id: input.idempotency.id,
        tenantId: brandTenantId(tenant),
        scope: input.idempotency.scope,
        operationId: input.idempotency.operationId,
        status: 'completed',
        resultType: 'sale',
        resultId: sale.id,
        requestHash: input.idempotency.requestHash,
        completedAt: input.sale.issuedAt,
      });
      return Promise.resolve(sale);
    },
  };
}

export function memoryIdempotencyRepository(store: MemoryBusinessStore): IdempotencyRepository {
  return {
    find: (scope, scopeKey, operationId) =>
      Promise.resolve(
        store.keys.find(
          (k) =>
            (k.tenantId as string) === scopeId(scope) &&
            k.scope === scopeKey &&
            k.operationId === operationId,
        ) ?? null,
      ),
    reserve: (scope, reservation: IdempotencyReservation) => {
      const record: IdempotencyRecord = {
        ...reservation,
        tenantId: brandTenantId(scopeId(scope)),
        status: 'reserved',
        resultType: null,
        resultId: null,
        completedAt: null,
      };
      store.keys.push(record);
      return Promise.resolve(record);
    },
    complete: () => Promise.resolve(),
  };
}

export function memoryAuditRepository(store: MemoryBusinessStore): AuditRepository {
  return {
    append: (_scope, event) => {
      store.audit.push(event);
      return Promise.resolve();
    },
    list: () => Promise.resolve(store.audit),
  };
}

/** A tenant, a till, an open shift and two products — the minimum for a sale. */
export interface Fixture {
  readonly tenant: string;
  readonly branch: string;
  readonly terminal: string;
  readonly shift: string;
  readonly user: string;
  readonly milk: string;
  readonly rice: string;
}

export function seedStore(store: MemoryBusinessStore, f: Fixture, openShift = true): void {
  store.tenants.push({
    id: brandTenantId(f.tenant),
    slug: `t-${f.tenant.slice(-4)}`,
    name: 'متجر كورفي',
    status: 'active',
    vatNumber: '300000000000003',
  });
  store.settings.push({
    tenantId: brandTenantId(f.tenant),
    vertical: 'retail',
    priceMode: 'tax-inclusive',
    defaultVatBasisPoints: basisPoints(1500),
    currency: 'SAR',
    requireBarcode: true,
    allowWeightedItems: true,
    trackInventory: true,
    allowNegativeStock: false,
    receiptHeaderAr: null,
    receiptFooterAr: null,
  });
  store.terminals.push({
    id: f.terminal,
    tenantId: brandTenantId(f.tenant),
    branchId: f.branch,
    code: '01',
    label: 'صندوق ١',
    isActive: true,
    lastSeenAt: null,
  });
  if (openShift) {
    store.shifts.push({
      id: f.shift,
      tenantId: brandTenantId(f.tenant),
      branchId: f.branch,
      terminalId: f.terminal,
      userId: f.user,
      status: 'open',
      openingFloatMinor: '20000',
      declaredCashMinor: null,
      expectedCashMinor: null,
      varianceMinor: null,
      openedAt: '2026-08-12T06:00:00.000Z',
      closedAt: null,
      movements: [],
    });
  }
  store.products.push(
    {
      id: f.milk,
      tenantId: brandTenantId(f.tenant),
      categoryId: null,
      sku: 'MILK-1L',
      nameAr: 'حليب طازج',
      nameEn: 'Fresh milk',
      productType: 'unit',
      unitLabel: 'each',
      priceMinor: '1150',
      vatBasisPoints: basisPoints(1500),
      primaryBarcode: '6281000000001',
      barcodes: ['6281000000001'],
      trackInventory: true,
      isActive: true,
      branchStock: { [f.branch]: '10000' },
    },
    {
      id: f.rice,
      tenantId: brandTenantId(f.tenant),
      categoryId: null,
      sku: 'RICE-5K',
      nameAr: 'أرز بسمتي',
      nameEn: 'Basmati rice',
      productType: 'weighted',
      unitLabel: 'kg',
      priceMinor: '2400',
      vatBasisPoints: basisPoints(1500),
      primaryBarcode: '6281000000002',
      barcodes: ['6281000000002'],
      trackInventory: true,
      isActive: true,
      branchStock: { [f.branch]: '5000' },
    },
  );
}
