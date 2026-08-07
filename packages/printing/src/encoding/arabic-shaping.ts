/**
 * Arabic contextual shaping — Unicode Arabic Presentation Forms-B.
 *
 * Arabic letters change shape according to their neighbours: isolated, initial,
 * medial or final. Unicode text stores the base letter and leaves joining to
 * the renderer, which is right for a screen and wrong for a legacy print head
 * that has no renderer. Sending base letters to a CP864 device produces
 * disconnected letterforms — readable-ish to a machine, wrong to a customer.
 *
 * `calt` in the design system does this job on screen (KORVI-DESIGN-SYSTEM.md
 * §4.3). This is the same operation for paper.
 */

interface Forms {
  readonly isolated: number;
  readonly final: number;
  readonly initial: number;
  readonly medial: number;
}

/**
 * Joining behaviour.
 *
 * `dual` letters join on both sides. `right` letters (the alef family, dal,
 * thal, ra, zay, waw) accept a join only from the preceding letter, which is
 * why words containing them break into visual clusters.
 */
const DUAL = 'dual';
const RIGHT = 'right';

interface Entry {
  readonly join: typeof DUAL | typeof RIGHT;
  readonly forms: Forms;
}

/** Base letter -> presentation forms. Values are the Forms-B code points. */
const TABLE = new Map<number, Entry>([
  [
    0x0621,
    { join: RIGHT, forms: { isolated: 0xfe80, final: 0xfe80, initial: 0xfe80, medial: 0xfe80 } },
  ], // ء
  [
    0x0622,
    { join: RIGHT, forms: { isolated: 0xfe81, final: 0xfe82, initial: 0xfe81, medial: 0xfe82 } },
  ], // آ
  [
    0x0623,
    { join: RIGHT, forms: { isolated: 0xfe83, final: 0xfe84, initial: 0xfe83, medial: 0xfe84 } },
  ], // أ
  [
    0x0624,
    { join: RIGHT, forms: { isolated: 0xfe85, final: 0xfe86, initial: 0xfe85, medial: 0xfe86 } },
  ], // ؤ
  [
    0x0625,
    { join: RIGHT, forms: { isolated: 0xfe87, final: 0xfe88, initial: 0xfe87, medial: 0xfe88 } },
  ], // إ
  [
    0x0626,
    { join: DUAL, forms: { isolated: 0xfe89, final: 0xfe8a, initial: 0xfe8b, medial: 0xfe8c } },
  ], // ئ
  [
    0x0627,
    { join: RIGHT, forms: { isolated: 0xfe8d, final: 0xfe8e, initial: 0xfe8d, medial: 0xfe8e } },
  ], // ا
  [
    0x0628,
    { join: DUAL, forms: { isolated: 0xfe8f, final: 0xfe90, initial: 0xfe91, medial: 0xfe92 } },
  ], // ب
  [
    0x0629,
    { join: RIGHT, forms: { isolated: 0xfe93, final: 0xfe94, initial: 0xfe93, medial: 0xfe94 } },
  ], // ة
  [
    0x062a,
    { join: DUAL, forms: { isolated: 0xfe95, final: 0xfe96, initial: 0xfe97, medial: 0xfe98 } },
  ], // ت
  [
    0x062b,
    { join: DUAL, forms: { isolated: 0xfe99, final: 0xfe9a, initial: 0xfe9b, medial: 0xfe9c } },
  ], // ث
  [
    0x062c,
    { join: DUAL, forms: { isolated: 0xfe9d, final: 0xfe9e, initial: 0xfe9f, medial: 0xfea0 } },
  ], // ج
  [
    0x062d,
    { join: DUAL, forms: { isolated: 0xfea1, final: 0xfea2, initial: 0xfea3, medial: 0xfea4 } },
  ], // ح
  [
    0x062e,
    { join: DUAL, forms: { isolated: 0xfea5, final: 0xfea6, initial: 0xfea7, medial: 0xfea8 } },
  ], // خ
  [
    0x062f,
    { join: RIGHT, forms: { isolated: 0xfea9, final: 0xfeaa, initial: 0xfea9, medial: 0xfeaa } },
  ], // د
  [
    0x0630,
    { join: RIGHT, forms: { isolated: 0xfeab, final: 0xfeac, initial: 0xfeab, medial: 0xfeac } },
  ], // ذ
  [
    0x0631,
    { join: RIGHT, forms: { isolated: 0xfead, final: 0xfeae, initial: 0xfead, medial: 0xfeae } },
  ], // ر
  [
    0x0632,
    { join: RIGHT, forms: { isolated: 0xfeaf, final: 0xfeb0, initial: 0xfeaf, medial: 0xfeb0 } },
  ], // ز
  [
    0x0633,
    { join: DUAL, forms: { isolated: 0xfeb1, final: 0xfeb2, initial: 0xfeb3, medial: 0xfeb4 } },
  ], // س
  [
    0x0634,
    { join: DUAL, forms: { isolated: 0xfeb5, final: 0xfeb6, initial: 0xfeb7, medial: 0xfeb8 } },
  ], // ش
  [
    0x0635,
    { join: DUAL, forms: { isolated: 0xfeb9, final: 0xfeba, initial: 0xfebb, medial: 0xfebc } },
  ], // ص
  [
    0x0636,
    { join: DUAL, forms: { isolated: 0xfebd, final: 0xfebe, initial: 0xfebf, medial: 0xfec0 } },
  ], // ض
  [
    0x0637,
    { join: DUAL, forms: { isolated: 0xfec1, final: 0xfec2, initial: 0xfec3, medial: 0xfec4 } },
  ], // ط
  [
    0x0638,
    { join: DUAL, forms: { isolated: 0xfec5, final: 0xfec6, initial: 0xfec7, medial: 0xfec8 } },
  ], // ظ
  [
    0x0639,
    { join: DUAL, forms: { isolated: 0xfec9, final: 0xfeca, initial: 0xfecb, medial: 0xfecc } },
  ], // ع
  [
    0x063a,
    { join: DUAL, forms: { isolated: 0xfecd, final: 0xfece, initial: 0xfecf, medial: 0xfed0 } },
  ], // غ
  [
    0x0641,
    { join: DUAL, forms: { isolated: 0xfed1, final: 0xfed2, initial: 0xfed3, medial: 0xfed4 } },
  ], // ف
  [
    0x0642,
    { join: DUAL, forms: { isolated: 0xfed5, final: 0xfed6, initial: 0xfed7, medial: 0xfed8 } },
  ], // ق
  [
    0x0643,
    { join: DUAL, forms: { isolated: 0xfed9, final: 0xfeda, initial: 0xfedb, medial: 0xfedc } },
  ], // ك
  [
    0x0644,
    { join: DUAL, forms: { isolated: 0xfedd, final: 0xfede, initial: 0xfedf, medial: 0xfee0 } },
  ], // ل
  [
    0x0645,
    { join: DUAL, forms: { isolated: 0xfee1, final: 0xfee2, initial: 0xfee3, medial: 0xfee4 } },
  ], // م
  [
    0x0646,
    { join: DUAL, forms: { isolated: 0xfee5, final: 0xfee6, initial: 0xfee7, medial: 0xfee8 } },
  ], // ن
  [
    0x0647,
    { join: DUAL, forms: { isolated: 0xfee9, final: 0xfeea, initial: 0xfeeb, medial: 0xfeec } },
  ], // ه
  [
    0x0648,
    { join: RIGHT, forms: { isolated: 0xfeed, final: 0xfeee, initial: 0xfeed, medial: 0xfeee } },
  ], // و
  [
    0x0649,
    { join: DUAL, forms: { isolated: 0xfeef, final: 0xfef0, initial: 0xfeef, medial: 0xfef0 } },
  ], // ى
  [
    0x064a,
    { join: DUAL, forms: { isolated: 0xfef1, final: 0xfef2, initial: 0xfef3, medial: 0xfef4 } },
  ], // ي
]);

/**
 * Lam-alef: a mandatory ligature, not a stylistic option.
 *
 * Arabic has no way to write lam followed by alef as two separate glyphs; the
 * combined form is the only correct rendering. Skipping this is the single most
 * visible shaping bug on a receipt.
 */
const LAM = 0x0644;
const LAM_ALEF = new Map<number, { isolated: number; final: number }>([
  [0x0622, { isolated: 0xfef5, final: 0xfef6 }],
  [0x0623, { isolated: 0xfef7, final: 0xfef8 }],
  [0x0625, { isolated: 0xfef9, final: 0xfefa }],
  [0x0627, { isolated: 0xfefb, final: 0xfefc }],
]);

/** Diacritics are transparent to joining — they must not break a connection. */
function isTransparent(codePoint: number): boolean {
  return (
    (codePoint >= 0x064b && codePoint <= 0x065f) ||
    codePoint === 0x0670 ||
    (codePoint >= 0x06d6 && codePoint <= 0x06ed)
  );
}

function joinsForward(codePoint: number | undefined): boolean {
  if (codePoint === undefined) return false;
  return TABLE.get(codePoint)?.join === DUAL;
}

function joinsBackward(codePoint: number | undefined): boolean {
  return codePoint !== undefined && TABLE.has(codePoint);
}

/**
 * Convert base Arabic letters into their contextual presentation forms.
 *
 * Non-Arabic code points pass through untouched, so a mixed line keeps its
 * Latin and its digits intact.
 */
export function shapeArabic(input: string): string {
  const points = [...input].map((character) => character.codePointAt(0) ?? 0);
  const out: number[] = [];

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index] as number;
    const entry = TABLE.get(current);

    if (entry === undefined) {
      out.push(current);
      continue;
    }

    let previous: number | undefined;
    for (let back = index - 1; back >= 0; back -= 1) {
      const candidate = points[back] as number;
      if (!isTransparent(candidate)) {
        previous = candidate;
        break;
      }
    }

    let next: number | undefined;
    let nextIndex = -1;
    for (let forward = index + 1; forward < points.length; forward += 1) {
      const candidate = points[forward] as number;
      if (!isTransparent(candidate)) {
        next = candidate;
        nextIndex = forward;
        break;
      }
    }

    const connectsBefore = joinsForward(previous);

    if (current === LAM && next !== undefined && LAM_ALEF.has(next)) {
      const ligature = LAM_ALEF.get(next) as { isolated: number; final: number };
      out.push(connectsBefore ? ligature.final : ligature.isolated);
      index = nextIndex; // the alef is consumed by the ligature
      continue;
    }

    const connectsAfter = joinsBackward(next) && entry.join === DUAL;

    if (connectsBefore && connectsAfter) out.push(entry.forms.medial);
    else if (connectsBefore) out.push(entry.forms.final);
    else if (connectsAfter) out.push(entry.forms.initial);
    else out.push(entry.forms.isolated);
  }

  return String.fromCodePoint(...out);
}
