from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"patch anchor count {count} in {path}: {old[:100]!r}")
    target.write_text(text.replace(old, new))


fiscal = "apps/api/src/zatca/fiscalize-checkout.ts"
replace(
    fiscal,
    "  type ZatcaFiscalizationRepository,\n} from '@korvi/domain';",
    "  type ZatcaFiscalizationRepository,\n  type ZatcaSealedFiscalization,\n} from '@korvi/domain';",
)
replace(
    fiscal,
    "export interface CheckoutFiscalizationPort {\n  fiscalize(scope: TenantScope, sale: SaleRecord, invoice: InvoiceRecord): Promise<void>;\n}",
    "export interface CheckoutFiscalizationPort {\n  fiscalize(\n    scope: TenantScope,\n    sale: SaleRecord,\n    invoice: InvoiceRecord,\n  ): Promise<ZatcaSealedFiscalization | void>;\n}",
)
replace(
    fiscal,
    "        if (existing.state === 'sealed') return;",
    "        if (existing.state === 'sealed') return existing;",
)
replace(
    fiscal,
    "      if (reservation.state === 'sealed') return;",
    "      if (reservation.state === 'sealed') return reservation;",
)
replace(
    fiscal,
    "      await dependencies.repository.seal(scope, {\n        invoiceId: invoice.id,",
    "      return dependencies.repository.seal(scope, {\n        invoiceId: invoice.id,",
)

receipt = Path("apps/api/src/checkout/receipt.ts")
if receipt.exists():
    raise SystemExit("apps/api/src/checkout/receipt.ts already exists")
receipt.write_text(
    """import { ZatcaFiscalizationError } from '@korvi/domain';
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
"""
)

service = "apps/api/src/checkout/service.ts"
replace(
    service,
    "import { fingerprintIntent } from './fingerprint.js';\nimport type { CheckoutFiscalizationPort } from '../zatca/fiscalize-checkout.js';",
    "import { fingerprintIntent } from './fingerprint.js';\nimport { buildCheckoutReceipt } from './receipt.js';\nimport type { CheckoutReceipt } from './receipt.js';\nimport type { CheckoutFiscalizationPort } from '../zatca/fiscalize-checkout.js';",
)
replace(
    service,
    "  TenderScheme,\n  ShiftRepository,",
    "  TenderScheme,\n  ZatcaSealedFiscalization,\n  ShiftRepository,",
)
replace(
    service,
    "export interface CheckoutSuccess {\n  readonly outcome: 'success';\n  /** True when this request replayed an operation id that already completed. */\n  readonly replayed: boolean;\n  readonly sale: SaleSummary;\n}",
    "export interface CheckoutSuccess {\n  readonly outcome: 'success';\n  /** True when this request replayed an operation id that already completed. */\n  readonly replayed: boolean;\n  readonly sale: SaleSummary;\n  /** Null only when fiscalization is deliberately absent in isolated tests. */\n  readonly receipt: CheckoutReceipt | null;\n}",
)
replace(
    service,
    "    await fiscalize(scope, existing, invoice);\n    return {\n      outcome: 'success',\n      replayed: true,\n      sale: summarise(existing, invoice.invoiceNumber, displayName),\n    };",
    "    const fiscalArtifact = await fiscalize(scope, existing, invoice);\n    return {\n      outcome: 'success',\n      replayed: true,\n      sale: summarise(existing, invoice.invoiceNumber, displayName),\n      receipt:\n        fiscalArtifact === null ? null : buildCheckoutReceipt(existing, invoice, fiscalArtifact),\n    };",
)
replace(
    service,
    "  async function fiscalize(\n    scope: TenantScope,\n    sale: SaleRecord,\n    invoice: InvoiceRecord,\n  ): Promise<void> {\n    if (deps.fiscalization !== undefined) {\n      await deps.fiscalization.fiscalize(scope, sale, invoice);\n    }\n  }",
    "  async function fiscalize(\n    scope: TenantScope,\n    sale: SaleRecord,\n    invoice: InvoiceRecord,\n  ): Promise<ZatcaSealedFiscalization | null> {\n    if (deps.fiscalization === undefined) return null;\n    const artifact = await deps.fiscalization.fiscalize(scope, sale, invoice);\n    return artifact ?? null;\n  }",
)
replace(
    service,
    "        await fiscalize(scope, existing, invoice);\n        return {\n          outcome: 'success',\n          replayed: true,\n          sale: summarise(existing, invoice.invoiceNumber, input.principal.displayName),\n        };",
    "        const fiscalArtifact = await fiscalize(scope, existing, invoice);\n        return {\n          outcome: 'success',\n          replayed: true,\n          sale: summarise(existing, invoice.invoiceNumber, input.principal.displayName),\n          receipt:\n            fiscalArtifact === null\n              ? null\n              : buildCheckoutReceipt(existing, invoice, fiscalArtifact),\n        };",
)
replace(
    service,
    "      await fiscalize(scope, recorded, invoice);\n\n      return {\n        outcome: 'success',\n        replayed: false,\n        sale: summarise(recorded, invoice.invoiceNumber, input.principal.displayName),\n      };",
    "      const fiscalArtifact = await fiscalize(scope, recorded, invoice);\n\n      return {\n        outcome: 'success',\n        replayed: false,\n        sale: summarise(recorded, invoice.invoiceNumber, input.principal.displayName),\n        receipt:\n          fiscalArtifact === null ? null : buildCheckoutReceipt(recorded, invoice, fiscalArtifact),\n      };",
)

business = "apps/api/src/routes/business.ts"
replace(
    business,
    ".send({ sale: result.sale, replayed: result.replayed });",
    ".send({ sale: result.sale, receipt: result.receipt, replayed: result.replayed });",
)

fiscal_test = "apps/api/src/__tests__/zatca-checkout-fiscalization.test.ts"
replace(
    fiscal_test,
    "    await fiscalization.fiscalize({ tenantId: tenant }, sale, invoice);\n    await fiscalization.fiscalize({ tenantId: tenant }, sale, invoice);\n\n    expect(reserveCalls).toBe(1);",
    "    const first = await fiscalization.fiscalize({ tenantId: tenant }, sale, invoice);\n    const replay = await fiscalization.fiscalize({ tenantId: tenant }, sale, invoice);\n\n    expect(first).toEqual(replay);\n    expect(first).toMatchObject({ state: 'sealed', qrCodeBase64: 'cXI=' });\n    expect(reserveCalls).toBe(1);",
)

Path("apps/api/src/__tests__/zatca-checkout-receipt.test.ts").write_text(
    """import { describe, expect, it } from 'vitest';
import {
  tenantId,
  type InvoiceRecord,
  type SaleRecord,
  type ZatcaSealedFiscalization,
} from '@korvi/domain';
import { buildCheckoutReceipt } from '../checkout/receipt.js';

const tenant = tenantId('018f1000-0000-7000-8000-00000000000a');
const saleId = '018f1000-0000-7000-8000-0000000000b2';
const invoiceId = '018f1000-0000-7000-8000-0000000000b1';
const terminalId = '018f1000-0000-7000-8000-0000000000a2';

const sale = {
  id: saleId,
  tenantId: tenant,
  terminalId,
  status: 'finalized',
  issuedAt: '2026-09-17T12:00:00Z',
  currency: 'SAR',
  netMinor: '2000',
  vatMinor: '300',
  totalMinor: '2300',
  lines: [
    {
      lineNumber: 1,
      nameAr: 'صنف مختوم',
      quantityScaled: '2000',
      totalMinor: '2300',
    },
  ],
} as SaleRecord;

const invoice = {
  id: invoiceId,
  tenantId: tenant,
  saleId,
  invoiceNumber: 'INV-42',
  invoiceType: 'simplified',
  issuedAt: '2026-09-17T12:00:00Z',
  currency: 'SAR',
  netMinor: '2000',
  vatMinor: '300',
  totalMinor: '2300',
} as InvoiceRecord;

const artifact = {
  scope: { tenantId: tenant },
  invoiceId,
  terminalId,
  invoiceCounterValue: '42',
  previousInvoiceHash: 'YWJjZA==',
  seller: {
    registrationName: 'Merchant Snapshot',
    vatRegistrationNumber: '300000000000003',
    legalId: '1010123456',
    legalIdScheme: 'CRN',
    streetName: 'King Road',
    buildingNumber: '1234',
    citySubdivisionName: 'Olaya',
    cityName: 'Riyadh',
    postalZone: '12345',
    countryCode: 'SA',
  },
  reservedAt: '2026-09-17T12:00:01Z',
  state: 'sealed',
  invoiceHash: new Uint8Array(32),
  sealedInvoiceXml: new TextEncoder().encode('<Invoice>sealed</Invoice>'),
  qrCodeBase64: 'PERSISTED_PHASE_2_QR',
  signatureValueBase64: 'c2ln',
  sealedAt: '2026-09-17T12:00:01Z',
} satisfies ZatcaSealedFiscalization;

describe('canonical checkout receipt', () => {
  it('uses the persisted sealed fiscal artifact instead of inventing QR or seller truth', () => {
    expect(buildCheckoutReceipt(sale, invoice, artifact)).toEqual({
      invoiceId,
      invoiceNumber: 'INV-42',
      issuedAt: '2026-09-17T12:00:00Z',
      currency: 'SAR',
      sellerName: 'Merchant Snapshot',
      vatRegistrationNumber: '300000000000003',
      lines: [
        {
          lineNumber: 1,
          description: 'صنف مختوم',
          quantityScaled: '2000',
          totalMinor: '2300',
        },
      ],
      netMinor: '2000',
      vatMinor: '300',
      totalMinor: '2300',
      qrCodeBase64: 'PERSISTED_PHASE_2_QR',
    });
  });

  it('refuses evidence belonging to a different invoice', () => {
    expect(() =>
      buildCheckoutReceipt(sale, invoice, { ...artifact, invoiceId: 'other-invoice' }),
    ).toThrow(/does not belong/);
  });
});
"""
)
