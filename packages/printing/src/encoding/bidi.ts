/**
 * Visual reordering for print heads with no bidi algorithm.
 *
 * A legacy head emits bytes strictly left to right. Handed logical-order
 * Arabic it prints the first letter leftmost, so the word reads backwards.
 *
 * SCOPE. This is a deliberate subset of UAX #9, not an implementation of it:
 * runs are classified strong-RTL, strong-LTR or neutral, RTL runs are reversed,
 * and neutrals between two RTL runs are absorbed. It handles what a receipt
 * actually contains — Arabic prose with embedded Latin item codes and Western
 * digits. It does not handle explicit directional overrides, isolates, or
 * nested level changes beyond depth one. A line needing those belongs on the
 * raster path, where the renderer runs the real algorithm.
 *
 * Numbers are never reversed: "115.00" must print as "115.00" in any context,
 * which is the same rule the screen enforces through `.numeric`.
 */

type Direction = 'rtl' | 'ltr' | 'neutral';

function directionOf(codePoint: number): Direction {
  // Arabic, Arabic Supplement, Presentation Forms A and B, Hebrew.
  if (
    (codePoint >= 0x0590 && codePoint <= 0x05ff) ||
    (codePoint >= 0x0600 && codePoint <= 0x06ff) ||
    (codePoint >= 0x0750 && codePoint <= 0x077f) ||
    (codePoint >= 0xfb50 && codePoint <= 0xfdff) ||
    (codePoint >= 0xfe70 && codePoint <= 0xfeff)
  ) {
    return 'rtl';
  }
  // Latin letters and Western digits are strong LTR for our purposes: a price
  // or a SKU keeps its order regardless of the surrounding script.
  if (
    (codePoint >= 0x0030 && codePoint <= 0x0039) ||
    (codePoint >= 0x0041 && codePoint <= 0x005a) ||
    (codePoint >= 0x0061 && codePoint <= 0x007a) ||
    (codePoint >= 0x00c0 && codePoint <= 0x024f)
  ) {
    return 'ltr';
  }
  return 'neutral';
}

interface Run {
  readonly direction: Direction;
  readonly text: string;
}

function segment(input: string): Run[] {
  const runs: Run[] = [];
  let current: Direction | null = null;
  let buffer = '';

  for (const character of input) {
    const direction = directionOf(character.codePointAt(0) ?? 0);
    if (direction === current) {
      buffer += character;
    } else {
      if (current !== null) runs.push({ direction: current, text: buffer });
      current = direction;
      buffer = character;
    }
  }
  if (current !== null) runs.push({ direction: current, text: buffer });
  return runs;
}

/**
 * Reorder a logical-order string into the visual order a legacy head needs.
 *
 * Returns the input unchanged when it contains no RTL, so Latin-only receipts
 * are untouched.
 */
export function toVisualOrder(input: string): string {
  const runs = segment(input);
  if (!runs.some((run) => run.direction === 'rtl')) return input;

  // A neutral flanked by the same direction on both sides takes that
  // direction. This is UAX #9 rule N1, and it is load-bearing twice over: a
  // space between two Arabic words belongs to the Arabic, and — less obviously
  // — the decimal point inside "115.00" belongs to the number. Without the
  // second case the price is split into three runs and printed as "00.115".
  const resolved: Run[] = runs.map((run, index) => {
    if (run.direction !== 'neutral') return run;
    const before = runs[index - 1]?.direction;
    const after = runs[index + 1]?.direction;
    return before !== undefined && before === after ? { direction: before, text: run.text } : run;
  });

  // Merge adjacent RTL runs so a reversal spans the whole phrase.
  const merged: Run[] = [];
  for (const run of resolved) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.direction === run.direction) {
      merged[merged.length - 1] = { direction: run.direction, text: last.text + run.text };
    } else {
      merged.push(run);
    }
  }

  const pieces = merged.map((run) =>
    run.direction === 'rtl' ? [...run.text].reverse().join('') : run.text,
  );

  // The line as a whole is RTL, so the run order reverses too.
  return pieces.reverse().join('');
}
