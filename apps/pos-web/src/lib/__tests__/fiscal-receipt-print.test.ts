import { describe, expect, it } from 'vitest';
import { renderFiscalReceiptEscPos } from '../fiscal-receipt-print';
import type { FiscalReceipt, SaleSummary } from '../api-types';

const sale: SaleSummary = {
  saleId: '018f1000-0000-7000-8000-0000000000c1',
  operationId: '018f1000-0000-7000-8000-0000000000c2',
  sequence: 42,
  invoiceNumber: 'INV-42',
  issuedAt: '2026-09-17T12:00:00Z',
  currency: 'SAR',
  branchId: '018f1000-0000-7000-8000-0000000000c3',
  terminalId: '018f1000-0000-7000-8000-0000000000c4',
  shiftId: '018f1000-0000-7000-8000-0000000000c5',
  cashierName: 'Cashier',
  lines: [
    {
      lineNumber: 1,
      productId: '018f1000-0000-7000-8000-0000000000c6',
      sku: 'SKU-1',
      nameAr: 'ساندويتش دجاج',
      quantityScaled: '1000',
      unitPriceMinor: '2300',
      netMinor: '2000',
      vatMinor: '300',
      totalMinor: '2300',
    },
  ],
  netMinor: '2000',
  vatMinor: '300',
  totalMinor: '2300',
  cashReceivedMinor: '2500',
  changeMinor: '200',
};

const receipt: FiscalReceipt = {
  invoiceId: '018f1000-0000-7000-8000-0000000000d1',
  invoiceNumber: 'INV-42',
  issuedAt: '2026-09-17T12:00:00Z',
  currency: 'SAR',
  sellerName: 'متجر كورفي',
  vatRegistrationNumber: '300000000000003',
  lines: [
    {
      lineNumber: 1,
      description: 'ساندويتش دجاج',
      quantityScaled: '1000',
      totalMinor: '2300',
    },
  ],
  netMinor: '2000',
  vatMinor: '300',
  totalMinor: '2300',
  invoiceHashBase64: 'AQID',
  qrCodeBase64: 'PERSISTED_PHASE_2_QR_123+/=',
  fiscalizationMode: 'production',
  disclaimer: null,
};

function containsBytes(haystack: readonly number[], needle: Uint8Array): boolean {
  outer: for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

function captureRasterRenderer() {
  const lines: string[] = [];
  return {
    lines,
    renderer: {
      async renderLine(text: string) {
        lines.push(text);
        return { width: 8, height: 1, data: Uint8Array.from([0x80]) };
      },
    },
  };
}

describe('fiscal receipt ESC/POS rendering', () => {
  it('keeps canonical Arabic merchant/item facts and the exact persisted Phase-2 QR', async () => {
    const raster = captureRasterRenderer();
    const { payload } = await renderFiscalReceiptEscPos(sale, receipt, raster.renderer);
    const encoder = new TextEncoder();

    expect(raster.lines).toEqual(
      expect.arrayContaining([
        'متجر كورفي',
        'ساندويتش دجاج',
        'الرقم الضريبي: 300000000000003',
        'فاتورة ضريبية مبسطة',
      ]),
    );
    expect(containsBytes(payload, Uint8Array.from([0x1d, 0x76, 0x30, 0x00]))).toBe(true);
    expect(containsBytes(payload, Uint8Array.from([0x1d, 0x28, 0x6b]))).toBe(true);
    expect(containsBytes(payload, encoder.encode(receipt.qrCodeBase64))).toBe(true);
    expect(containsBytes(payload, encoder.encode(`QR ${receipt.qrCodeBase64}`))).toBe(false);
    expect(containsBytes(payload, encoder.encode(`Hash ${receipt.invoiceHashBase64}`))).toBe(true);
  });

  it('refuses to combine fiscal evidence with a different finalized sale', async () => {
    const raster = captureRasterRenderer();
    await expect(
      renderFiscalReceiptEscPos({ ...sale, invoiceNumber: 'INV-OTHER' }, receipt, raster.renderer),
    ).rejects.toThrow(/does not match/);
  });

  it('prints a simulation receipt with an unmistakable non-tax label', async () => {
    const raster = captureRasterRenderer();
    const simulation = {
      ...receipt,
      fiscalizationMode: 'simulation' as const,
      disclaimer: 'SIMULATION / NOT FOR TAX USE',
    };
    const { payload } = await renderFiscalReceiptEscPos(sale, simulation, raster.renderer);

    expect(containsBytes(payload, new TextEncoder().encode('SIMULATION / NOT FOR TAX USE'))).toBe(
      true,
    );
    expect(raster.lines).toContain('إيصال محاكاة — غير صالح للاستخدام الضريبي');
    expect(raster.lines).not.toContain('فاتورة ضريبية مبسطة');
  });

  it('refuses missing QR or invoice-hash evidence instead of printing fake success', async () => {
    const raster = captureRasterRenderer();
    await expect(
      renderFiscalReceiptEscPos(sale, { ...receipt, qrCodeBase64: ' ' }, raster.renderer),
    ).rejects.toThrow(/missing evidence/);
    await expect(
      renderFiscalReceiptEscPos(sale, { ...receipt, invoiceHashBase64: '' }, raster.renderer),
    ).rejects.toThrow(/missing evidence/);
  });
});
