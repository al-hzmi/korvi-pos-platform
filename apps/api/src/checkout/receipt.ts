import { ZatcaFiscalizationError } from '@korvi/domain';
import type { InvoiceRecord, SaleRecord, ZatcaSealedFiscalization } from '@korvi/domain';

export interface CheckoutReceiptLine {
  readonly lineNumber: number;
  readonly description: string;
  readonly quantityScaled: string;
  readonly totalMinor: string;
}

/**
 * Canonical customer receipt facts derived only after fiscal evidence is durable.
 * The Phase-2 QR is copied from the persisted signed artifact; it is never
 * regenerated from client or display state.
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
  readonly qrCodeBase64: string;
}

export function buildCheckoutReceipt(
  sale: SaleRecord,
  invoice: InvoiceRecord,
  fiscalization: ZatcaSealedFiscalization,
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
    throw new ZatcaFiscalizationError('Canonical receipt requires the persisted Phase-2 QR.');
  }

  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    issuedAt: invoice.issuedAt,
    currency: invoice.currency,
    sellerName: fiscalization.seller.registrationName,
    vatRegistrationNumber: fiscalization.seller.vatRegistrationNumber,
    lines: sale.lines.map((line) => ({
      lineNumber: line.lineNumber,
      description: line.nameAr,
      quantityScaled: line.quantityScaled,
      totalMinor: line.totalMinor,
    })),
    netMinor: invoice.netMinor,
    vatMinor: invoice.vatMinor,
    totalMinor: invoice.totalMinor,
    qrCodeBase64: fiscalization.qrCodeBase64,
  };
}
