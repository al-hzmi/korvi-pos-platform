import { describe, expect, it } from 'vitest';
import { encodeTextFor } from '../encoding/text-encoder.js';
import { renderReceipt } from '../receipt.js';
import { MissingCapabilityError } from '../errors.js';
import {
  DEFAULT_PROFILE,
  EPSON_TM_T20,
  PRINTER_PROFILES,
  PRODUCTION_PROFILES,
  SYNTHETIC_CP1256_FIRMWARE_SHAPING,
  SYNTHETIC_UTF8_NATIVE,
  SYNTHETIC_RASTER_ONLY,
  findProductionProfile,
} from '../profiles/registry.js';
import { moneyFromMajorString } from '@korvi/domain';

/**
 * Arabic takes the raster path in production. Always.
 *
 * PC864 contains only part of the Arabic Presentation Forms-B block, so no
 * code-page route can carry arbitrary shaped Arabic. A route that works for
 * some item names and fails for others is the worst available outcome: the
 * failure is invisible until a merchant sells the wrong product. ADR-0011.
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

describe('every production profile', () => {
  it.each(PRODUCTION_PROFILES.map((profile) => [profile.id, profile] as const))(
    '%s refuses Arabic through a code page',
    (_id, profile) => {
      if (profile.capabilities.text === 'utf8') return; // genuinely decodes it
      expect(() => encodeTextFor(profile, 'مرحبا')).toThrow(MissingCapabilityError);
    },
  );

  it.each(PRODUCTION_PROFILES.map((profile) => [profile.id, profile] as const))(
    '%s never claims firmware Arabic shaping over a legacy code page',
    (_id, profile) => {
      if (profile.capabilities.text === 'cp1256' || profile.capabilities.text === 'cp864') {
        expect(profile.capabilities.firmwareShapes).toBe(false);
      }
    },
  );

  it('excludes every synthetic fixture', () => {
    for (const fixture of [
      SYNTHETIC_CP1256_FIRMWARE_SHAPING,
      SYNTHETIC_UTF8_NATIVE,
      SYNTHETIC_RASTER_ONLY,
    ]) {
      expect(fixture.capabilities.verified).toBe(false);
      expect(PRODUCTION_PROFILES).not.toContain(fixture);
      expect(findProductionProfile(fixture.id)).toBeNull();
    }
  });

  it('contains no generic or synthetic verified capability claim', () => {
    for (const profile of PRINTER_PROFILES) {
      if (profile.vendor === 'generic' || profile.vendor === 'synthetic') {
        expect(profile.capabilities.verified).toBe(false);
      }
    }
  });
});

describe('the synthetic fixture', () => {
  it('is marked unverified and named as a fixture', () => {
    expect(SYNTHETIC_CP1256_FIRMWARE_SHAPING.capabilities.verified).toBe(false);
    expect(SYNTHETIC_CP1256_FIRMWARE_SHAPING.vendor).toBe('synthetic');
    expect(SYNTHETIC_CP1256_FIRMWARE_SHAPING.id).toContain('synthetic');
    expect(SYNTHETIC_CP1256_FIRMWARE_SHAPING.model).toMatch(/TEST FIXTURE/);
  });

  it('is refused by the encoder like any unverified profile', () => {
    expect(() => encodeTextFor(SYNTHETIC_CP1256_FIRMWARE_SHAPING, 'مرحبا')).toThrow(
      MissingCapabilityError,
    );
  });
});

describe('Epson TM-T20', () => {
  it('routes Arabic to raster despite supporting PC864', () => {
    expect(EPSON_TM_T20.capabilities.text).toBe('raster');
    expect(() => encodeTextFor(EPSON_TM_T20, 'متجر كورفي')).toThrow(MissingCapabilityError);
  });

  it('keeps ASCII on the native path', () => {
    // Command bytes, document numbers and prices are identical in every code
    // page; rasterising them would be pointless.
    expect(Array.from(encodeTextFor(EPSON_TM_T20, 'INV-2026-00001'))).toEqual(
      [...'INV-2026-00001'].map((c) => c.charCodeAt(0)),
    );
    expect(Array.from(encodeTextFor(EPSON_TM_T20, '115.00'))).toEqual([
      0x31, 0x31, 0x35, 0x2e, 0x30, 0x30,
    ]);
  });

  it('keeps its vendor-documented native QR', () => {
    expect(EPSON_TM_T20.capabilities.qr).toBe('native');
  });

  it('cannot render an Arabic receipt without a raster renderer', () => {
    expect(() => renderReceipt(EPSON_TM_T20, receipt)).toThrow(MissingCapabilityError);
  });
});

describe('unknown hardware', () => {
  it('is the default and rasters Arabic', () => {
    expect(DEFAULT_PROFILE.capabilities.text).toBe('raster');
    expect(DEFAULT_PROFILE.capabilities.verified).toBe(false);
    expect(() => encodeTextFor(DEFAULT_PROFILE, 'مرحبا')).toThrow(MissingCapabilityError);
  });

  it('assumes no code page and no firmware shaping', () => {
    expect(DEFAULT_PROFILE.capabilities.firmwareShapes).toBe(false);
    expect(DEFAULT_PROFILE.capabilities.codePageId).toBeNull();
  });
});

describe('registry integrity', () => {
  it('never marks a generic or synthetic profile verified', () => {
    for (const profile of PRINTER_PROFILES) {
      if (profile.vendor === 'generic' || profile.vendor === 'synthetic') {
        expect(profile.capabilities.verified).toBe(false);
      }
    }
  });

  it('marks every unverified production profile as raster-only', () => {
    for (const profile of PRODUCTION_PROFILES) {
      if (!profile.capabilities.verified) {
        expect(profile.capabilities.text).toBe('raster');
      }
    }
  });

  it('keeps unverified profiles unreachable through production lookup', () => {
    // The synthetic fixture may declare cp1256 so the codec stays exercised;
    // what matters is that no production path can select it.
    for (const profile of PRINTER_PROFILES) {
      if (!profile.capabilities.verified && profile.capabilities.text !== 'raster') {
        expect(findProductionProfile(profile.id)).toBeNull();
      }
    }
  });
});
