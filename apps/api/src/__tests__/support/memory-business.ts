import { basisPoints, tenantId as brandTenantId } from '@korvi/domain';
import { reconcileDrawer } from '@korvi/domain';
import {
  DrawerRefusedError,
  InsufficientStockError,
  OperationAlreadyRecordedError,
  ReturnNotAllowedError,
  ShiftOpenRefusedError,
  ShiftUnusableError,
} from '@korvi/database';
import type {
  AuditEventInput,
  AuditRepository,
  CashMovementRecord,
  CloseShiftRequest,
  DrawerMovement,
  ManualCashMovementInput,
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
  RecordReturnInput,
  RecordSaleInput,
  ReturnRecord,
  ReturnRepository,
  ReturnableSale,
  ReturnableSaleLine,
  SaleLookupQuery,
  SaleLookupRow,
  SaleRecord,
  SaleRepository,
  ShiftRecord,
  ShiftRepository,
  Tenant,
  DashboardRepository,
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
  public returns: ReturnRecord[] = [];
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

/**
 * The dashboard, counted from the same store the rest of these fakes use.
 *
 * Deliberately derived rather than stubbed: a test that asserts a hardcoded
 * total proves the assertion, not the aggregate.
 */
export function memoryDashboardRepository(store: MemoryBusinessStore): DashboardRepository {
  return {
    summary: (scope, since) => {
      const tenant = scopeId(scope);
      const from = Date.parse(since);
      const sales = store.sales.filter(
        (sale) =>
          (sale.tenantId as string) === tenant &&
          sale.status === 'finalized' &&
          Date.parse(sale.issuedAt) >= from,
      );
      const sum = (pick: (sale: (typeof sales)[number]) => string): string =>
        sales.reduce((total, sale) => total + BigInt(pick(sale)), 0n).toString();

      return Promise.resolve({
        activeProductCount: store.products.filter(
          (product) => (product.tenantId as string) === tenant && product.isActive,
        ).length,
        terminalCount: store.terminals.filter(
          (terminal) => (terminal.tenantId as string) === tenant && terminal.isActive,
        ).length,
        openShiftCount: store.shifts.filter(
          (shift) => (shift.tenantId as string) === tenant && shift.status === 'open',
        ).length,
        salesLast24HoursCount: sales.length,
        grossSalesLast24HoursMinor: sum((sale) => sale.totalMinor),
        vatLast24HoursMinor: sum((sale) => sale.vatMinor),
        currency:
          store.settings.find((entry) => (entry.tenantId as string) === tenant)?.currency ?? 'SAR',
        since,
      });
    },
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

/** Replace a shift in place, so a caller holding the array sees the change. */
function replaceShift(
  store: MemoryBusinessStore,
  shift: ShiftRecord,
  changes: Partial<ShiftRecord>,
): void {
  store.shifts[store.shifts.indexOf(shift)] = { ...shift, ...changes };
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
        closedByUserId: null,
        openedAt: input.openedAt,
        closedAt: null,
        reconciliation: null,
        movements: [],
      };
      store.shifts.push(shift);
      store.openingMovements.push(input.openingMovementId);
      return Promise.resolve(shift);
    },
    findMovementById: (scope, id) =>
      Promise.resolve(
        mine(scope)
          .flatMap((shift) => shift.movements)
          .find((movement) => movement.id === id) ?? null,
      ),

    recordManualMovement: (scope: TenantScope, input: ManualCashMovementInput) => {
      const shift = mine(scope).find((s) => s.id === input.shiftId);
      if (shift === undefined) return Promise.reject(new DrawerRefusedError('unknown-shift'));
      // Addressability before state, exactly as the adapter does it.
      if (shift.branchId !== input.branchId) {
        return Promise.reject(new DrawerRefusedError('branch-mismatch'));
      }
      if (shift.terminalId !== input.terminalId) {
        return Promise.reject(new DrawerRefusedError('terminal-mismatch'));
      }
      if (shift.status !== 'open') return Promise.reject(new DrawerRefusedError('shift-closed'));
      if (
        store.keys.some(
          (key) =>
            (key.tenantId as string) === scopeId(scope) &&
            key.scope === input.idempotency.scope &&
            key.operationId === input.idempotency.operationId,
        )
      ) {
        return Promise.reject(new OperationAlreadyRecordedError(input.idempotency.operationId));
      }

      const movement: CashMovementRecord = {
        id: input.id,
        shiftId: input.shiftId,
        kind: input.kind,
        amountMinor: input.amountMinor,
        reason: input.reason,
        actorUserId: input.actorUserId,
        occurredAt: input.occurredAt,
      };
      replaceShift(store, shift, { movements: [...shift.movements, movement] });
      store.keys.push({
        id: input.idempotency.id,
        tenantId: brandTenantId(scopeId(scope)),
        scope: input.idempotency.scope,
        operationId: input.idempotency.operationId,
        status: 'completed',
        resultType: 'cash-movement',
        resultId: input.id,
        requestHash: input.idempotency.requestHash,
        completedAt: input.occurredAt,
      });
      store.cashMovements.push({
        kind: input.kind,
        amountMinor: input.amountMinor,
        shiftId: input.shiftId,
      });
      return Promise.resolve(movement);
    },

    close: (scope: TenantScope, input: CloseShiftRequest) => {
      const shift = mine(scope).find((s) => s.id === input.shiftId);
      if (shift === undefined) return Promise.reject(new DrawerRefusedError('unknown-shift'));
      if (shift.branchId !== input.branchId) {
        return Promise.reject(new DrawerRefusedError('branch-mismatch'));
      }
      if (shift.terminalId !== input.terminalId) {
        return Promise.reject(new DrawerRefusedError('terminal-mismatch'));
      }
      if (shift.status !== 'open') return Promise.reject(new DrawerRefusedError('shift-closed'));
      if (shift.userId !== input.closedByUserId) {
        return Promise.reject(new DrawerRefusedError('not-owner'));
      }
      if (
        store.keys.some(
          (key) =>
            (key.tenantId as string) === scopeId(scope) &&
            key.scope === input.idempotency.scope &&
            key.operationId === input.idempotency.operationId,
        )
      ) {
        return Promise.reject(new OperationAlreadyRecordedError(input.idempotency.operationId));
      }

      // Derived here, exactly as the adapter derives it: a fake that returned
      // a stubbed expected figure would prove the assertion, not the equation.
      const reconciliation = reconcileDrawer(
        BigInt(shift.openingFloatMinor),
        shift.movements.map((movement): DrawerMovement => ({
          kind: movement.kind,
          amountMinor: BigInt(movement.amountMinor),
        })),
        BigInt(input.declaredCashMinor),
      );

      const closed: ShiftRecord = {
        ...shift,
        status: 'closed',
        declaredCashMinor: reconciliation.declaredCashMinor.toString(),
        expectedCashMinor: reconciliation.expectedCashMinor.toString(),
        varianceMinor: reconciliation.varianceMinor.toString(),
        closedByUserId: input.closedByUserId,
        closedAt: input.closedAt,
        reconciliation: {
          openingFloatMinor: reconciliation.openingFloatMinor.toString(),
          cashSalesMinor: reconciliation.cashSalesMinor.toString(),
          cashRefundsMinor: reconciliation.cashRefundsMinor.toString(),
          paidInMinor: reconciliation.paidInMinor.toString(),
          paidOutMinor: reconciliation.paidOutMinor.toString(),
          expectedCashMinor: reconciliation.expectedCashMinor.toString(),
          declaredCashMinor: reconciliation.declaredCashMinor.toString(),
          varianceMinor: reconciliation.varianceMinor.toString(),
        },
      };
      store.shifts[store.shifts.indexOf(shift)] = closed;
      store.keys.push({
        id: input.idempotency.id,
        tenantId: brandTenantId(scopeId(scope)),
        scope: input.idempotency.scope,
        operationId: input.idempotency.operationId,
        status: 'completed',
        resultType: 'shift',
        resultId: input.shiftId,
        requestHash: input.idempotency.requestHash,
        completedAt: input.closedAt,
      });
      return Promise.resolve(closed);
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

/**
 * Returns, over the same store.
 *
 * The two properties the route tests depend on are the ones a looser fake
 * would hide: the plan is computed from the state this store actually holds
 * (so a second partial return sees what the first one took), and `record` is
 * all-or-nothing. Concurrency is not modelled here and cannot be — that is
 * what the live PostgreSQL suite is for.
 */
export function memoryReturnRepository(store: MemoryBusinessStore): ReturnRepository {
  const stateFor = (
    scope: TenantScope,
    branchId: string | null,
    saleId: string,
  ): ReturnableSale | null => {
    const sale = store.sales.find(
      (row) =>
        row.id === saleId &&
        (row.tenantId as string) === scopeId(scope) &&
        (branchId === null || row.branchId === branchId),
    );
    if (sale === undefined) return null;

    const mine = store.returns.filter(
      (row) =>
        row.saleId === saleId &&
        (row.tenantId as string) === scopeId(scope) &&
        row.status === 'finalized',
    );
    const invoice = store.invoices.find(
      (row) => row.saleId === saleId && (row.tenantId as string) === scopeId(scope),
    );

    let refundedTotal = 0n;
    const lines: ReturnableSaleLine[] = sale.lines.map((line) => {
      const prior = mine.flatMap((row) => row.lines).filter((row) => row.saleLineId === line.id);
      const sum = (pick: (row: (typeof prior)[number]) => string): bigint =>
        prior.reduce((total, row) => total + BigInt(pick(row)), 0n);
      const returned = sum((row) => row.quantityScaled);
      refundedTotal += sum((row) => row.totalMinor);
      const remaining = BigInt(line.quantityScaled) - returned;
      return {
        saleLineId: line.id,
        lineNumber: line.lineNumber,
        productId: line.productId,
        sku: line.sku,
        nameAr: line.nameAr,
        nameEn: line.nameEn,
        productType: line.productType,
        vatBasisPoints: line.vatBasisPoints,
        unitPriceMinor: line.unitPriceMinor,
        soldQuantityScaled: line.quantityScaled,
        returnedQuantityScaled: returned.toString(),
        remainingQuantityScaled: (remaining > 0n ? remaining : 0n).toString(),
        grossMinor: line.grossMinor,
        lineDiscountMinor: line.lineDiscountMinor,
        basketDiscountMinor: line.basketDiscountMinor,
        netMinor: line.netMinor,
        vatMinor: line.vatMinor,
        totalMinor: line.totalMinor,
        refundedGrossMinor: sum((row) => row.grossMinor).toString(),
        refundedNetMinor: sum((row) => row.netMinor).toString(),
        refundedLineDiscountMinor: sum((row) => row.lineDiscountMinor).toString(),
        refundedBasketDiscountMinor: sum((row) => row.basketDiscountMinor).toString(),
        refundedVatMinor: sum((row) => row.vatMinor).toString(),
      };
    });

    return {
      saleId: sale.id,
      branchId: sale.branchId,
      status: sale.status,
      invoiceNumber: invoice?.invoiceNumber ?? null,
      currency: sale.currency,
      issuedAt: sale.issuedAt,
      netMinor: sale.netMinor,
      vatMinor: sale.vatMinor,
      totalMinor: sale.totalMinor,
      refundedTotalMinor: refundedTotal.toString(),
      lines,
    };
  };

  return {
    findById: (scope, id) =>
      Promise.resolve(
        store.returns.find((row) => row.id === id && (row.tenantId as string) === scopeId(scope)) ??
          null,
      ),

    findByOperationId: (scope, operationId) =>
      Promise.resolve(
        store.returns.find(
          (row) => row.operationId === operationId && (row.tenantId as string) === scopeId(scope),
        ) ?? null,
      ),

    returnableForSale: (scope, branchId, saleId) =>
      Promise.resolve(stateFor(scope, branchId, saleId)),

    lookupSales: (scope, query: SaleLookupQuery) => {
      const term = query.term.trim();
      const rows: SaleLookupRow[] = store.sales
        .filter(
          (sale) =>
            (sale.tenantId as string) === scopeId(scope) &&
            sale.branchId === query.branchId &&
            sale.status === 'finalized',
        )
        .filter((sale) => {
          const invoice = store.invoices.find((row) => row.saleId === sale.id);
          return (
            invoice?.invoiceNumber === term || String(sale.sequence) === term || sale.id === term
          );
        })
        .slice(0, Math.min(query.limit, 25))
        .map((sale) => {
          const refunded = store.returns
            .filter((row) => row.saleId === sale.id && row.status === 'finalized')
            .reduce((total, row) => total + BigInt(row.totalMinor), 0n);
          const invoice = store.invoices.find((row) => row.saleId === sale.id);
          return {
            saleId: sale.id,
            invoiceNumber: invoice?.invoiceNumber ?? null,
            sequence: sale.sequence,
            issuedAt: sale.issuedAt,
            currency: sale.currency,
            totalMinor: sale.totalMinor,
            refundedTotalMinor: refunded.toString(),
            fullyReturned: refunded >= BigInt(sale.totalMinor),
          };
        });
      return Promise.resolve(rows);
    },

    record: (scope: TenantScope, input: RecordReturnInput) => {
      const state = stateFor(scope, input.branchId, input.saleId);
      if (state === null) throw new ReturnNotAllowedError('unknown-sale');
      if (state.status !== 'finalized') throw new ReturnNotAllowedError('sale-not-finalized');

      const shift = store.shifts.find(
        (row) => row.id === input.shiftId && (row.tenantId as string) === scopeId(scope),
      );
      if (shift === undefined || shift.status !== 'open') {
        throw new ShiftUnusableError('shift-closed');
      }
      if (shift.userId !== input.actorUserId) throw new ShiftUnusableError('cashier-mismatch');

      if (
        store.keys.some(
          (key) =>
            (key.tenantId as string) === scopeId(scope) &&
            key.scope === input.idempotency.scope &&
            key.operationId === input.operationId,
        )
      ) {
        throw new OperationAlreadyRecordedError(input.operationId);
      }

      // Thrown before anything is written, exactly as the real adapter does it.
      const plan = input.plan(state);

      const sequence =
        store.returns.filter(
          (row) => (row.tenantId as string) === scopeId(scope) && row.branchId === input.branchId,
        ).length + 1;

      const record: ReturnRecord = {
        id: input.returnId,
        tenantId: brandTenantId(scopeId(scope)),
        saleId: input.saleId,
        branchId: input.branchId,
        terminalId: input.terminalId,
        shiftId: input.shiftId,
        actorUserId: input.actorUserId,
        operationId: input.operationId,
        status: 'finalized',
        sequence,
        returnNumber: `R-01-${String(sequence).padStart(6, '0')}`,
        reason: input.reason,
        currency: input.currency,
        grossMinor: plan.grossMinor,
        lineDiscountMinor: plan.lineDiscountMinor,
        basketDiscountMinor: plan.basketDiscountMinor,
        netMinor: plan.netMinor,
        vatMinor: plan.vatMinor,
        totalMinor: plan.totalMinor,
        issuedAt: input.issuedAt,
        lines: plan.lines.map((line, index) => ({
          id: input.lineIds[index] ?? `line-${String(index)}`,
          lineNumber: line.lineNumber,
          saleLineId: line.saleLineId,
          productId: line.productId,
          sku: line.sku,
          nameAr: line.nameAr,
          nameEn: line.nameEn,
          productType: line.productType,
          vatBasisPoints: line.vatBasisPoints,
          quantityScaled: line.quantityScaled,
          grossMinor: line.grossMinor,
          lineDiscountMinor: line.lineDiscountMinor,
          basketDiscountMinor: line.basketDiscountMinor,
          netMinor: line.netMinor,
          vatMinor: line.vatMinor,
          totalMinor: line.totalMinor,
        })),
        refund: {
          id: input.refund.id,
          kind: input.refund.kind,
          scheme: input.refund.scheme,
          // Server-derived, always.
          amountMinor: plan.totalMinor,
          reference: input.refund.reference,
          issuedAt: input.issuedAt,
        },
      };

      store.returns.push(record);
      store.keys.push({
        id: input.idempotency.id,
        tenantId: brandTenantId(scopeId(scope)),
        scope: input.idempotency.scope,
        operationId: input.operationId,
        status: 'completed',
        resultType: 'return',
        resultId: input.returnId,
        requestHash: input.idempotency.requestHash,
        completedAt: input.issuedAt,
      });

      let movement = 0;
      for (const line of plan.lines) {
        const consumed = store.movements.some(
          (row) =>
            row.sourceType === 'sale' &&
            row.sourceId === input.saleId &&
            row.productId === line.productId,
        );
        if (line.productId === null || !consumed) continue;
        store.movements.push({
          id: input.inventoryIds[movement] ?? `mv-${String(movement)}`,
          tenantId: scopeId(scope),
          branchId: input.branchId,
          productId: line.productId,
          kind: 'return',
          quantityScaled: line.quantityScaled,
          reason: null,
          sourceType: 'return',
          sourceId: input.returnId,
          actorUserId: input.actorUserId,
          occurredAt: input.issuedAt,
        });
        movement += 1;
      }

      if (input.refund.kind === 'cash') {
        store.cashMovements.push({
          kind: 'refund',
          amountMinor: (-BigInt(plan.totalMinor)).toString(),
          shiftId: input.shiftId,
        });
      }

      return Promise.resolve(record);
    },
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
      closedByUserId: null,
      openedAt: '2026-08-12T06:00:00.000Z',
      closedAt: null,
      reconciliation: null,
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
