import {
  InvalidAmountError,
  InvalidTenderError,
  NonCashChangeError,
  UnderpaidError,
  basisPoints,
  finalizeSale,
  money,
  newId as defaultNewId,
  planNoReceiptExchangePolicy,
  priceCart,
  quantity,
  saleReconciles,
  tenantId as brandTenantId,
} from '@korvi/domain';
import {
  InsufficientStockError,
  OperationAlreadyRecordedError,
  ShiftUnusableError,
} from '@korvi/database';
import { fingerprintNoReceiptExchangeIntent } from './fingerprint.js';
import { buildCheckoutReceipt } from '../checkout/receipt.js';
import type { CheckoutReceipt } from '../checkout/receipt.js';
import type { CheckoutFiscalizationPort } from '../zatca/fiscalize-checkout.js';
import type { CheckoutTenderInput, SaleSummary } from '../checkout/service.js';
import type {
  AuthenticatedPrincipal,
  CartLineInput,
  Currency,
  InventoryMovementInput,
  InvoiceRecord,
  NoReceiptExchangeRecord,
  NoReceiptExchangeRepository,
  Product,
  ProductRepository,
  RecordSaleInput,
  SaleRecord,
  SaleRepository,
  ShiftRepository,
  TenderLine,
  TenderRecord,
  TenantRepository,
  TenantScope,
} from '@korvi/domain';

export const NO_RECEIPT_EXCHANGE_REASONS = [
  'customer-no-receipt',
  'gift-return',
  'receipt-unavailable',
  'manager-exception',
  'other',
] as const;

export type NoReceiptExchangeReason = (typeof NO_RECEIPT_EXCHANGE_REASONS)[number];

export type NoReceiptExchangeFailureReason =
  | 'permission-denied'
  | 'branch-required'
  | 'no-open-shift'
  | 'shift-invalid'
  | 'tenant-misconfigured'
  | 'unknown-product'
  | 'product-unavailable'
  | 'duplicate-accepted-line'
  | 'duplicate-replacement-line'
  | 'invalid-quantity'
  | 'invalid-allowance'
  | 'replacement-below-allowance'
  | 'insufficient-payment'
  | 'invalid-tender'
  | 'insufficient-stock'
  | 'idempotency-conflict';

export interface NoReceiptExchangeFailure {
  readonly outcome: 'failure';
  readonly reason: NoReceiptExchangeFailureReason;
  readonly detail?: string;
}

export interface NoReceiptExchangeInput {
  readonly principal: AuthenticatedPrincipal;
  readonly operationId: string;
  readonly terminalId: string;
  readonly expectedShiftId?: string | undefined;
  readonly reason: NoReceiptExchangeReason;
  readonly evidenceNote?: string | undefined;
  readonly approvedAllowanceMinor: string;
  readonly acceptedLines: readonly {
    readonly productId: string;
    readonly quantityScaled: string;
  }[];
  readonly replacementLines: readonly {
    readonly productId: string;
    readonly quantityScaled: string;
  }[];
  readonly tenders: readonly CheckoutTenderInput[];
}

export interface NoReceiptExchangeSuccess {
  readonly outcome: 'success';
  readonly replayed: boolean;
  readonly case: NoReceiptExchangeRecord;
  readonly sale: SaleSummary;
  readonly receipt: CheckoutReceipt | null;
}

export type NoReceiptExchangeResult = NoReceiptExchangeSuccess | NoReceiptExchangeFailure;

export interface NoReceiptExchangeDeps {
  readonly tenants: TenantRepository;
  readonly products: ProductRepository;
  readonly shifts: ShiftRepository;
  readonly sales: SaleRepository;
  readonly exchanges: NoReceiptExchangeRepository;
  readonly fiscalization?: CheckoutFiscalizationPort;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

function fail(reason: NoReceiptExchangeFailureReason, detail?: string): NoReceiptExchangeFailure {
  return detail === undefined
    ? { outcome: 'failure', reason }
    : { outcome: 'failure', reason, detail };
}

function parsePositiveQuantity(value: string): bigint | null {
  if (!/^[1-9][0-9]{0,11}$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed > 0n ? parsed : null;
}

function parseMinor(value: string): bigint | null {
  if (!/^(0|[1-9][0-9]{0,14})$/.test(value)) return null;
  return BigInt(value);
}

function toTenderLine(tender: CheckoutTenderInput, currency: Currency): TenderLine {
  return tender.kind === 'cash'
    ? { kind: 'cash', amount: money(BigInt(tender.amountMinor), currency) }
    : {
        kind: 'electronic',
        amount: money(BigInt(tender.amountMinor), currency),
        scheme: tender.scheme,
        reference: tender.reference,
      };
}

function summariseSale(sale: SaleRecord, invoiceNumber: string, cashierName: string): SaleSummary {
  return {
    saleId: sale.id,
    operationId: sale.operationId,
    orderType: sale.orderType ?? null,
    tableId: sale.tableId ?? null,
    restaurantOrderId: sale.restaurantOrderId ?? null,
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
    tenderedMinor: sale.tenderedMinor,
    cashReceivedMinor: sale.tenders
      .filter((tender) => tender.kind === 'cash')
      .reduce((total, tender) => total + BigInt(tender.amountMinor), 0n)
      .toString(),
    changeMinor: sale.changeMinor,
    tenders: sale.tenders.map((tender) => ({
      kind: tender.kind,
      scheme: tender.scheme,
      amountMinor: tender.amountMinor,
      changeMinor: tender.changeMinor,
      reference: tender.reference,
    })),
  };
}

async function loadProducts(
  products: ProductRepository,
  scope: TenantScope,
  lines: readonly { readonly productId: string; readonly quantityScaled: string }[],
): Promise<
  | { readonly ok: true; readonly rows: readonly { product: Product; quantityScaled: bigint }[] }
  | {
      readonly ok: false;
      readonly reason: 'unknown-product' | 'product-unavailable' | 'invalid-quantity';
    }
> {
  const rows: { product: Product; quantityScaled: bigint }[] = [];
  for (const line of lines) {
    const quantityScaled = parsePositiveQuantity(line.quantityScaled);
    if (quantityScaled === null) return { ok: false, reason: 'invalid-quantity' };
    const product = await products.findById(scope, line.productId);
    if (product === null) return { ok: false, reason: 'unknown-product' };
    if (!product.isActive) return { ok: false, reason: 'product-unavailable' };
    if (product.productType === 'unit' && quantityScaled % 1_000n !== 0n) {
      return { ok: false, reason: 'invalid-quantity' };
    }
    rows.push({ product, quantityScaled });
  }
  return { ok: true, rows };
}

function hasDuplicates(lines: readonly { readonly productId: string }[]): boolean {
  return new Set(lines.map((line) => line.productId)).size !== lines.length;
}

export interface NoReceiptExchangeService {
  create(input: NoReceiptExchangeInput): Promise<NoReceiptExchangeResult>;
}

export function createNoReceiptExchangeService(
  deps: NoReceiptExchangeDeps,
): NoReceiptExchangeService {
  const { now = () => new Date(), newId = defaultNewId } = deps;

  async function fiscalize(
    scope: TenantScope,
    sale: SaleRecord,
    invoice: InvoiceRecord,
  ): Promise<CheckoutReceipt | null> {
    if (deps.fiscalization === undefined) return null;
    const artifact = await deps.fiscalization.fiscalize(scope, sale, invoice);
    return artifact === null ? null : buildCheckoutReceipt(sale, invoice, artifact);
  }

  async function replay(
    scope: TenantScope,
    input: NoReceiptExchangeInput,
    intentHash: string,
    existing: NoReceiptExchangeRecord,
  ): Promise<NoReceiptExchangeResult> {
    if (existing.requestHash !== intentHash) return fail('idempotency-conflict');
    if (input.expectedShiftId !== undefined && existing.shiftId !== input.expectedShiftId) {
      return fail('idempotency-conflict');
    }
    const sale = await deps.sales.findById(scope, existing.linkedSaleId);
    if (sale === null) throw new Error('Finalized no-receipt exchange is missing its linked sale.');
    const invoice = await deps.sales.invoiceForSale(scope, sale.id);
    if (invoice === null) throw new Error('Finalized replacement sale is missing its invoice.');
    return {
      outcome: 'success',
      replayed: true,
      case: existing,
      sale: summariseSale(sale, invoice.invoiceNumber, input.principal.displayName),
      receipt: await fiscalize(scope, sale, invoice),
    };
  }

  return {
    async create(input: NoReceiptExchangeInput): Promise<NoReceiptExchangeResult> {
      if (!input.principal.permissions.includes('sale.exchange.no-receipt')) {
        return fail('permission-denied');
      }
      if (input.principal.branchId === null) return fail('branch-required');
      if (
        input.acceptedLines.length === 0 ||
        input.replacementLines.length === 0 ||
        input.acceptedLines.length > 200 ||
        input.replacementLines.length > 200
      ) {
        return fail('invalid-quantity');
      }
      if (hasDuplicates(input.acceptedLines)) return fail('duplicate-accepted-line');
      if (hasDuplicates(input.replacementLines)) return fail('duplicate-replacement-line');

      const approvedAllowance = parseMinor(input.approvedAllowanceMinor);
      if (approvedAllowance === null) return fail('invalid-allowance');

      const evidenceNote = input.evidenceNote?.trim();
      if (evidenceNote !== undefined && (evidenceNote.length === 0 || evidenceNote.length > 500)) {
        return fail('invalid-allowance', 'ملاحظة الإثبات غير صالحة.');
      }

      const intentHash = fingerprintNoReceiptExchangeIntent({
        terminalId: input.terminalId,
        expectedShiftId: input.expectedShiftId ?? '',
        reason: input.reason,
        evidenceNote: evidenceNote ?? '',
        approvedAllowanceMinor: input.approvedAllowanceMinor,
        acceptedLines: input.acceptedLines,
        replacementLines: input.replacementLines,
        tenders: input.tenders.map((tender) =>
          tender.kind === 'cash'
            ? { kind: 'cash', amountMinor: tender.amountMinor, scheme: '', reference: '' }
            : {
                kind: 'electronic',
                amountMinor: tender.amountMinor,
                scheme: tender.scheme,
                reference: tender.reference,
              },
        ),
      });

      const scope: TenantScope = { tenantId: brandTenantId(input.principal.tenantId) };
      const existing = await deps.exchanges.findByOperationId(scope, input.operationId);
      if (existing !== null) return replay(scope, input, intentHash, existing);

      const shift = await deps.shifts.findOpenForTerminal(scope, input.terminalId);
      if (shift === null) return fail('no-open-shift');
      if (
        shift.userId !== input.principal.userId ||
        shift.branchId !== input.principal.branchId ||
        (input.expectedShiftId !== undefined && shift.id !== input.expectedShiftId)
      ) {
        return fail('shift-invalid');
      }

      const [tenant, settings] = await Promise.all([
        deps.tenants.current(scope),
        deps.tenants.settings(scope),
      ]);
      if (tenant === null || settings === null || settings.currency !== 'SAR') {
        return fail('tenant-misconfigured');
      }

      const accepted = await loadProducts(deps.products, scope, input.acceptedLines);
      if (!accepted.ok) return fail(accepted.reason);
      const replacement = await loadProducts(deps.products, scope, input.replacementLines);
      if (!replacement.ok) return fail(replacement.reason);

      let policy;
      try {
        policy = planNoReceiptExchangePolicy({
          priceMode: settings.priceMode,
          currency: settings.currency,
          accepted: accepted.rows.map(({ product, quantityScaled }) => ({
            productId: product.id,
            sku: product.sku,
            nameAr: product.nameAr,
            nameEn: product.nameEn,
            productType: product.productType,
            quantityScaled,
            currentUnitReferencePrice: money(BigInt(product.priceMinor)),
            currentVatBasisPoints: product.vatBasisPoints,
            trackInventory: product.trackInventory,
          })),
          approvedAllowanceMinor: approvedAllowance,
        });
      } catch (error) {
        if (error instanceof InvalidAmountError) return fail('invalid-quantity');
        return fail('invalid-allowance');
      }

      const currency: Currency = 'SAR';
      const cart = {
        priceMode: settings.priceMode,
        currency,
        lines: replacement.rows.map(({ product, quantityScaled }, index): CartLineInput => ({
          lineId: String(index + 1),
          productId: product.id,
          sku: product.sku,
          nameAr: product.nameAr,
          nameEn: product.nameEn,
          unitPrice: money(BigInt(product.priceMinor), currency),
          quantity: quantity(quantityScaled),
          vatRate: basisPoints(Number(product.vatBasisPoints)),
          isWeighted: product.productType === 'weighted',
        })),
      };

      const pricedPreview = priceCart(cart);
      if (pricedPreview.total.minor < approvedAllowance) {
        return fail('replacement-below-allowance');
      }

      const payment: TenderLine[] = [
        ...(approvedAllowance > 0n
          ? [{ kind: 'exchange_allowance' as const, amount: money(approvedAllowance, currency) }]
          : []),
        ...input.tenders.map((tender) => toTenderLine(tender, currency)),
      ];

      const caseId = newId();
      const saleId = newId();
      const issuedAt = now().toISOString();
      let finalized;
      try {
        finalized = finalizeSale({
          saleId,
          operationId: `${input.operationId}:replacement`,
          tenantId: input.principal.tenantId,
          branchId: shift.branchId,
          terminalId: input.terminalId,
          shiftId: shift.id,
          cashierId: input.principal.userId,
          customerId: null,
          cart,
          tenders: payment,
          issuedAt,
          maxDiscountBasisPoints: 0n,
        });
      } catch (error) {
        if (error instanceof UnderpaidError) return fail('insufficient-payment');
        if (error instanceof NonCashChangeError) return fail('invalid-tender');
        if (error instanceof InvalidTenderError) return fail('invalid-tender');
        if (error instanceof InvalidAmountError) return fail('invalid-quantity');
        throw error;
      }

      if (!saleReconciles(finalized)) {
        throw new Error('Replacement sale does not reconcile; refusing no-receipt exchange.');
      }

      const recordedTenders: TenderRecord[] = payment.map((tender) => ({
        id: newId(),
        kind: tender.kind,
        scheme: tender.kind === 'electronic' ? (tender.scheme ?? null) : null,
        amountMinor: tender.amount.minor.toString(),
        changeMinor: tender.kind === 'cash' ? finalized.settlement.change.minor.toString() : '0',
        reference: tender.kind === 'electronic' ? (tender.reference ?? null) : null,
      }));

      const cashRetainedMinor =
        input.tenders
          .filter((tender) => tender.kind === 'cash')
          .reduce((total, tender) => total + BigInt(tender.amountMinor), 0n) -
        finalized.settlement.change.minor;

      const recordSale: RecordSaleInput = {
        sale: {
          id: saleId,
          branchId: shift.branchId,
          terminalId: input.terminalId,
          shiftId: shift.id,
          userId: input.principal.userId,
          customerId: null,
          tableId: null,
          restaurantOrderId: null,
          operationId: finalized.operationId,
          status: 'finalized',
          orderType: null,
          priceMode: settings.priceMode,
          currency,
          grossMinor: finalized.priced.gross.minor.toString(),
          lineDiscountMinor: '0',
          basketDiscountMinor: '0',
          netMinor: finalized.priced.net.minor.toString(),
          vatMinor: finalized.priced.vat.minor.toString(),
          totalMinor: finalized.priced.total.minor.toString(),
          tenderedMinor: finalized.settlement.tendered.minor.toString(),
          changeMinor: finalized.settlement.change.minor.toString(),
          issuedAt,
          lines: finalized.priced.lines.map((line, index) => ({
            id: newId(),
            lineNumber: index + 1,
            productId: line.productId,
            sku: line.sku,
            nameAr: line.nameAr,
            nameEn: line.nameEn,
            productType: replacement.rows[index]?.product.productType ?? null,
            unitPriceMinor: line.unitPrice.minor.toString(),
            vatBasisPoints: line.vatRate,
            quantityScaled: line.quantity.toString(),
            grossMinor: line.gross.minor.toString(),
            lineDiscountMinor: '0',
            basketDiscountMinor: '0',
            netMinor: line.net.minor.toString(),
            vatMinor: line.vat.minor.toString(),
            totalMinor: line.total.minor.toString(),
          })),
          discounts: [],
          tenders: recordedTenders,
        },
        invoice: {
          id: newId(),
          saleId,
          invoiceType: 'simplified',
          sellerName: tenant.name,
          sellerVatNumber: tenant.vatNumber ?? '',
          buyerName: null,
          buyerVatNumber: null,
          netMinor: finalized.priced.net.minor.toString(),
          vatMinor: finalized.priced.vat.minor.toString(),
          totalMinor: finalized.priced.total.minor.toString(),
          currency,
          issuedAt,
          taxBreakdown: finalized.priced.vatBreakdown.map((bucket) => ({
            vatBasisPoints: bucket.rate,
            netMinor: bucket.net.minor.toString(),
            vatMinor: bucket.vat.minor.toString(),
          })),
        },
        inventory: replacement.rows
          .filter(({ product }) => product.trackInventory)
          .map(({ product, quantityScaled }): InventoryMovementInput => ({
            id: newId(),
            branchId: shift.branchId,
            productId: product.id,
            kind: 'sale',
            quantityScaled: (-quantityScaled).toString(),
            reason: null,
            sourceType: 'sale',
            sourceId: saleId,
            actorUserId: input.principal.userId,
            occurredAt: issuedAt,
          })),
        cashMovement:
          cashRetainedMinor > 0n
            ? {
                id: newId(),
                shiftId: shift.id,
                kind: 'sale',
                amountMinor: cashRetainedMinor.toString(),
                reason: null,
                actorUserId: input.principal.userId,
                occurredAt: issuedAt,
              }
            : null,
        idempotency: {
          id: newId(),
          scope: 'no-receipt-exchange',
          operationId: input.operationId,
          requestHash: intentHash,
        },
      };

      const lines = policy.lines.map((line, index) => ({
        id: newId(),
        lineNumber: index + 1,
        productId: line.productId,
        sku: line.sku,
        nameAr: line.nameAr,
        nameEn: line.nameEn,
        productType: line.productType,
        quantityScaled: line.quantityScaled.toString(),
        currentUnitReferencePriceMinor: line.currentUnitReferencePriceMinor.toString(),
        currentVatBasisPoints: line.currentVatBasisPoints,
        currentReferenceTotalMinor: line.currentReferenceTotalMinor.toString(),
        trackInventory: line.trackInventory,
        stockDisposition: 'sellable' as const,
        costProvenance: 'unknown' as const,
      }));

      try {
        const document = await deps.exchanges.record(scope, {
          exchange: {
            id: caseId,
            branchId: shift.branchId,
            terminalId: input.terminalId,
            shiftId: shift.id,
            actorUserId: input.principal.userId,
            operationId: input.operationId,
            requestHash: intentHash,
            status: 'finalized',
            reason: input.reason,
            evidenceNote: evidenceNote ?? null,
            currency,
            referenceCeilingMinor: policy.referenceCeilingMinor.toString(),
            approvedAllowanceMinor: policy.approvedAllowanceMinor.toString(),
            issuedAt,
          },
          lines,
          intake: lines
            .filter((line) => line.trackInventory)
            .map((line) => ({
              caseLineId: line.id,
              movement: {
                id: newId(),
                branchId: shift.branchId,
                productId: line.productId,
                kind: 'no-receipt-exchange-intake' as const,
                quantityScaled: line.quantityScaled,
                reason: input.reason,
                sourceType: 'no-receipt-exchange',
                sourceId: caseId,
                actorUserId: input.principal.userId,
                occurredAt: issuedAt,
              },
            })),
          replacementSale: recordSale,
          audits: [
            {
              id: newId(),
              actorUserId: input.principal.userId,
              branchId: shift.branchId,
              terminalId: input.terminalId,
              eventType: 'no-receipt-exchange.completed',
              entityType: 'no-receipt-exchange',
              entityId: caseId,
              metadata: {
                reason: input.reason,
                acceptedLines: lines.length,
                approvedAllowanceMinor: policy.approvedAllowanceMinor.toString(),
                referenceCeilingMinor: policy.referenceCeilingMinor.toString(),
                linkedSaleId: saleId,
                trackedIntakeLines: lines.filter((line) => line.trackInventory).length,
              },
              occurredAt: issuedAt,
            },
            {
              id: newId(),
              actorUserId: input.principal.userId,
              branchId: shift.branchId,
              terminalId: input.terminalId,
              eventType: 'sale.completed',
              entityType: 'sale',
              entityId: saleId,
              metadata: {
                source: 'no-receipt-exchange',
                exchangeCaseId: caseId,
                totalMinor: finalized.priced.total.minor.toString(),
                exchangeAllowanceMinor: policy.approvedAllowanceMinor.toString(),
                lines: recordSale.sale.lines.length,
              },
              occurredAt: issuedAt,
            },
          ],
        });

        const sale = await deps.sales.findById(scope, document.linkedSaleId);
        if (sale === null) throw new Error('Committed exchange is missing its replacement sale.');
        const invoice = await deps.sales.invoiceForSale(scope, sale.id);
        if (invoice === null) throw new Error('Committed replacement sale is missing its invoice.');

        return {
          outcome: 'success',
          replayed: false,
          case: document,
          sale: summariseSale(sale, invoice.invoiceNumber, input.principal.displayName),
          receipt: await fiscalize(scope, sale, invoice),
        };
      } catch (error) {
        if (error instanceof InsufficientStockError) return fail('insufficient-stock');
        if (error instanceof ShiftUnusableError) return fail('shift-invalid');
        if (error instanceof OperationAlreadyRecordedError) {
          const winner = await deps.exchanges.findByOperationId(scope, input.operationId);
          return winner === null
            ? fail('idempotency-conflict')
            : replay(scope, input, intentHash, winner);
        }
        throw error;
      }
    },
  };
}
