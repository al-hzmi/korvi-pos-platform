import { describe, expect, it } from 'vitest';
import { cartReducer, cartToRequestLines } from '../lib/cart';
import { quickServiceOrderNumber } from '../lib/quick-service';
import { preparationTicketFromIntent } from '../lib/preparation-ticket';
import { renderPreparationTicketEscPos } from '../lib/preparation-ticket-print';
import { isOfflineSaleDraft } from '../lib/offline-store';
import { checkoutQueueOperation } from '../lib/offline-checkout';
import type { ProductSummary } from '../lib/api-types';

const PRODUCT: ProductSummary = {
  id: '018f1000-0000-7000-8000-000000000111',
  sku: 'QS-1',
  nameAr: 'ساندويتش',
  nameEn: null,
  productType: 'unit',
  unitLabel: 'each',
  priceMinor: '1200',
  vatBasisPoints: 1500,
  primaryBarcode: null,
  trackInventory: true,
  categoryId: '018f1000-0000-7000-8000-000000000112',
  categoryNameAr: 'الساندويتشات',
  categorySortOrder: 1,
  imageUrl: 'https://example.test/qs-1.jpg',
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

describe('Quick-Service operational state', () => {
  it('derives the same order number from the same financial operation', () => {
    const operationId = '018f1000-0000-7000-8000-000000000123';
    expect(quickServiceOrderNumber(operationId, 'K01')).toBe(
      quickServiceOrderNumber(operationId, 'K01'),
    );
    expect(quickServiceOrderNumber(operationId, 'K01')).toBe('K01-00000123');
  });

  it('keeps preparation notes and options out of the checkout authority payload', () => {
    let lines = cartReducer([], { type: 'add', product: PRODUCT });
    lines = cartReducer(lines, {
      type: 'set-preparation',
      productId: PRODUCT.id,
      note: 'تغليف منفصل',
      options: 'بدون بصل',
    });

    expect(lines[0]).toMatchObject({
      preparationNote: 'تغليف منفصل',
      preparationOptions: 'بدون بصل',
    });
    expect(cartToRequestLines(lines)).toEqual([{ productId: PRODUCT.id, quantityScaled: '1000' }]);
  });

  it('accepts preparation metadata in the durable restart draft without changing sale intent', () => {
    let lines = cartReducer([], { type: 'add', product: PRODUCT });
    lines = cartReducer(lines, {
      type: 'set-preparation',
      productId: PRODUCT.id,
      note: 'بعد عشر دقائق',
      options: 'حار',
    });
    expect(
      isOfflineSaleDraft({
        lines,
        cash: '15',
        orderType: 'dine-in',
        tableId: '018f1000-0000-7000-8000-000000000126',
        priceMode: 'tax-inclusive',
        updatedAt: '2026-09-18T00:00:00.000Z',
      }),
    ).toBe(true);
    expect(cartToRequestLines(lines)).toEqual([{ productId: PRODUCT.id, quantityScaled: '1000' }]);
  });

  it('rasterizes Arabic prep text, stays non-fiscal, and reprints without mutating sale truth', async () => {
    let lines = cartReducer([], { type: 'add', product: PRODUCT });
    lines = cartReducer(lines, {
      type: 'set-preparation',
      productId: PRODUCT.id,
      note: 'تغليف منفصل',
      options: 'بدون بصل',
    });
    const intent = {
      operationId: '018f1000-0000-7000-8000-000000000123',
      terminalId: '018f1000-0000-7000-8000-000000000124',
      expectedShiftId: '018f1000-0000-7000-8000-000000000125',
      orderType: 'dine-in' as const,
      tableId: '018f1000-0000-7000-8000-000000000126',
      cashReceivedMinor: '1500',
      lines: [{ productId: PRODUCT.id, quantityScaled: '1000' }],
    };
    const ticket = preparationTicketFromIntent(
      intent,
      lines,
      quickServiceOrderNumber(intent.operationId, 'K01'),
      '2026-09-18T00:00:00.000Z',
    );

    expect(ticket).toMatchObject({
      kind: 'preparation',
      sourceOperationId: intent.operationId,
      orderNumber: 'K01-00000123',
      orderType: 'dine-in',
      items: [{ nameAr: 'ساندويتش', options: 'بدون بصل', note: 'تغليف منفصل' }],
    });
    expect('invoiceNumber' in ticket).toBe(false);
    expect('vatMinor' in ticket).toBe(false);
    expect('qrCodeBase64' in ticket).toBe(false);

    const before = JSON.stringify(ticket);
    const raster = captureRasterRenderer();
    const first = await renderPreparationTicketEscPos(ticket, raster.renderer);
    const second = await renderPreparationTicketEscPos(ticket, raster.renderer);
    const payload = first.payload;
    const encoder = new TextEncoder();

    expect(raster.lines).toEqual(
      expect.arrayContaining([
        'تذكرة تحضير - غير ضريبية',
        'نوع الطلب: محلي',
        '1 x ساندويتش',
        'خيارات: بدون بصل',
        'ملاحظة: تغليف منفصل',
      ]),
    );
    expect(containsBytes(payload, Uint8Array.from([0x1d, 0x76, 0x30, 0x00]))).toBe(true);
    expect(containsBytes(payload, encoder.encode('ORDER K01-00000123'))).toBe(true);
    expect(containsBytes(payload, encoder.encode('NON-FISCAL / PREPARATION'))).toBe(true);

    const hasQrCommand = payload.some(
      (byte, index) => byte === 0x1d && payload[index + 1] === 0x28 && payload[index + 2] === 0x6b,
    );
    expect(hasQrCommand).toBe(false);
    for (const forbidden of ['VAT', 'Invoice', 'ICV', 'PIH']) {
      expect(containsBytes(payload, encoder.encode(forbidden))).toBe(false);
    }

    expect(second.payload).toEqual(first.payload);
    expect(JSON.stringify(ticket)).toBe(before);
    expect(ticket.sourceOperationId).toBe(intent.operationId);

    const queued = checkoutQueueOperation(intent);
    expect(queued.payload).toMatchObject({
      orderType: 'dine-in',
      tableId: '018f1000-0000-7000-8000-000000000126',
    });
  });
});
