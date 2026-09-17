import {
  ZatcaFiscalizationError,
  type InvoiceRecord,
  type SaleRecord,
  type TenantScope,
  type ZatcaFiscalizationRepository,
} from '@korvi/domain';
import type { ZatcaSimplifiedInvoiceSealer } from './seal-simplified-invoice.js';

export interface CheckoutFiscalizationPort {
  fiscalize(scope: TenantScope, sale: SaleRecord, invoice: InvoiceRecord): Promise<void>;
}

export interface CheckoutFiscalizationDependencies {
  readonly repository: ZatcaFiscalizationRepository;
  readonly sealer: ZatcaSimplifiedInvoiceSealer;
  readonly now?: () => Date;
}

export function createCheckoutFiscalizationPort(
  dependencies: CheckoutFiscalizationDependencies,
): CheckoutFiscalizationPort {
  const now = dependencies.now ?? (() => new Date());

  return {
    async fiscalize(scope, sale, invoice) {
      assertSameFiscalSale(scope, sale, invoice);
      const existing = await dependencies.repository.findByInvoice(scope, invoice.id);
      if (existing !== null) {
        if (existing.terminalId !== sale.terminalId) {
          throw new ZatcaFiscalizationError(
            'Persisted fiscalization belongs to a different sale terminal.',
          );
        }
        if (existing.state === 'sealed') return;
      }

      const reservation =
        existing ??
        (await dependencies.repository.reserve(scope, {
          invoiceId: invoice.id,
          terminalId: sale.terminalId,
          reservedAt: exactUtcSecond(now(), sale.issuedAt),
        }));
      if (reservation.state === 'sealed') return;

      const sealed = await dependencies.sealer.seal({
        scope,
        terminalId: sale.terminalId,
        stampingTime: reservation.reservedAt,
        invoice: {
          sale,
          invoice,
          seller: reservation.seller,
          invoiceCounterValue: reservation.invoiceCounterValue,
          previousInvoiceHash: reservation.previousInvoiceHash,
        },
      });

      await dependencies.repository.seal(scope, {
        invoiceId: invoice.id,
        terminalId: sale.terminalId,
        invoiceHash: sealed.invoiceHash,
        sealedInvoiceXml: new TextEncoder().encode(sealed.xml),
        qrCodeBase64: sealed.qrCodeBase64,
        signatureValueBase64: sealed.signatureValueBase64,
        sealedAt: reservation.reservedAt,
      });
    },
  };
}

function assertSameFiscalSale(scope: TenantScope, sale: SaleRecord, invoice: InvoiceRecord): void {
  if (sale.tenantId !== scope.tenantId || invoice.tenantId !== scope.tenantId) {
    throw new ZatcaFiscalizationError('Checkout fiscalization refuses cross-tenant truth.');
  }
  if (sale.status !== 'finalized' || invoice.saleId !== sale.id) {
    throw new ZatcaFiscalizationError(
      'Checkout fiscalization requires the durable invoice for the finalized sale.',
    );
  }
}

function exactUtcSecond(now: Date, issuedAt: string): string {
  const nowMs = now.getTime();
  const issuedMs = Date.parse(issuedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(issuedMs)) {
    throw new ZatcaFiscalizationError('Checkout fiscalization timestamp is invalid.');
  }
  const second = Math.max(Math.floor(nowMs / 1_000), Math.floor(issuedMs / 1_000)) * 1_000;
  return new Date(second).toISOString().replace('.000Z', 'Z');
}
