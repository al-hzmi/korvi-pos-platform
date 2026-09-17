import { describe, expect, it } from 'vitest';
import { cartReducer, cartToRequestLines } from '../lib/cart';
import { quickServiceOrderNumber } from '../lib/quick-service';
import {
  preparationTicketFromIntent,
  renderPreparationTicketEscPos,
} from '../lib/preparation-ticket';
import { isOfflineSaleDraft } from '../lib/offline-store';
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
        priceMode: 'tax-inclusive',
        updatedAt: '2026-09-18T00:00:00.000Z',
      }),
    ).toBe(true);
    expect(cartToRequestLines(lines)).toEqual([{ productId: PRODUCT.id, quantityScaled: '1000' }]);
  });

  it('renders a separate non-fiscal prep ticket without QR or financial fields', () => {
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
      items: [{ nameAr: 'ساندويتش', options: 'بدون بصل', note: 'تغليف منفصل' }],
    });
    expect('invoiceNumber' in ticket).toBe(false);
    expect('vatMinor' in ticket).toBe(false);
    expect('qrCodeBase64' in ticket).toBe(false);

    const payload = renderPreparationTicketEscPos(ticket).payload;
    const hasQrCommand = payload.some(
      (byte, index) => byte === 0x1d && payload[index + 1] === 0x28 && payload[index + 2] === 0x6b,
    );
    expect(hasQrCommand).toBe(false);
  });
});
