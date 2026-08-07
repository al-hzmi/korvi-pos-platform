import { describe, expect, it } from 'vitest';
import { canEncode, encodeCodePage, stripDiacritics } from '../encoding/codepage.js';
import { encodeTextFor } from '../encoding/text-encoder.js';
import { UnsupportedCharacterError, MissingCapabilityError } from '../errors.js';
import {
  EPSON_TM_T20,
  GENERIC_ESCPOS_UNKNOWN,
  SYNTHETIC_RASTER_ONLY,
  SYNTHETIC_CP1256_FIRMWARE_SHAPING,
  SYNTHETIC_UTF8_NATIVE,
} from '../profiles/registry.js';
import type { PrinterProfile } from '../profiles/types.js';

const TEST_UTF8_NATIVE = {
  ...SYNTHETIC_UTF8_NATIVE,
  id: 'test-utf8-native-runtime',
  vendor: 'test-only',
  capabilities: { ...SYNTHETIC_UTF8_NATIVE.capabilities, verified: true },
} as const satisfies PrinterProfile;

describe('code page encoding', () => {
  it('maps Arabic to one byte per letter in CP1256', () => {
    // Windows-1256 holds the unshaped alphabet, one cell per letter.
    expect(Array.from(encodeCodePage('مرحبا', 'cp1256'))).toEqual([0xe3, 0xd1, 0xcd, 0xc8, 0xc7]);
  });

  it('does not emit UTF-8 for Arabic', () => {
    // Revision 1's bug: 5 letters became 10 UTF-8 bytes, and the head printed
    // 10 unrelated glyphs.
    const bytes = encodeCodePage('مرحبا', 'cp1256');
    expect(bytes.length).toBe(5);
    expect(bytes.length).not.toBe(new TextEncoder().encode('مرحبا').length);
  });

  it('passes ASCII through unchanged in both pages', () => {
    for (const page of ['cp1256', 'cp864'] as const) {
      expect(Array.from(encodeCodePage('INV-1', page))).toEqual([0x49, 0x4e, 0x56, 0x2d, 0x31]);
    }
  });

  it('refuses an unmappable character instead of substituting', () => {
    expect(() => encodeCodePage('日本語', 'cp1256')).toThrow(UnsupportedCharacterError);
    expect(() => encodeCodePage('🙂', 'cp864')).toThrow(UnsupportedCharacterError);
  });

  it('reports encodability without throwing', () => {
    expect(canEncode('مرحبا', 'cp1256')).toBe(true);
    expect(canEncode('日本語', 'cp1256')).toBe(false);
  });

  it('keeps vowel marks for a page that carries them', () => {
    expect(encodeCodePage('صُدرت', 'cp1256').length).toBe(5);
  });

  it('strips only combining marks, never letters', () => {
    expect(stripDiacritics('صُدرت')).toBe('صدرت');
    expect(stripDiacritics('مرحبا')).toBe('مرحبا');
    expect(stripDiacritics('Korvi 115.00')).toBe('Korvi 115.00');
  });
});

describe('profile-driven text encoding', () => {
  it('sends logical-order UTF-8 to a UTF-8 native device', () => {
    // Those devices run their own shaping and bidi, so neither step applies.
    expect(encodeTextFor(TEST_UTF8_NATIVE, 'مرحبا')).toEqual(new TextEncoder().encode('مرحبا'));
  });

  it('refuses Arabic on every raster profile', () => {
    for (const profile of [GENERIC_ESCPOS_UNKNOWN, SYNTHETIC_RASTER_ONLY, EPSON_TM_T20]) {
      expect(() => encodeTextFor(profile, 'مرحبا')).toThrow(MissingCapabilityError);
    }
  });

  it('refuses any unverified profile, synthetic fixtures included', () => {
    expect(() => encodeTextFor(SYNTHETIC_CP1256_FIRMWARE_SHAPING, 'مرحبا')).toThrow(
      MissingCapabilityError,
    );
  });

  it('lets ASCII through natively on a raster profile', () => {
    // Prices and document numbers are identical in every code page, so there
    // is nothing to render.
    for (const profile of [GENERIC_ESCPOS_UNKNOWN, EPSON_TM_T20]) {
      expect(Array.from(encodeTextFor(profile, '115.00'))).toEqual([
        0x31, 0x31, 0x35, 0x2e, 0x30, 0x30,
      ]);
    }
  });

  it('keeps prices readable on the UTF-8 path too', () => {
    expect(Array.from(encodeTextFor(TEST_UTF8_NATIVE, '115.00'))).toEqual([
      0x31, 0x31, 0x35, 0x2e, 0x30, 0x30,
    ]);
  });
});
