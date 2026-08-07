import type { PrinterProfile } from './types.js';

/**
 * The device profiles Korvi knows about.
 *
 * Deliberately small and explicit. A profile is a claim about hardware
 * behaviour, and an unverified claim is worse than no profile: it produces
 * confident garbage. Add a model here only once its behaviour has been observed
 * on a real unit.
 */

/**
 * Default for an unknown ESC/POS device — fails safe to raster.
 *
 * Revision 2 assumed an unknown device spoke CP1256 and shaped Arabic in
 * firmware. That was a guess, and a wrong guess prints an unreadable tax
 * invoice: devices differ on whether they shape, on which Arabic page they
 * carry, and on whether they carry one at all.
 *
 * So an unidentified device gets no text path. Rendering each line to a bitmap
 * is slower and always correct, and the caller is forced to supply a renderer
 * rather than silently receiving mojibake.
 *
 * Identify the model, verify it, and add a profile to get the fast path.
 */
export const GENERIC_ESCPOS_UNKNOWN: PrinterProfile = {
  id: 'generic-escpos-unknown',
  vendor: 'unknown',
  model: 'Unidentified ESC/POS 80mm',
  capabilities: {
    columns: 48,
    dotsPerLine: 576,
    text: 'raster',
    codePageId: null,
    firmwareShapes: false,
    firmwareBidi: false,
    qr: 'raster',
    supportsPartialCut: false,
    verified: false,
  },
  notes:
    'Unknown hardware. No assumption is made about Arabic support, so there is ' +
    'no text path at all: every line must be rendered to a bitmap. Replace with ' +
    'a verified model profile once the device is identified.',
};

/**
 * Epson TM-T20 family — native QR, CP864 with presentation forms.
 *
 * CP864 addresses shaped glyphs directly and the firmware does not join
 * letters, so Korvi shapes before sending.
 */
export const EPSON_TM_T20: PrinterProfile = {
  id: 'epson-tm-t20',
  vendor: 'Epson',
  model: 'TM-T20III',
  capabilities: {
    columns: 48,
    dotsPerLine: 576,
    // Arabic goes to raster even though this device supports PC864 (Epson
    // character code table 37). PC864 contains only 72 of the 144 Presentation
    // Forms-B code points, and only 71 of the 125 forms Korvi's shaper can
    // produce, so it cannot carry arbitrary shaped Arabic. Routing Arabic
    // through it would print correct text for some item names and wrong text
    // for others, which is the worst failure mode available. See ADR-0011.
    text: 'raster',
    codePageId: 0x25,
    firmwareShapes: false,
    firmwareBidi: false,
    // Native QR is documented by the vendor and is independent of the text
    // path, so it is kept.
    qr: 'native',
    supportsPartialCut: true,
    verified: true,
  },
  notes:
    'Verified for native GS ( k QR and ASCII text against the vendor ' +
    'character code tables. Arabic is routed to raster: PC864 cannot represent ' +
    'the full set of contextual forms, so a code-page path would be correct for ' +
    'some words and wrong for others (ADR-0011).',
};

/**
 * SYNTHETIC — a test fixture, not a production profile.
 *
 * It models a hypothetical device that accepts CP1256 and joins letters in
 * firmware, so the CP1256 codec and the "do not pre-shape" branch of the
 * encoder stay exercised. No physical unit has been tested against it.
 *
 * `verified: false` keeps it out of every production path: the encoder refuses
 * unverified profiles, and it is excluded from `PRODUCTION_PROFILES`. Promoting
 * it means testing real hardware against its vendor character table and saying
 * so here.
 *
 * The CP1256 table it exercises *is* authoritative — transcribed from the
 * Windows-1256 mapping and cross-checked entry by entry. What is unverified is
 * the claim that any given printer behaves this way.
 */
export const SYNTHETIC_CP1256_FIRMWARE_SHAPING: PrinterProfile = {
  id: 'synthetic-cp1256-firmware-shaping',
  vendor: 'synthetic',
  model: 'TEST FIXTURE — unverified CP1256 with firmware shaping',
  capabilities: {
    columns: 48,
    dotsPerLine: 576,
    text: 'cp1256',
    codePageId: 0x16,
    firmwareShapes: true,
    firmwareBidi: false,
    qr: 'raster',
    supportsPartialCut: true,
    verified: false,
  },
  notes:
    'SYNTHETIC TEST FIXTURE. Models base Arabic letters in CP1256 with ' +
    'firmware-side joining. No hardware has been verified against it, so it is ' +
    'unverified and excluded from production selection.',
};

/**
 * SYNTHETIC UTF-8 fixture.
 *
 * This models the behaviour of a modern printer that decodes UTF-8 and performs
 * shaping/bidi itself. It is deliberately NOT a production profile: no concrete
 * vendor/model has been verified, so production selection must not trust it.
 */
export const SYNTHETIC_UTF8_NATIVE: PrinterProfile = {
  id: 'synthetic-utf8-native',
  vendor: 'synthetic',
  model: 'TEST FIXTURE — hypothetical UTF-8 ESC/POS',
  capabilities: {
    columns: 48,
    dotsPerLine: 576,
    text: 'utf8',
    codePageId: null,
    firmwareShapes: true,
    firmwareBidi: true,
    qr: 'native',
    supportsPartialCut: true,
    verified: false,
  },
  notes:
    'SYNTHETIC TEST FIXTURE. Exercises the UTF-8 encoder branch only. No physical ' +
    'printer model has been verified against these capabilities, so it is excluded ' +
    'from production selection.',
};

/**
 * SYNTHETIC raster-only fixture.
 */
export const SYNTHETIC_RASTER_ONLY: PrinterProfile = {
  id: 'synthetic-raster-only',
  vendor: 'synthetic',
  model: 'TEST FIXTURE — raster-only printer',
  capabilities: {
    columns: 48,
    dotsPerLine: 576,
    text: 'raster',
    codePageId: null,
    firmwareShapes: false,
    firmwareBidi: false,
    qr: 'raster',
    supportsPartialCut: false,
    verified: false,
  },
  notes:
    'SYNTHETIC TEST FIXTURE. Exercises raster fallback behaviour only. It is not ' +
    'evidence about any real printer and is excluded from production selection.',
};

/** Everything defined here, including synthetic fixtures. */
export const PRINTER_PROFILES: readonly PrinterProfile[] = [
  GENERIC_ESCPOS_UNKNOWN,
  EPSON_TM_T20,
  SYNTHETIC_CP1256_FIRMWARE_SHAPING,
  SYNTHETIC_UTF8_NATIVE,
  SYNTHETIC_RASTER_ONLY,
];

/**
 * Profiles a running till may select.
 *
 * Only concrete, verified, non-synthetic device profiles are eligible. The
 * unidentified fail-safe profile remains the DEFAULT_PROFILE but is not a
 * production capability claim.
 */
export const PRODUCTION_PROFILES: readonly PrinterProfile[] = PRINTER_PROFILES.filter(
  (profile) => profile.vendor !== 'synthetic' && profile.capabilities.verified,
);

/**
 * The profile to use when the device has not been identified.
 *
 * Raster, always. No guess about Arabic support is safe (ADR-0011).
 */
export const DEFAULT_PROFILE: PrinterProfile = GENERIC_ESCPOS_UNKNOWN;

/** Resolve a production profile by id. Synthetic fixtures never resolve. */
export function findProductionProfile(id: string): PrinterProfile | null {
  return PRODUCTION_PROFILES.find((profile) => profile.id === id) ?? null;
}

export function findProfile(id: string): PrinterProfile | null {
  return PRINTER_PROFILES.find((profile) => profile.id === id) ?? null;
}
