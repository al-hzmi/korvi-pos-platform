import { ZatcaFiscalizationError, bytesToBase64 } from '@korvi/domain';
import type { InvoiceRecord, SaleRecord } from '@korvi/domain';
import type { CheckoutFiscalizationArtifact } from '../zatca/fiscalize-checkout.js';

export interface CheckoutReceiptLine {
  readonly lineNumber: number;
  readonly description: string;
  readonly quantityScaled: string;
  readonly totalMinor: string;
}

/**
 * Server-authored receipt facts derived after fiscalization.
 * Production evidence comes only from the persisted signed artifact; staging
 * simulation evidence remains a separate, explicitly non-tax artifact.
 */
export interface CheckoutReceipt {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly issuedAt: string;
  readonly currency: string;
  readonly sellerName: string;
  readonly vatRegistrationNumber: string;
  readonly lines: readonly CheckoutReceiptLine[];
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly invoiceHashBase64: string;
  readonly qrCodeBase64: string;
  readonly fiscalizationMode: 'production' | 'simulation';
  readonly disclaimer: string | null;
}

export function buildCheckoutReceipt(
  sale: SaleRecord,
  invoice: InvoiceRecord,
  fiscalization: CheckoutFiscalizationArtifact,
): CheckoutReceipt {
  if (
    invoice.saleId !== sale.id ||
    fiscalization.invoiceId !== invoice.id ||
    fiscalization.terminalId !== sale.terminalId
  ) {
    throw new ZatcaFiscalizationError(
      'Canonical receipt refuses fiscal evidence that does not belong to this finalized sale.',
    );
  }
  if (sale.status !== 'finalized' || invoice.invoiceType !== 'simplified') {
    throw new ZatcaFiscalizationError(
      'Canonical receipt requires a finalized sale and its simplified fiscal invoice.',
    );
  }
  if (fiscalization.qrCodeBase64.trim() === '') {
    throw new ZatcaFiscalizationError('Canonical receipt requires fiscal evidence.');
  }

  const simulation = fiscalization.state === 'simulation';

  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    issuedAt: invoice.issuedAt,
    currency: invoice.currency,
    sellerName: simulation ? fiscalization.sellerName : fiscalization.seller.registrationName,
    vatRegistrationNumber: simulation
      ? fiscalization.vatRegistrationNumber
      : fiscalization.seller.vatRegistrationNumber,
    lines: sale.lines.map((line) => ({
      lineNumber: line.lineNumber,
      description: line.nameAr,
      quantityScaled: line.quantityScaled,
      totalMinor: line.totalMinor,
    })),
    netMinor: invoice.netMinor,
    vatMinor: invoice.vatMinor,
    totalMinor: invoice.totalMinor,
    invoiceHashBase64: bytesToBase64(
      simulation ? fiscalization.artifactHash : fiscalization.invoiceHash,
    ),
    qrCodeBase64: fiscalization.qrCodeBase64,
    fiscalizationMode: simulation ? 'simulation' : 'production',
    disclaimer: simulation ? fiscalization.disclaimer : null,
  };
}
