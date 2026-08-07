import { UnsupportedCharacterError } from '../errors.js';

/**
 * Legacy single-byte code page mapping.
 *
 * The point of this file is that it exists at all. An ESC/POS device decodes
 * incoming bytes through whichever code page it was told to select, so the
 * encoder has to produce bytes in that page. Sending UTF-8 instead — revision
 * 1's bug — hands the head two bytes per Arabic letter and it prints two
 * unrelated glyphs for each.
 */

/** Windows-1256. Base Arabic letters; the firmware joins them. */
const CP1256 = new Map<number, number>([
  [0x060c, 0xa1],
  [0x061b, 0xba],
  [0x061f, 0xbf],
  [0x0621, 0xc1],
  [0x0622, 0xc2],
  [0x0623, 0xc3],
  [0x0624, 0xc4],
  [0x0625, 0xc5],
  [0x0626, 0xc6],
  [0x0627, 0xc7],
  [0x0628, 0xc8],
  [0x0629, 0xc9],
  [0x062a, 0xca],
  [0x062b, 0xcb],
  [0x062c, 0xcc],
  [0x062d, 0xcd],
  [0x062e, 0xce],
  [0x062f, 0xcf],
  [0x0630, 0xd0],
  [0x0631, 0xd1],
  [0x0632, 0xd2],
  [0x0633, 0xd3],
  [0x0634, 0xd4],
  [0x0635, 0xd5],
  [0x0636, 0xd6],
  [0x0637, 0xd8],
  [0x0638, 0xd9],
  [0x0639, 0xda],
  [0x063a, 0xdb],
  [0x0640, 0xdc],
  [0x0641, 0xdd],
  [0x0642, 0xde],
  [0x0643, 0xdf],
  [0x0644, 0xe1],
  [0x0645, 0xe3],
  [0x0646, 0xe4],
  [0x0647, 0xe5],
  [0x0648, 0xe6],
  [0x0649, 0xec],
  [0x064a, 0xed],
  [0x064b, 0xf0],
  [0x064c, 0xf1],
  [0x064d, 0xf2],
  [0x064e, 0xf3],
  [0x064f, 0xf5],
  [0x0650, 0xf6],
  [0x0651, 0xf8],
  [0x0652, 0xfa],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x00a0, 0xa0],
  [0x00d7, 0xd7],
  [0x00f7, 0xf7],
]);

/**
 * PC864 (CP864), transcribed from the authoritative Microsoft/Unicode mapping.
 *
 * SOURCE: https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/PC/CP864.TXT
 * Cross-checked against the platform's own `cp864` codec, which is derived from
 * the same mapping. Epson documents this page as character code table 37.
 *
 * Every entry below comes from that table. None is inferred, and none is
 * derived from Korvi's own shaper — which is exactly how revision 3 went wrong:
 * its table was invented, its golden fixtures were then generated *from* that
 * table, and the two agreed with each other while both disagreed with PC864.
 * Notably it mapped the lam-alef ligature to 0xE8, which in PC864 is WAW
 * ISOLATED (U+FEED).
 *
 * The decisive property of the real table: PC864 contains only 72 of the 144
 * code points in the Arabic Presentation Forms-B block, and only 71 of the 125
 * forms Korvi's shaper can produce. Standard PC864 therefore CANNOT carry
 * arbitrary fully-shaped Arabic. That is a property of the code page, not a gap
 * in this transcription, and it is why Arabic defaults to the raster path
 * (ADR-0011).
 */
const CP864 = new Map<number, number>([
  [0x00a0, 0xa0],
  [0x00a2, 0xc0],
  [0x00a3, 0xa3],
  [0x00a4, 0xa4],
  [0x00a6, 0xdb],
  [0x00ab, 0x97],
  [0x00ac, 0xdc],
  [0x00ad, 0xa1],
  [0x00b0, 0x80],
  [0x00b1, 0x93],
  [0x00b7, 0x81],
  [0x00bb, 0x98],
  [0x00bc, 0x95],
  [0x00bd, 0x94],
  [0x00d7, 0xde],
  [0x00f7, 0xdd],
  [0x03b2, 0x90],
  [0x03c6, 0x92],
  [0x060c, 0xac],
  [0x061b, 0xbb],
  [0x061f, 0xbf],
  [0x0640, 0xe0],
  [0x0651, 0xf1],
  [0x0660, 0xb0],
  [0x0661, 0xb1],
  [0x0662, 0xb2],
  [0x0663, 0xb3],
  [0x0664, 0xb4],
  [0x0665, 0xb5],
  [0x0666, 0xb6],
  [0x0667, 0xb7],
  [0x0668, 0xb8],
  [0x0669, 0xb9],
  [0x066a, 0x25],
  [0x2219, 0x82],
  [0x221a, 0x83],
  [0x221e, 0x91],
  [0x2248, 0x96],
  [0x2500, 0x85],
  [0x2502, 0x86],
  [0x250c, 0x8d],
  [0x2510, 0x8c],
  [0x2514, 0x8e],
  [0x2518, 0x8f],
  [0x251c, 0x8a],
  [0x2524, 0x88],
  [0x252c, 0x89],
  [0x2534, 0x8b],
  [0x253c, 0x87],
  [0x2592, 0x84],
  [0x25a0, 0xfe],
  [0xfe7d, 0xf0],
  [0xfe80, 0xc1],
  [0xfe81, 0xc2],
  [0xfe82, 0xa2],
  [0xfe83, 0xc3],
  [0xfe84, 0xa5],
  [0xfe85, 0xc4],
  [0xfe8b, 0xc6],
  [0xfe8d, 0xc7],
  [0xfe8e, 0xa8],
  [0xfe8f, 0xa9],
  [0xfe91, 0xc8],
  [0xfe93, 0xc9],
  [0xfe95, 0xaa],
  [0xfe97, 0xca],
  [0xfe99, 0xab],
  [0xfe9b, 0xcb],
  [0xfe9d, 0xad],
  [0xfe9f, 0xcc],
  [0xfea1, 0xae],
  [0xfea3, 0xcd],
  [0xfea5, 0xaf],
  [0xfea7, 0xce],
  [0xfea9, 0xcf],
  [0xfeab, 0xd0],
  [0xfead, 0xd1],
  [0xfeaf, 0xd2],
  [0xfeb1, 0xbc],
  [0xfeb3, 0xd3],
  [0xfeb5, 0xbd],
  [0xfeb7, 0xd4],
  [0xfeb9, 0xbe],
  [0xfebb, 0xd5],
  [0xfebd, 0xeb],
  [0xfebf, 0xd6],
  [0xfec1, 0xd7],
  [0xfec5, 0xd8],
  [0xfec9, 0xdf],
  [0xfeca, 0xc5],
  [0xfecb, 0xd9],
  [0xfecc, 0xec],
  [0xfecd, 0xee],
  [0xfece, 0xed],
  [0xfecf, 0xda],
  [0xfed0, 0xf7],
  [0xfed1, 0xba],
  [0xfed3, 0xe1],
  [0xfed5, 0xf8],
  [0xfed7, 0xe2],
  [0xfed9, 0xfc],
  [0xfedb, 0xe3],
  [0xfedd, 0xfb],
  [0xfedf, 0xe4],
  [0xfee1, 0xef],
  [0xfee3, 0xe5],
  [0xfee5, 0xf2],
  [0xfee7, 0xe6],
  [0xfee9, 0xf3],
  [0xfeeb, 0xe7],
  [0xfeec, 0xf4],
  [0xfeed, 0xe8],
  [0xfeef, 0xe9],
  [0xfef0, 0xf5],
  [0xfef1, 0xfd],
  [0xfef2, 0xf6],
  [0xfef3, 0xea],
  [0xfef5, 0xf9],
  [0xfef6, 0xfa],
  [0xfef7, 0x99],
  [0xfef8, 0x9a],
  [0xfefb, 0x9d],
  [0xfefc, 0x9e],
]);

const TABLES: Record<'cp1256' | 'cp864', Map<number, number>> = {
  cp1256: CP1256,
  cp864: CP864,
};

/** Harakat and other combining marks: U+064B-065F, U+0670, U+06D6-06ED. */
const DIACRITIC = /[\u064B-\u065F\u0670\u06D6-\u06ED]/gu;

/**
 * Code pages whose Arabic repertoire carries no combining marks.
 *
 * CP864 addresses presentation forms and has no cells for harakat. CP1256 does
 * carry them, so it is absent from this set.
 */
const STRIPS_DIACRITICS: ReadonlySet<string> = new Set(['cp864']);

/**
 * Remove optional vowel marks.
 *
 * This is not the same as substituting a wrong glyph, which the encoder refuses
 * to do. Harakat are optional vowelisation: Arabic is normally written without
 * them, and the consonant skeleton is the word. Dropping a damma leaves the
 * text correct and readable; inventing a byte for it would print a different
 * letter.
 *
 * Applied only for code pages that cannot represent them at all.
 */
export function stripDiacritics(input: string): string {
  return input.replace(DIACRITIC, '');
}

/**
 * Encode a string into a single-byte code page.
 *
 * ASCII passes through unchanged in both pages, which is what keeps prices and
 * document numbers intact.
 */
export function encodeCodePage(input: string, page: 'cp1256' | 'cp864'): Uint8Array {
  const table = TABLES[page];
  const source = STRIPS_DIACRITICS.has(page) ? stripDiacritics(input) : input;
  const out: number[] = [];

  for (const character of source) {
    const codePoint = character.codePointAt(0) ?? 0;

    if (codePoint < 0x80) {
      out.push(codePoint);
      continue;
    }

    const mapped = table.get(codePoint);
    if (mapped === undefined) {
      throw new UnsupportedCharacterError(
        `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} ("${character}") has no ` +
          `${page} mapping. Use a profile with a raster fallback rather than printing a ` +
          'substitute glyph on a tax invoice.',
      );
    }
    out.push(mapped);
  }

  return Uint8Array.from(out);
}

export function canEncode(input: string, page: 'cp1256' | 'cp864'): boolean {
  try {
    encodeCodePage(input, page);
    return true;
  } catch {
    return false;
  }
}
