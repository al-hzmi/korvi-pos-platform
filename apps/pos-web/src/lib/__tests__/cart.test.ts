import { describe, expect, it } from 'vitest';
import { cartReducer, cartToRequestLines, previewCart } from '../cart';
import type { CartLine } from '../cart';
import type { ProductSummary } from '../api-types';

const MILK: ProductSummary = {
  id: 'p-milk',
  sku: 'MILK-1L',
  nameAr: 'حليب طازج',
  nameEn: 'Fresh milk',
  productType: 'unit',
  unitLabel: null,
  priceMinor: '1150',
  vatBasisPoints: 1500,
  primaryBarcode: '6281000000001',
  trackInventory: true,
};

const RICE: ProductSummary = {
  ...MILK,
  id: 'p-rice',
  sku: 'RICE-5K',
  nameAr: 'أرز بسمتي',
  nameEn: 'Basmati rice',
  productType: 'weighted',
  unitLabel: 'كجم',
  priceMinor: '2400',
  primaryBarcode: '6281000000002',
};

function build(actions: readonly Parameters<typeof cartReducer>[1][]): readonly CartLine[] {
  return actions.reduce<readonly CartLine[]>((lines, action) => cartReducer(lines, action), []);
}

describe('the cart', () => {
  it('adds a product as one unit', () => {
    const lines = build([{ type: 'add', product: MILK }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.quantityScaled).toBe('1000');
  });

  it('merges a repeated add into the line that exists', () => {
    // The server refuses two lines for one product, and rightly: each would
    // pass a stock check their sum fails.
    const lines = build([
      { type: 'add', product: MILK },
      { type: 'add', product: RICE },
      { type: 'add', product: MILK },
      { type: 'add', product: MILK },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.find((line) => line.productId === 'p-milk')?.quantityScaled).toBe('3000');
    expect(new Set(lines.map((line) => line.productId)).size).toBe(lines.length);
  });

  it('steps a unit line up and down without falling below one', () => {
    const lines = build([
      { type: 'add', product: MILK },
      { type: 'step', productId: 'p-milk', direction: 1 },
      { type: 'step', productId: 'p-milk', direction: -1 },
      { type: 'step', productId: 'p-milk', direction: -1 },
    ]);
    expect(lines[0]?.quantityScaled).toBe('1000');
  });

  it('will not step a weighed line at all', () => {
    // The screen does not offer the controls; this makes the action inert, so
    // a future caller cannot resurrect a minus button that doubles 0.500 kg.
    const lines = build([
      { type: 'add', product: RICE },
      { type: 'set-quantity', productId: 'p-rice', quantityScaled: '500' },
      { type: 'step', productId: 'p-rice', direction: -1 },
      { type: 'step', productId: 'p-rice', direction: 1 },
    ]);
    expect(lines[0]?.quantityScaled).toBe('500');
  });

  it('takes an explicit weighed quantity', () => {
    const lines = build([
      { type: 'add', product: RICE },
      { type: 'set-quantity', productId: 'p-rice', quantityScaled: '1250' },
    ]);
    expect(lines[0]?.quantityScaled).toBe('1250');
  });

  it('removes and clears', () => {
    const lines = build([
      { type: 'add', product: MILK },
      { type: 'add', product: RICE },
      { type: 'remove', productId: 'p-milk' },
    ]);
    expect(lines.map((line) => line.productId)).toEqual(['p-rice']);
    expect(cartReducer(lines, { type: 'clear' })).toEqual([]);
  });

  it('sends ids and quantities and nothing else', () => {
    const lines = build([{ type: 'add', product: MILK }]);
    expect(Object.keys(cartToRequestLines(lines)[0] ?? {}).sort()).toEqual([
      'productId',
      'quantityScaled',
    ]);
  });
});

describe('the preview', () => {
  it('prices two litres of milk exactly, tax-inclusive', () => {
    // 2 x 11.50 tax-inclusive: total 23.00, net 20.00, VAT 3.00. The same
    // arithmetic the server runs, because it is literally the same function.
    const lines = build([
      { type: 'add', product: MILK },
      { type: 'add', product: MILK },
    ]);
    const preview = previewCart(lines, 'tax-inclusive');
    expect(preview.total.minor).toBe(2300n);
    expect(preview.net.minor).toBe(2000n);
    expect(preview.vat.minor).toBe(300n);
  });

  it('prices the same catalogue price differently when the tenant sells tax-exclusive', () => {
    // 10.00 at 15% exclusive is 11.50 due. Hardcoding tax-inclusive here would
    // have shown 10.00 and short-changed the drawer by the VAT on every sale.
    const exclusive: ProductSummary = { ...MILK, priceMinor: '1000' };
    const lines = build([{ type: 'add', product: exclusive }]);

    const preview = previewCart(lines, 'tax-exclusive');
    expect(preview.net.minor).toBe(1000n);
    expect(preview.vat.minor).toBe(150n);
    expect(preview.total.minor).toBe(1150n);

    // The same basket under the other mode is a different total, which is the
    // whole reason the mode may not be guessed.
    expect(previewCart(lines, 'tax-inclusive').total.minor).toBe(1000n);
  });

  it('prices a weighed line by the scaled quantity', () => {
    const lines = build([
      { type: 'add', product: RICE },
      { type: 'set-quantity', productId: 'p-rice', quantityScaled: '1500' },
    ]);
    expect(previewCart(lines, 'tax-inclusive').total.minor).toBe(3600n);
  });

  it('totals an empty cart at zero rather than failing', () => {
    expect(previewCart([], 'tax-inclusive').total.minor).toBe(0n);
  });
});
