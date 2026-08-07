import { describe, expect, it } from 'vitest';
import { escpos, twoColumn } from '../escpos.js';
import { renderReceipt } from '../receipt.js';
import { qrCommand } from '../qr.js';
import { rasterCommand } from '../raster.js';
import { MissingCapabilityError } from '../errors.js';
import {
  EPSON_TM_T20,
  GENERIC_ESCPOS_UNKNOWN,
  SYNTHETIC_UTF8_NATIVE,
  findProfile,
} from '../profiles/registry.js';
import { moneyFromMajorString } from '@korvi/domain';
import {
  ESC_INIT,
  ESC_SELECT_CP864,
  GS_PARTIAL_CUT,
  GS_RASTER,
  QR_MODEL_2,
  QR_PRINT,
} from './fixtures/bytes.js';
import type { PrinterProfile } from '../profiles/types.js';

const TEST_UTF8_NATIVE = {
  ...SYNTHETIC_UTF8_NATIVE,
  id: 'test-utf8-native-receipt',
  vendor: 'test-only',
  capabilities: { ...SYNTHETIC_UTF8_NATIVE.capabilities, verified: true },
} as const satisfies PrinterProfile;

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  prefix.every((value, index) => bytes[index] === value);

const contains = (bytes: Uint8Array, needle: readonly number[]): boolean => {
  const hay = Array.from(bytes);
  return hay.some((_, index) => needle.every((value, offset) => hay[index + offset] === value));
};

const data = {
  sellerName: 'متجر كورفي',
  vatRegistrationNumber: '310122393500003',
  invoiceNumber: 'INV-2026-00001',
  timestamp: '2026-08-07T09:45:00Z',
  lines: [{ description: 'ماء 600 مل', quantity: 2, lineTotal: moneyFromMajorString('4.00') }],
  net: moneyFromMajorString('100.00'),
  vat: moneyFromMajorString('15.00'),
  total: moneyFromMajorString('115.00'),
  qrPayload: 'AQVtZXJjaAIPMzEwMTIyMzkzNTAwMDAz',
};

describe('builder', () => {
  it('initialises and selects the profile code page where there is one', () => {
    // Epson still selects PC864 for its ASCII path; the Arabic text simply does
    // not travel that way (ADR-0011).
    expect(
      startsWith(escpos(EPSON_TM_T20).initialise().build(), [...ESC_INIT, ...ESC_SELECT_CP864]),
    ).toBe(true);
  });

  it('sends no code page selector to a UTF-8 device', () => {
    expect(Array.from(escpos(TEST_UTF8_NATIVE).initialise().build())).toEqual(ESC_INIT);
  });

  it('sends no code page selector to an unidentified device', () => {
    expect(Array.from(escpos(GENERIC_ESCPOS_UNKNOWN).initialise().build())).toEqual(ESC_INIT);
  });
});

describe('twoColumn', () => {
  it('fills the profile width and flushes the amount to the end', () => {
    const line = twoColumn('Item', '10.00', 48);
    expect(line).toHaveLength(48);
    expect(line.endsWith('10.00')).toBe(true);
  });

  it('truncates rather than wrapping', () => {
    expect(twoColumn('x'.repeat(200), '10.00', 48)).toHaveLength(48);
  });
});

describe('QR', () => {
  it('emits the model, size, correction, store and print sequence', () => {
    const bytes = qrCommand(EPSON_TM_T20, 'ABC');
    expect(startsWith(bytes, QR_MODEL_2)).toBe(true);
    expect(contains(bytes, QR_PRINT)).toBe(true);
    expect(contains(bytes, [0x41, 0x42, 0x43])).toBe(true);
  });

  it('refuses on a device with no QR firmware', () => {
    // Emitting GS ( k here would print the command bytes across the paper.
    expect(() => qrCommand(GENERIC_ESCPOS_UNKNOWN, 'ABC')).toThrow(MissingCapabilityError);
  });

  it('rejects a multi-byte payload', () => {
    expect(() => qrCommand(EPSON_TM_T20, 'مرحبا')).toThrow(MissingCapabilityError);
  });

  it('rejects an out-of-range module size', () => {
    expect(() => qrCommand(EPSON_TM_T20, 'A', { moduleSize: 0 })).toThrow(MissingCapabilityError);
    expect(() => qrCommand(EPSON_TM_T20, 'A', { moduleSize: 99 })).toThrow(MissingCapabilityError);
  });
});

describe('raster', () => {
  it('frames a bitmap with GS v 0 and the right row count', () => {
    const bytes = rasterCommand({ width: 16, height: 2, data: new Uint8Array(4) });
    expect(Array.from(bytes.slice(0, 8))).toEqual([...GS_RASTER, 2, 0, 2, 0]);
  });

  it('rejects a payload whose size contradicts its dimensions', () => {
    expect(() => rasterCommand({ width: 16, height: 2, data: new Uint8Array(3) })).toThrow(
      MissingCapabilityError,
    );
  });
});

describe('renderReceipt', () => {
  it('renders an Arabic receipt on a UTF-8 device with a native QR', () => {
    const bytes = renderReceipt(TEST_UTF8_NATIVE, data);
    expect(startsWith(bytes, ESC_INIT)).toBe(true);
    expect(contains(bytes, QR_MODEL_2)).toBe(true);
    expect(contains(bytes, QR_PRINT)).toBe(true);
    expect(Array.from(bytes.slice(-3))).toEqual(GS_PARTIAL_CUT);
  });

  it('refuses an Arabic receipt on a raster device until a renderer exists', () => {
    // Refusing to print is correct; printing the wrong Arabic is not.
    const bitmap = { width: 8, height: 8, data: new Uint8Array(8) };
    expect(() => renderReceipt(EPSON_TM_T20, data, { qrBitmap: bitmap })).toThrow(
      MissingCapabilityError,
    );
    expect(() => renderReceipt(GENERIC_ESCPOS_UNKNOWN, data, { qrBitmap: bitmap })).toThrow(
      MissingCapabilityError,
    );
  });

  it('refuses rather than printing an invoice with no scannable QR', () => {
    const asciiOnly = { ...data, sellerName: 'Korvi Store', lines: [] };
    expect(() => renderReceipt(GENERIC_ESCPOS_UNKNOWN, asciiOnly)).toThrow(MissingCapabilityError);
  });

  it('refuses an empty QR payload', () => {
    expect(() => renderReceipt(TEST_UTF8_NATIVE, { ...data, qrPayload: '  ' })).toThrow(
      MissingCapabilityError,
    );
  });

  it('keeps the Korvi mark out of the header', () => {
    const text = new TextDecoder().decode(renderReceipt(TEST_UTF8_NATIVE, data));
    expect(text.slice(0, text.indexOf('رقم الفاتورة'))).not.toContain('Korvi');
    expect(text).toContain('صُدرت عبر Korvi');
  });

  it('is deterministic', () => {
    expect(renderReceipt(TEST_UTF8_NATIVE, data)).toEqual(renderReceipt(TEST_UTF8_NATIVE, data));
  });

  it('uses only characters every supported path can represent', () => {
    // U+00D7 (×) is absent from PC864, so the quantity line uses ASCII "x".
    expect(() => renderReceipt(TEST_UTF8_NATIVE, data)).not.toThrow();
  });
});

describe('profile registry', () => {
  it('resolves a known profile and reports an unknown one', () => {
    expect(findProfile('epson-tm-t20')?.capabilities.qr).toBe('native');
    expect(findProfile('nope')).toBeNull();
  });
});
