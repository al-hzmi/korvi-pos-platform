import {
  InvalidAmountError,
  NonCashChangeError,
  UnderpaidError,
  basisPoints,
  finalizeSale,
  maxDiscountForRoles,
  money,
  moneyToMajorString,
  newId as defaultNewId,
  quantity,
  saleReconciles,
  tenantId as brandTenantId,
} from '@korvi/domain';
import {
  InsufficientStockError,
  OperationAlreadyRecordedError,
  ShiftUnusableError,
} from '@korvi/database';
import { fingerprintIntent } from './fingerprint.js';
import type {
  AuditRepository,
  AuthenticatedPrincipal,
  CartLineInput,
  Currency,
  IdempotencyRepository,
  InventoryMovementInput,
  InventoryRepository,
  PriceMode,
  Product,
  ProductRepository,
  SaleRecord,
  SaleRepository,
  ShiftRepository,
  TenantRepository,
  TenantScope,
} from '@korvi/domain';

/**
 * The cash checkout.
 *
 * The browser sends product ids, quantities and the cash it was handed. That is
 * the whole of what a client is allowed to assert. Prices, VAT rates, the price
 * mode, the seller's tax identity, the receipt number and every derived figure
 * come from persistence and from the domain — because a till is operated by
 * people whose interests do not always align with the merchant's, and because
 * the browser is not a place where money can be decided.
 */

export type CheckoutFailureReason =
  | 'empty-cart'
  | 'no-open-shift'
  | 'unknown-product'
  | 'product-unavailable'
  | 'invalid-quantity'
  | 'insufficient-stock'
  | 'insufficient-cash'
  | 'idempotency-conflict'
  | 'duplicate-line'
  | 'shift-invalid'
  | 'tenant-misconfigured';

export interface CheckoutFailure {
  readonly outcome: 'failure';
  readonly reason: CheckoutFailureReason;
  /** Safe to show a cashier; never a database or security detail. */
  readonly detail?: string;
}

export interface SaleSummaryLine {
  readonly lineNumber: number;
  readonly productId: string | null;
  readonly sku: string;
  readonly nameAr: string;
  readonly quantityScaled: string;
  readonly unitPriceMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
}

export interface SaleSummary {
  readonly saleId: string;
  readonly operationId: string;
  readonly sequence: number;
  readonly invoiceNumber: string;
  readonly issuedAt: string;
  readonly currency: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly shiftId: string;
  readonly cashierName: string;
  readonly lines: readonly SaleSummaryLine[];
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly cashReceivedMinor: string;
  readonly changeMinor: string;
}

export interface CheckoutSuccess {
  readonly outcome: 'success';
  /** True when this request replayed an operation id that already completed. */
  readonly replayed: boolean;
  readonly sale: SaleSummary;
}

export type CheckoutResult = CheckoutSuccess | CheckoutFailure;

export interface CheckoutLineInput {
  readonly productId: string;
  /** Scaled by 1000, as a string. Never a float (ADR-0002). */
  readonly quantityScaled: string;
}

export interface CheckoutInput {
  readonly principal: AuthenticatedPrincipal;
  readonly operationId: string;
  readonly terminalId: string;
  readonly lines: readonly CheckoutLineInput[];
  readonly cashReceivedMinor: string;
}

export interface CheckoutDeps {
  readonly tenants: TenantRepository;
  readonly products: ProductRepository;
  readonly inventory: InventoryRepository;
  readonly shifts: ShiftRepository;
  readonly sales: SaleRepository;
  readonly idempotency: IdempotencyRepository;
  readonly audit: AuditRepository;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly onAuditError?: (error: unknown) => void;
}

const IDEMPOTENCY_SCOPE = 'checkout';

function fail(reason: CheckoutFailureReason, detail?: string): CheckoutFailure {
  return detail === undefined
    ? { outcome: 'failure', reason }
    : { outcome: 'failure', reason, detail };
}

function summarise(sale: SaleRecord, invoiceNumber: string, cashierName: string): SaleSummary {
  return {
    saleId: sale.id,
    operationId: sale.operationId,
    sequence: sale.sequence,
    invoiceNumber,
    issuedAt: sale.issuedAt,
    currency: sale.currency,
    branchId: sale.branchId,
    terminalId: sale.terminalId,
    shiftId: sale.shiftId,
    cashierName,
    lines: sale.lines.map((line) => ({
      lineNumber: line.lineNumber,
      productId: line.productId,
      sku: line.sku,
      nameAr: line.nameAr,
      quantityScaled: line.quantityScaled,
      unitPriceMinor: line.unitPriceMinor,
      netMinor: line.netMinor,
      vatMinor: line.vatMinor,
      totalMinor: line.totalMinor,
    })),
    netMinor: sale.netMinor,
    vatMinor: sale.vatMinor,
    totalMinor: sale.totalMinor,
    cashReceivedMinor: sale.tenderedMinor,
    changeMinor: sale.changeMinor,
  };
}

export interface CheckoutService {
  checkout(input: CheckoutInput): Promise<CheckoutResult>;
}

export function createCheckoutService(deps: CheckoutDeps): CheckoutService {
  const { now = () => new Date(), newId = defaultNewId, onAuditError = () => undefined } = deps;

  /**
   * Answer a request whose operation id belongs to a transaction that has
   * already committed.
   *
   * Reached from two directions — the pre-flight read, and losing the
   * ON CONFLICT race — and both need the same answer, so both come here.
   */
  async function resolveCompetingOperation(
    scope: TenantScope,
    input: CheckoutInput,
    intentHash: string,
    displayName: string,
  ): Promise<CheckoutResult> {
    const reserved = await deps.idempotency.find(scope, IDEMPOTENCY_SCOPE, input.operationId);
    if (reserved !== null && reserved.requestHash !== intentHash) {
      return fail('idempotency-conflict');
    }
    const existing = await deps.sales.findByOperationId(scope, input.operationId);
    if (existing === null) {
      // Reserved but no sale: the competitor rolled back after all, or the
      // reservation belongs to something other than a completed checkout.
      // Refusing is the only safe answer — retrying could double-charge.
      return fail('idempotency-conflict');
    }
    const invoice = await deps.sales.invoiceForSale(scope, existing.id);
    return {
      outcome: 'success',
      replayed: true,
      sale: summarise(existing, invoice?.invoiceNumber ?? '', displayName),
    };
  }

  return {
    async checkout(input: CheckoutInput): Promise<CheckoutResult> {
      const scope: TenantScope = { tenantId: brandTenantId(input.principal.tenantId) };
      if (input.lines.length === 0) return fail('empty-cart');

      // A cash sale needs somewhere for the cash to go. The shift also supplies
      // the branch, so the client never names one.
      // Two lines for one product would each pass a stock check the sum fails.
      // Aggregating them silently would also change what the cashier sees, so
      // the request is refused and the client asked to send one line.
      const seen = new Set<string>();
      for (const line of input.lines) {
        if (seen.has(line.productId)) return fail('duplicate-line');
        seen.add(line.productId);
      }

      const shift = await deps.shifts.findOpenForTerminal(scope, input.terminalId);
      if (shift === null) return fail('no-open-shift');
      // The drawer belongs to one cashier. Ringing into somebody else's shift
      // makes their variance unanswerable at close.
      if (shift.userId !== input.principal.userId) return fail('shift-invalid');
      // A principal pinned to a branch may not transact through a till in
      // another one.
      if (input.principal.branchId !== null && input.principal.branchId !== shift.branchId) {
        return fail('shift-invalid');
      }

      const intentHash = fingerprintIntent({
        branchId: shift.branchId,
        terminalId: input.terminalId,
        lines: input.lines.map((line) => ({
          productId: line.productId,
          quantityScaled: line.quantityScaled,
        })),
        cashReceivedMinor: input.cashReceivedMinor,
      });

      // Replay, before anything is computed or written.
      const reserved = await deps.idempotency.find(scope, IDEMPOTENCY_SCOPE, input.operationId);
      if (reserved !== null) {
        // The same key with a different basket is not a retry. Answering it
        // with the earlier sale would quietly drop a transaction the cashier
        // believes they rang up.
        if (reserved.requestHash !== intentHash) return fail('idempotency-conflict');
        const existing = await deps.sales.findByOperationId(scope, input.operationId);
        if (existing !== null) {
          const invoice = await deps.sales.invoiceForSale(scope, existing.id);
          return {
            outcome: 'success',
            replayed: true,
            sale: summarise(existing, invoice?.invoiceNumber ?? '', input.principal.displayName),
          };
        }
      }

      const tenant = await deps.tenants.current(scope);
      const settings = await deps.tenants.settings(scope);
      if (tenant === null || settings === null) {
        return fail('tenant-misconfigured', 'إعدادات المنشأة غير مكتملة.');
      }

      // Prices come from here and nowhere else.
      const loaded: { product: Product; scaled: bigint }[] = [];
      for (const line of input.lines) {
        const product = await deps.products.findById(scope, line.productId);
        if (product === null) return fail('unknown-product');
        if (!product.isActive) return fail('product-unavailable');

        let scaled: bigint;
        try {
          scaled = quantity(BigInt(line.quantityScaled));
        } catch {
          return fail('invalid-quantity');
        }
        if (scaled <= 0n) return fail('invalid-quantity');
        // A unit product cannot be sold in thirds. The scale is 1000, so a
        // whole unit is a multiple of it.
        if (product.productType === 'unit' && scaled % 1_000n !== 0n) {
          return fail('invalid-quantity');
        }
        loaded.push({ product, scaled });
      }

      // Stock, before the money is touched. Selling what is not there is a
      // decision the merchant makes in settings, not one the till makes.
      if (!settings.allowNegativeStock) {
        for (const entry of loaded) {
          if (!entry.product.trackInventory) continue;
          const balance = await deps.inventory.balance(scope, shift.branchId, entry.product.id);
          const available = balance === null ? 0n : BigInt(balance.quantityScaled);
          if (available < entry.scaled) return fail('insufficient-stock');
        }
      }

      const currency: Currency = 'SAR';
      const cart = {
        priceMode: settings.priceMode as PriceMode,
        currency,
        lines: loaded.map((entry, index): CartLineInput => ({
          lineId: String(index + 1),
          productId: entry.product.id,
          sku: entry.product.sku,
          nameAr: entry.product.nameAr,
          nameEn: entry.product.nameEn,
          unitPrice: money(BigInt(entry.product.priceMinor), currency),
          quantity: quantity(entry.scaled),
          vatRate: basisPoints(entry.product.vatBasisPoints),
          isWeighted: entry.product.productType === 'weighted',
        })),
      };

      const saleId = newId();
      const issuedAt = now().toISOString();
      let finalized;
      try {
        finalized = finalizeSale({
          saleId,
          operationId: input.operationId,
          tenantId: input.principal.tenantId,
          branchId: shift.branchId,
          terminalId: input.terminalId,
          shiftId: shift.id,
          cashierId: input.principal.userId,
          customerId: null,
          cart,
          tenders: [{ kind: 'cash', amount: money(BigInt(input.cashReceivedMinor), currency) }],
          issuedAt,
          // The ceiling comes from the roles the database granted, never from
          // the request. No discount is offered in this strike; passing the
          // real figure keeps the guard live for when one is.
          maxDiscountBasisPoints: maxDiscountForRoles(input.principal.roles),
        });
      } catch (error) {
        if (error instanceof UnderpaidError) return fail('insufficient-cash');
        if (error instanceof NonCashChangeError) return fail('insufficient-cash');
        if (error instanceof InvalidAmountError) return fail('invalid-quantity');
        throw error;
      }

      // Belt and braces over the domain's own arithmetic: a sale that does not
      // reconcile must never reach a customer, and the database CHECK that also
      // says so is not a good place to find out.
      if (!saleReconciles(finalized)) {
        throw new Error('The finalized sale does not reconcile; refusing to persist it.');
      }

      const priced = finalized.priced;
      let recorded;
      try {
        recorded = await deps.sales.record(scope, {
          sale: {
            id: saleId,
            branchId: shift.branchId,
            terminalId: input.terminalId,
            shiftId: shift.id,
            userId: input.principal.userId,
            customerId: null,
            operationId: input.operationId,
            status: 'finalized',
            priceMode: cart.priceMode,
            currency,
            grossMinor: priced.gross.minor.toString(),
            lineDiscountMinor: priced.lineDiscountTotal.minor.toString(),
            basketDiscountMinor: priced.basketDiscountTotal.minor.toString(),
            netMinor: priced.net.minor.toString(),
            vatMinor: priced.vat.minor.toString(),
            totalMinor: priced.total.minor.toString(),
            tenderedMinor: finalized.settlement.tendered.minor.toString(),
            changeMinor: finalized.settlement.change.minor.toString(),
            issuedAt,
            lines: priced.lines.map((line, index) => ({
              id: newId(),
              lineNumber: index + 1,
              productId: line.productId,
              sku: line.sku,
              nameAr: line.nameAr,
              nameEn: line.nameEn,
              unitPriceMinor: line.unitPrice.minor.toString(),
              vatBasisPoints: line.vatRate,
              quantityScaled: line.quantity.toString(),
              grossMinor: line.gross.minor.toString(),
              lineDiscountMinor: line.lineDiscount.minor.toString(),
              basketDiscountMinor: line.basketDiscount.minor.toString(),
              netMinor: line.net.minor.toString(),
              vatMinor: line.vat.minor.toString(),
              totalMinor: line.total.minor.toString(),
            })),
            discounts: [],
            tenders: [
              {
                id: newId(),
                kind: 'cash',
                amountMinor: finalized.settlement.tendered.minor.toString(),
                changeMinor: finalized.settlement.change.minor.toString(),
                reference: null,
              },
            ],
          },
          invoice: {
            id: newId(),
            saleId,
            invoiceType: 'simplified',
            sellerName: tenant.name,
            sellerVatNumber: tenant.vatNumber ?? '',
            buyerName: null,
            buyerVatNumber: null,
            netMinor: priced.net.minor.toString(),
            vatMinor: priced.vat.minor.toString(),
            totalMinor: priced.total.minor.toString(),
            currency,
            issuedAt,
            taxBreakdown: priced.vatBreakdown.map((bucket) => ({
              vatBasisPoints: bucket.rate,
              netMinor: bucket.net.minor.toString(),
              vatMinor: bucket.vat.minor.toString(),
            })),
          },
          inventory: loaded
            .filter((entry) => entry.product.trackInventory)
            .map((entry): InventoryMovementInput => ({
              id: newId(),
              branchId: shift.branchId,
              productId: entry.product.id,
              kind: 'sale',
              // Negative: stock leaves the shelf.
              quantityScaled: (-entry.scaled).toString(),
              reason: null,
              sourceType: 'sale',
              sourceId: saleId,
              actorUserId: input.principal.userId,
              occurredAt: issuedAt,
            })),
          cashMovement: {
            id: newId(),
            shiftId: shift.id,
            kind: 'sale',
            // What the drawer gained: the sale total, not what was handed over.
            amountMinor: priced.total.minor.toString(),
            reason: null,
            actorUserId: input.principal.userId,
            occurredAt: issuedAt,
          },
          idempotency: {
            id: newId(),
            scope: IDEMPOTENCY_SCOPE,
            operationId: input.operationId,
            requestHash: intentHash,
          },
        });
      } catch (error) {
        // The database is the authority on all three of these, because all
        // three are races a prior read cannot settle. Each rolls the whole
        // transaction back; none of them reaches the client as a driver error.
        if (error instanceof InsufficientStockError) return fail('insufficient-stock');
        if (error instanceof ShiftUnusableError) return fail('shift-invalid');
        if (error instanceof OperationAlreadyRecordedError) {
          // A competing transaction owned this operation id and has now
          // committed — ON CONFLICT DO NOTHING waited for it. Read what it
          // produced and answer as a replay, or as a conflict if its intent
          // differed.
          return resolveCompetingOperation(scope, input, intentHash, input.principal.displayName);
        }
        throw error;
      }

      const invoice = await deps.sales.invoiceForSale(scope, recorded.id);

      // Outside the transaction, and its failure does not undo the sale: the
      // money has moved and the receipt is printed by the time this runs.
      try {
        await deps.audit.append(scope, {
          id: newId(),
          actorUserId: input.principal.userId,
          branchId: shift.branchId,
          terminalId: input.terminalId,
          eventType: 'sale.completed',
          entityType: 'sale',
          entityId: recorded.id,
          metadata: {
            sequence: recorded.sequence,
            total: moneyToMajorString(priced.total),
            lines: recorded.lines.length,
          },
          occurredAt: issuedAt,
        });
      } catch (error) {
        onAuditError(error);
      }

      return {
        outcome: 'success',
        replayed: false,
        sale: summarise(recorded, invoice?.invoiceNumber ?? '', input.principal.displayName),
      };
    },
  };
}
