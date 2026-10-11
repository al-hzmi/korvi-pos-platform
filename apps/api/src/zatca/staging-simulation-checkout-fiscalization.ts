import { createHash } from 'node:crypto';
import { ZatcaFiscalizationError, bytesToBase64 } from '@korvi/domain';
import {
  ZATCA_SIMULATION_DISCLAIMER,
  type CheckoutFiscalizationPort,
  type CheckoutSimulationFiscalization,
} from './fiscalize-checkout.js';

/**
 * Non-authoritative staging artifact for checkout/demos only.
 *
 * It deliberately has no repository, CSID, signing-key, Azure, or FATOORA
 * dependency. The deterministic payload is visibly non-tax evidence and can
 * never be mistaken by the type system for a sealed production fiscalization.
 */
export function createStagingSimulationCheckoutFiscalization(): CheckoutFiscalizationPort {
  return {
    async fiscalize(scope, sale, invoice) {
      if (sale.tenantId !== scope.tenantId || invoice.tenantId !== scope.tenantId) {
        throw new ZatcaFiscalizationError('Simulation fiscalization refuses cross-tenant truth.');
      }
      if (sale.status !== 'finalized' || invoice.saleId !== sale.id) {
        throw new ZatcaFiscalizationError(
          'Simulation fiscalization requires the durable invoice for the finalized sale.',
        );
      }

      const artifact = new TextEncoder().encode(
        JSON.stringify({
          mode: 'SIMULATION',
          notice: 'NOT FOR TAX USE',
          tenantId: scope.tenantId,
          saleId: sale.id,
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          terminalId: sale.terminalId,
          issuedAt: invoice.issuedAt,
          totalMinor: invoice.totalMinor,
          currency: invoice.currency,
        }),
      );
      const artifactHash = Uint8Array.from(createHash('sha256').update(artifact).digest());

      const result: CheckoutSimulationFiscalization = {
        state: 'simulation',
        scope,
        invoiceId: invoice.id,
        terminalId: sale.terminalId,
        sellerName: invoice.sellerName,
        vatRegistrationNumber: invoice.sellerVatNumber,
        generatedAt: invoice.issuedAt,
        artifact,
        artifactHash,
        qrCodeBase64: bytesToBase64(artifact),
        disclaimer: ZATCA_SIMULATION_DISCLAIMER,
      };
      return result;
    },
  };
}
