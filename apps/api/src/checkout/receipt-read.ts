import { tenantId as brandTenantId } from '@korvi/domain';
import { buildCheckoutReceipt } from './receipt.js';
import type { CheckoutReceipt } from './receipt.js';
import type {
  AuthenticatedPrincipal,
  SaleRepository,
  TenantScope,
  ZatcaFiscalizationRepository,
} from '@korvi/domain';

export interface HistoricalFiscalSale {
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
  readonly lines: readonly {
    readonly lineNumber: number;
    readonly productId: string | null;
    readonly sku: string;
    readonly nameAr: string;
    readonly quantityScaled: string;
    readonly unitPriceMinor: string;
    readonly netMinor: string;
    readonly vatMinor: string;
    readonly totalMinor: string;
  }[];
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly cashReceivedMinor: string;
  readonly changeMinor: string;
}

export type FiscalReceiptReadResult =
  | {
      readonly outcome: 'success';
      readonly sale: HistoricalFiscalSale;
      readonly receipt: CheckoutReceipt;
    }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'not-sealed' };

export interface FiscalReceiptReadService {
  read(
    principal: AuthenticatedPrincipal,
    saleId: string,
    authoritativeTerminalId: string,
  ): Promise<FiscalReceiptReadResult>;
}

export interface FiscalReceiptReadDeps {
  readonly sales: Pick<SaleRepository, 'findById' | 'invoiceForSale'>;
  readonly fiscalizations: Pick<ZatcaFiscalizationRepository, 'findByInvoice'>;
}

/**
 * Historical fiscal receipt read authority.
 *
 * This service is structurally read-only: its dependencies expose only three
 * reads. It cannot checkout, reserve an ICV, advance PIH, seal, mutate stock,
 * touch payment, or write accounting truth. A reprint therefore always means
 * "read the existing finalized facts, render them again".
 */
export function createFiscalReceiptReadService(
  deps: FiscalReceiptReadDeps,
): FiscalReceiptReadService {
  return {
    async read(principal, saleId, authoritativeTerminalId) {
      const boundTerminal = principal.terminalId;
      if (
        boundTerminal !== undefined &&
        boundTerminal !== null &&
        boundTerminal !== authoritativeTerminalId
      ) {
        return { outcome: 'not-found' };
      }

      const scope: TenantScope = { tenantId: brandTenantId(principal.tenantId) };
      const sale = await deps.sales.findById(scope, saleId);

      // Deliberately collapse every ownership failure to not-found. Tenant RLS
      // is the outer boundary; branch, terminal and cashier ownership are the
      // inner boundary. None of those should become an enumeration oracle.
      if (
        sale === null ||
        sale.status !== 'finalized' ||
        principal.branchId === null ||
        sale.branchId !== principal.branchId ||
        sale.terminalId !== authoritativeTerminalId ||
        sale.userId !== principal.userId
      ) {
        return { outcome: 'not-found' };
      }

      const invoice = await deps.sales.invoiceForSale(scope, sale.id);
      if (invoice === null) return { outcome: 'not-sealed' };

      const fiscalization = await deps.fiscalizations.findByInvoice(scope, invoice.id);
      if (fiscalization === null || fiscalization.state !== 'sealed') {
        return { outcome: 'not-sealed' };
      }

      const cashReceivedMinor = sale.tenders
        .filter((tender) => tender.kind === 'cash')
        .reduce((total, tender) => total + BigInt(tender.amountMinor), 0n)
        .toString();

      return {
        outcome: 'success',
        sale: {
          saleId: sale.id,
          operationId: sale.operationId,
          sequence: sale.sequence,
          invoiceNumber: invoice.invoiceNumber,
          issuedAt: sale.issuedAt,
          currency: sale.currency,
          branchId: sale.branchId,
          terminalId: sale.terminalId,
          shiftId: sale.shiftId,
          cashierName: principal.displayName,
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
          cashReceivedMinor,
          changeMinor: sale.changeMinor,
        },
        receipt: buildCheckoutReceipt(sale, invoice, fiscalization),
      };
    },
  };
}
