import { encodeCodePage } from './codepage.js';
import { shapeArabic } from './arabic-shaping.js';
import { toVisualOrder } from './bidi.js';
import { MissingCapabilityError } from '../errors.js';
import type { PrinterProfile } from '../profiles/types.js';

/**
 * Turn a logical-order string into the bytes a given device needs.
 *
 * The order of the two Arabic steps is the correctness point, and revision 2
 * had it backwards.
 *
 *   1. SHAPE, on logical order.
 *   2. REORDER the shaped result into visual order.
 *
 * Contextual shaping is defined over *logical* adjacency: a letter's form
 * depends on the letter before and after it as the word is written, not as it
 * is laid out on paper. Reordering first reverses that adjacency, so every
 * letter is shaped against the wrong neighbours — initial forms become final,
 * medial joins break, and lam-alef never pairs because the lam now follows the
 * alef. The output is well-formed bytes that spell a word incorrectly, which is
 * the hardest kind of wrong to notice.
 *
 * Reordering after shaping is safe: presentation forms are still RTL
 * characters, so the reordering pass treats them exactly as it treats base
 * letters.
 *
 * Each step is skipped when the device declares it does that work itself.
 */
function isAscii(text: string): boolean {
  return [...text].every((character) => (character.codePointAt(0) ?? 0) < 0x80);
}

function asciiBytes(text: string): Uint8Array {
  return Uint8Array.from([...text].map((character) => character.codePointAt(0) ?? 0));
}

export function encodeTextFor(profile: PrinterProfile, text: string): Uint8Array {
  const { capabilities } = profile;

  if (capabilities.text === 'raster') {
    // ASCII still goes native: command bytes, document numbers and prices are
    // identical in every code page, and rasterising them would be pointless.
    // Anything above U+007F needs a renderer.
    if (isAscii(text)) {
      return asciiBytes(text);
    }
    throw new MissingCapabilityError(
      `Profile "${profile.id}" has no non-ASCII text path` +
        (capabilities.verified ? '' : ' (device unverified)') +
        '; render the line with a RasterRenderer and send it as a bitmap instead. ' +
        'See ADR-0011.',
    );
  }

  if (!capabilities.verified) {
    // Belt and braces: an unverified profile must never reach a code page.
    throw new MissingCapabilityError(
      `Profile "${profile.id}" is unverified, so its Arabic behaviour is a guess. ` +
        'Use a verified profile or the raster path.',
    );
  }

  let staged = text;

  // 1. Shape on logical adjacency.
  if (!capabilities.firmwareShapes) {
    staged = shapeArabic(staged);
  }

  // 2. Then lay out for a head with no bidi algorithm.
  if (!capabilities.firmwareBidi) {
    staged = toVisualOrder(staged);
  }

  if (capabilities.text === 'utf8') {
    return new TextEncoder().encode(staged);
  }

  return encodeCodePage(staged, capabilities.text);
}
