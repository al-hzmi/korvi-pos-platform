import { describe, expect, it } from 'vitest';
import { encodeTextFor } from '../encoding/text-encoder.js';
import { renderReceipt } from '../receipt.js';
import { MissingCapabilityError } from '../errors.js';
import {
  DEFAULT_PROFILE,
  GENERIC_ESCPOS_UNKNOWN,
  PRINTER_PROFILES,
  PRODUCTION_PROFILES,
  SYNTHETIC_RASTER_ONLY,
} from '../profiles/registry.js';
import { moneyFromMajorString } from '@korvi/domain';

/**
 * Unknown hardware must fail safe.
 *
 * Revision 2 assumed an unidentified ESC/POS device spoke CP1256 and shaped
 * Arabic in firmware. Devices differ on all three counts — whether they shape,
 * which Arabic page they carry, whether they carry one — so the assumption
 * produced an unreadable tax invoice on anything that did not match it.
 */

const receipt = {
  sellerName: 'متجر كورفي',
  vatRegistrationNumber: '310122393500003',
  invoiceNumber: 'INV-2026-00001',
  timestamp: '2026-08-07T09:45:00Z',
  lines: [{ description: 'ماء', quantity: 1, lineTotal: moneyFromMajorString('4.00') }],
  net: moneyFromMajorString('100.00'),
  vat: moneyFromMajorString('15.00'),
  total: moneyFromMajorString('115.00'),
  qrPayload: 'AQVtZXJjaA==',
};

describe('unknown hardware', () => {
  it('is the default profile', () => {
    expect(DEFAULT_PROFILE.id).toBe(GENERIC_ESCPOS_UNKNOWN.id);
  });

  it('claims no verification', () => {
    expect(GENERIC_ESCPOS_UNKNOWN.capabilities.verified).toBe(false);
  });

  it('declares no text path rather than guessing a code page', () => {
    expect(GENERIC_ESCPOS_UNKNOWN.capabilities.text).toBe('raster');
  });

  it('refuses to encode Arabic text', () => {
    expect(() => encodeTextFor(GENERIC_ESCPOS_UNKNOWN, 'مرحبا')).toThrow(MissingCapabilityError);
  });

  it('still passes ASCII natively — there is nothing to render', () => {
    // Command bytes, document numbers and prices are identical in every code
    // page. Only text above U+007F needs a renderer (ADR-0011).
    expect(Array.from(encodeTextFor(GENERIC_ESCPOS_UNKNOWN, 'INV-1'))).toEqual([
      0x49, 0x4e, 0x56, 0x2d, 0x31,
    ]);
  });

  it('refuses anything above ASCII, including non-Arabic scripts', () => {
    for (const text of ['مرحبا', '日本語', 'café']) {
      expect(() => encodeTextFor(GENERIC_ESCPOS_UNKNOWN, text)).toThrow(MissingCapabilityError);
    }
  });

  it('assumes no QR firmware', () => {
    expect(GENERIC_ESCPOS_UNKNOWN.capabilities.qr).not.toBe('native');
  });

  it('cannot render a receipt without a raster renderer', () => {
    expect(() => renderReceipt(GENERIC_ESCPOS_UNKNOWN, receipt)).toThrow(MissingCapabilityError);
  });
});

describe('profile registry integrity', () => {
  it('gives every production profile that claims a text path a verified flag', () => {
    // Synthetic fixtures may declare a code page — that is what keeps the
    // codec exercised — but they are excluded from production selection.
    for (const profile of PRODUCTION_PROFILES) {
      if (profile.capabilities.text !== 'raster') {
        expect(profile.capabilities.verified).toBe(true);
      }
    }
  });

  it('never lets an unverified profile reach a code page', () => {
    for (const profile of PRINTER_PROFILES) {
      if (!profile.capabilities.verified) {
        expect(() => encodeTextFor(profile, 'مرحبا')).toThrow(MissingCapabilityError);
      }
    }
  });

  it('records why each profile is configured as it is', () => {
    for (const profile of PRINTER_PROFILES) {
      expect(profile.notes.length).toBeGreaterThan(40);
    }
  });

  it('keeps a confirmed no-Arabic device on the raster path', () => {
    expect(SYNTHETIC_RASTER_ONLY.capabilities.text).toBe('raster');
    expect(() => encodeTextFor(SYNTHETIC_RASTER_ONLY, 'مرحبا')).toThrow(MissingCapabilityError);
  });
});
