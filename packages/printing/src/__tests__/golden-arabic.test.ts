import { describe, expect, it } from 'vitest';
import { shapeArabic } from '../encoding/arabic-shaping.js';
import { toVisualOrder } from '../encoding/bidi.js';

/**
 * Linguistic fixtures for the Arabic shaper.
 *
 * These assert actual glyph forms, not lengths. A length check passes against a
 * pipeline that shapes every letter into the wrong contextual form, which is
 * precisely the defect revision 2 shipped: reordering before shaping produced
 * the right *number* of well-formed bytes spelling the word incorrectly.
 *
 * Every expectation is verifiable by hand against the Arabic joining rules, so
 * these encode correctness rather than current behaviour.
 *
 * Byte-level expectations live in cp864-conformance.test.ts and come from the
 * published code-page mappings. The shaper output is deliberately not asserted
 * in bytes here: PC864 cannot represent most of these forms, which is why
 * Arabic prints via raster (ADR-0011). Keeping the shaper tested at the glyph
 * level is what makes it reusable by the future raster layout path.
 */

const points = (text: string): string[] =>
  [...text].map((character) => `0x${(character.codePointAt(0) ?? 0).toString(16)}`);

describe('shaping operates on logical adjacency', () => {
  it('shapes مرحبا into initial, final, initial, medial, final', () => {
    // م initial (no letter before), ر final (م joins forward, ر joins only
    // backwards), ح initial (ر offers no forward join), ب medial, ا final.
    expect(points(shapeArabic('مرحبا'))).toEqual([
      '0xfee3', // م initial
      '0xfeae', // ر final
      '0xfea3', // ح initial
      '0xfe92', // ب medial
      '0xfe8e', // ا final
    ]);
  });

  it('would produce entirely different forms if reordering came first', () => {
    // The revision 2 order, kept as an explicit counter-example. Not one glyph
    // matches the correct result above — same byte count, different word.
    const wrong = shapeArabic(toVisualOrder('مرحبا'));
    expect(points(wrong)).toEqual(['0xfe8d', '0xfe91', '0xfea4', '0xfeae', '0xfee1']);
    expect(points(wrong)).not.toEqual(points(shapeArabic('مرحبا')));
  });

  it('forms the lam-alef ligature, which the wrong order never can', () => {
    // Logical order: lam then alef, so the pair collapses into one glyph.
    expect(points(shapeArabic('لا'))).toEqual(['0xfefb']);
    // Reordered first, the alef precedes the lam and no ligature exists.
    expect(points(shapeArabic(toVisualOrder('لا')))).toEqual(['0xfe8d', '0xfedd']);
  });

  it('uses the final lam-alef form when a letter joins into it', () => {
    expect(points(shapeArabic('بلا'))).toEqual(['0xfe91', '0xfefc']);
  });

  it('leaves right-joining letters unjoined to what follows', () => {
    // dal and ra join only backwards, so neither connects onward.
    expect(points(shapeArabic('در'))).toEqual(['0xfea9', '0xfead']);
    // waw likewise: و ر د is three isolated forms.
    expect(points(shapeArabic('ورد'))).toEqual(['0xfeed', '0xfead', '0xfea9']);
  });
});
