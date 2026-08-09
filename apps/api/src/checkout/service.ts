import {
  DiscountNotPermittedError,
  InvalidAmountError,
  InvalidDiscountError,
  InvalidTenderError,
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
  Discount,
  Currency,
  IdempotencyRepository,
  InventoryMovementInput,
  InventoryRepository,
  PriceMode,
  Product,
  ProductRepository,
  SaleDiscountRecord,
  SaleRecord,
  SaleRepository,
  TenderLine,
  TenderRecord,
  TenderScheme,
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
  | 'invalid-tender'
  | 'electronic-overpay'
  | 'ambiguous-payment'
  | 'invalid-discount'
  | 'discount-not-authorized'
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

export interface SaleSummaryTender {
  readonly kind: string;
  readonly scheme: string | null;
  readonly amountMinor: string;
  readonly changeMinor: string;
  readonly reference: string | null;
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
  /**
   * Every tender added up, before change.
   *
   * Distinct from `cashReceivedMinor` on purpose. On a split payment they are
   * different numbers, and calling the total "cash received" is a statement
   * about the drawer that is simply false.
   */
  readonly tenderedMinor: string;
  /** Cash, and only cash. Equal to `tenderedMinor` on a cash-only sale. */
  readonly cashReceivedMinor: string;
  readonly changeMinor: string;
  /** What was actually presented, for the receipt and for reconciliation. */
  readonly tenders: readonly SaleSummaryTender[];
}

export interface CheckoutSuccess {
  readonly outcome: 'success';
  /** True when this request replayed an operation id that already completed. */
  readonly replayed: boolean;
  readonly sale: SaleSummary;
}

export type CheckoutResult = CheckoutSuccess | CheckoutFailure;

/**
 * A discount as asked for, before anything has agreed to it.
 *
 * `basis-points` is a rate; `fixed` is halalas off. What is actually granted
 * is decided by the domain against the principal's own ceiling.
 */
export type CheckoutDiscountInput =
  | { readonly mode: 'basis-points'; readonly value: number; readonly reason?: string | undefined }
  | { readonly mode: 'fixed'; readonly amountMinor: string; readonly reason?: string | undefined };

/**
 * A payment that has already happened.
 *
 * `electronic` records a settlement approved elsewhere — a terminal, a wallet,
 * an acquirer. Korvi contacts none of them and this type does not pretend
 * otherwise: there is a scheme, somebody else's reference, and nothing that
 * could move money.
 */
export type CheckoutTenderInput =
  | { readonly kind: 'cash'; readonly amountMinor: string }
  | {
      readonly kind: 'electronic';
      readonly amountMinor: string;
      readonly scheme: TenderScheme;
      readonly reference: string;
    };

export interface CheckoutLineInput {
  readonly productId: string;
  /** Scaled by 1000, as a string. Never a float (ADR-0002). */
  readonly quantityScaled: string;
  // `| undefined` rather than a bare optional: these arrive straight from a
  // parsed request body, where an absent key really is `undefined`, and
  // exactOptionalPropertyTypes treats the two as different things.
  readonly discount?: CheckoutDiscountInput | undefined;
}

export interface CheckoutInput {
  readonly principal: AuthenticatedPrincipal;
  readonly operationId: string;
  readonly terminalId: string;
  readonly lines: readonly CheckoutLineInput[];
  /**
   * The cash-only shape the production till sends today.
   *
   * Exactly one of this and `tenders` may be present. Both, or neither, is a
   * client that does not know what it is asking for, and guessing on its
   * behalf is how a sale gets settled twice over.
   */
  readonly cashReceivedMinor?: string | undefined;
  readonly tenders?: readonly CheckoutTenderInput[] | undefined;
  readonly basketDiscount?: CheckoutDiscountInput | undefined;
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

/**
 * The one place the two request shapes become one thing.
 *
 * A second checkout engine for "advanced" payments would be two implementations
 * of the arithmetic that decides what a customer is charged, and they would
 * diverge — quietly, on the path nobody exercises. So the legacy cash figure is
 * turned into a one-line tender list here, at the edge, and everything after
 * this point sees only a tender list.
 */
function normalizePayment(
  input: CheckoutInput,
): readonly CheckoutTenderInput[] | CheckoutFailureReason {
  const hasCash = input.cashReceivedMinor !== undefined;
  const hasTenders = input.tenders !== undefined;

  if (hasCash === hasTenders) return 'ambiguous-payment';
  if (input.tenders !== undefined) return input.tenders;

  const cash = input.cashReceivedMinor ?? '0';
  // A legacy request that handed over nothing is underpaid, which is what it
  // was before this strike. Reporting it as a malformed tender would change a
  // refusal the till already understands.
  if (BigInt(cash) <= 0n) return 'insufficient-cash';
  return [{ kind: 'cash', amountMinor: cash }];
}

/** A requested discount, in the vocabulary the domain prices with. */
function toDomainDiscount(requested: CheckoutDiscountInput): Discount {
  return requested.mode === 'basis-points'
    ? { kind: 'percentage', value: BigInt(requested.value) }
    : { kind: 'fixed', value: BigInt(requested.amountMinor) };
}

/** What the client asked for, canonically, for the intent fingerprint. */
function describeDiscount(requested: CheckoutDiscountInput | undefined): string {
  if (requested === undefined) return '';
  return requested.mode === 'basis-points'
    ? `bp:${String(requested.value)}`
    : `fx:${requested.amountMinor}`;
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
    tenderedMinor: sale.tenderedMinor,
    // From the persisted tender rows, on a fresh sale and on a replay alike.
    // Deriving it from the total would be right only while every sale was
    // cash, which stopped being true with this strike.
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

      const payment = normalizePayment(input);
      if (typeof payment === 'string') return fail(payment);

      const intentHash = fingerprintIntent({
        branchId: shift.branchId,
        terminalId: input.terminalId,
        lines: input.lines.map((line) => ({
          productId: line.productId,
          quantityScaled: line.quantityScaled,
          discount: describeDiscount(line.discount),
        })),
        tenders: payment.map((tender) => ({
          kind: tender.kind,
          amountMinor: tender.amountMinor,
          scheme: tender.kind === 'electronic' ? tender.scheme : '',
          reference: tender.kind === 'electronic' ? tender.reference : '',
        })),
        basketDiscount: describeDiscount(input.basketDiscount),
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
        lines: loaded.map((entry, index): CartLineInput => {
          const requested = input.lines[index]?.discount;
          return {
            lineId: String(index + 1),
            productId: entry.product.id,
            sku: entry.product.sku,
            nameAr: entry.product.nameAr,
            nameEn: entry.product.nameEn,
            unitPrice: money(BigInt(entry.product.priceMinor), currency),
            quantity: quantity(entry.scaled),
            vatRate: basisPoints(entry.product.vatBasisPoints),
            isWeighted: entry.product.productType === 'weighted',
            // Omitted rather than set to undefined: exactOptionalPropertyTypes
            // is on, and an absent key is what "no discount" means there.
            ...(requested === undefined ? {} : { discount: toDomainDiscount(requested) }),
          };
        }),
        ...(input.basketDiscount === undefined
          ? {}
          : { basketDiscount: toDomainDiscount(input.basketDiscount) }),
      };

      // A ceiling says how much; the permission says whether at all. A
      // principal can hold a role-derived ceiling while their persisted
      // permission set omits sale.discount, and permissions are what the
      // server checks (CLAUDE.md, RBAC).
      if (
        (input.basketDiscount !== undefined ||
          input.lines.some((line) => line.discount !== undefined)) &&
        !input.principal.permissions.includes('sale.discount')
      ) {
        return fail('discount-not-authorized');
      }

      const saleId = newId();
      const issuedAt = now().toISOString();
      const discounted =
        input.basketDiscount !== undefined ||
        input.lines.some((line) => line.discount !== undefined);
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
          tenders: payment.map((tender) => toTenderLine(tender, currency)),
          issuedAt,
          // The ceiling comes from the roles the database granted, never from
          // the request. No discount is offered in this strike; passing the
          // real figure keeps the guard live for when one is.
          maxDiscountBasisPoints: maxDiscountForRoles(input.principal.roles),
        });
      } catch (error) {
        // The ceiling is the merchant's policy, and refusing loudly is the
        // point: silently clamping a discount to what was permitted would give
        // the customer a different price from the one the cashier promised.
        if (error instanceof InvalidDiscountError) return fail('invalid-discount');
        if (error instanceof DiscountNotPermittedError) return fail('discount-not-authorized');
        if (error instanceof InvalidTenderError) return fail('invalid-tender');
        // Told apart on purpose. Underpaid is "give me more money"; an
        // electronic overpay is "that card was charged too much", which no
        // amount of cash fixes because only cash can give change back.
        if (error instanceof NonCashChangeError) return fail('electronic-overpay');
        if (error instanceof UnderpaidError) return fail('insufficient-cash');
        if (error instanceof InvalidAmountError) {
          // A cart that priced to nothing is a discount problem, not a
          // quantity one, and the cashier fixes it in a different place.
          return fail(discounted ? 'invalid-discount' : 'invalid-quantity');
        }
        throw error;
      }

      // Belt and braces over the domain's own arithmetic: a sale that does not
      // reconcile must never reach a customer, and the database CHECK that also
      // says so is not a good place to find out.
      if (!saleReconciles(finalized)) {
        throw new Error('The finalized sale does not reconcile; refusing to persist it.');
      }

      const priced = finalized.priced;

      /*
       * Change is drawn from cash and from nowhere else, so it is attributed
       * to the cash tender rather than spread across the list. An electronic
       * row with change on it would describe a card terminal handing money
       * back, which is not a thing that happens — and the database refuses it
       * anyway (tenders_change_cash_only).
       */
      const recordedTenders: TenderRecord[] = payment.map((tender) => ({
        id: newId(),
        kind: tender.kind,
        scheme: tender.kind === 'electronic' ? tender.scheme : null,
        amountMinor: tender.amountMinor,
        changeMinor: tender.kind === 'cash' ? finalized.settlement.change.minor.toString() : '0',
        reference: tender.kind === 'electronic' ? tender.reference : null,
      }));

      /*
       * Cash tendered, less the change handed back. The only part of a sale
       * that reaches the drawer.
       */
      const cashRetainedMinor =
        payment
          .filter((tender) => tender.kind === 'cash')
          .reduce((total, tender) => total + BigInt(tender.amountMinor), 0n) -
        finalized.settlement.change.minor;

      const recordedDiscounts: SaleDiscountRecord[] = [];
      input.lines.forEach((line, index) => {
        const requested = line.discount;
        if (requested === undefined) return;
        const pricedLine = priced.lines[index];
        if (pricedLine === undefined) return;
        recordedDiscounts.push({
          id: newId(),
          scope: 'line',
          lineNumber: index + 1,
          kind: requested.mode === 'basis-points' ? 'percentage' : 'fixed',
          inputValue:
            requested.mode === 'basis-points' ? String(requested.value) : requested.amountMinor,
          amountMinor: pricedLine.lineDiscount.minor.toString(),
          reason: requested.reason ?? null,
          // From the session. A browser that could name the grantor could
          // attribute its own discount to somebody else.
          grantedByUserId: input.principal.userId,
        });
      });

      if (input.basketDiscount !== undefined) {
        const requested = input.basketDiscount;
        recordedDiscounts.push({
          id: newId(),
          scope: 'basket',
          lineNumber: null,
          kind: requested.mode === 'basis-points' ? 'percentage' : 'fixed',
          inputValue:
            requested.mode === 'basis-points' ? String(requested.value) : requested.amountMinor,
          amountMinor: priced.basketDiscountTotal.minor.toString(),
          reason: requested.reason ?? null,
          grantedByUserId: input.principal.userId,
        });
      }

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
            // Enough to explain the receipt years later without replaying
            // today's pricing rules against a catalogue that has moved on:
            // what was asked for, what was granted, and by whom.
            discounts: recordedDiscounts,
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
          // What the drawer actually gained.
          //
          // The sale total was right only while every sale was cash. On a
          // split payment the card settles part of it and never touches the
          // drawer, so recording the total would overstate the till by exactly
          // the electronic portion — and a shift would reconcile short by that
          // amount, every day, with nothing to point at.
          //
          // Null rather than a zero row when nothing was taken in cash: a
          // movement of nothing is a movement that did not happen.
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
            // Money given away and money taken by something other than cash
            // are the two things a merchant reviews. Amounts and schemes only —
            // never a reference, which belongs to somebody else's system.
            discountMinor: (
              priced.lineDiscountTotal.minor + priced.basketDiscountTotal.minor
            ).toString(),
            tenderKinds: recordedTenders
              .map((tender) => (tender.scheme === null ? tender.kind : tender.scheme))
              .sort()
              .join(','),
          },
          occurredAt: issuedAt,
        });

        // discountAudit: a discount is a second fact about the same sale, not a different
        // sale. Emitting it instead of sale.completed would break the
        // invariant that every completed sale emits one, and every report
        // built on that invariant with it.
        if (recordedDiscounts.length > 0) {
          await deps.audit.append(scope, {
            id: newId(),
            actorUserId: input.principal.userId,
            branchId: shift.branchId,
            terminalId: input.terminalId,
            eventType: 'sale.discounted',
            entityType: 'sale',
            entityId: recorded.id,
            metadata: {
              sequence: recorded.sequence,
              discountMinor: (
                priced.lineDiscountTotal.minor + priced.basketDiscountTotal.minor
              ).toString(),
              // Scope and kind, so a manager reviewing give-aways can see the
              // shape of them. No reference, no scheme, no card data.
              scopes: recordedDiscounts
                .map((discount) => discount.scope)
                .sort()
                .join(','),
              grantedByUserId: input.principal.userId,
            },
            occurredAt: issuedAt,
          });
        }
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
