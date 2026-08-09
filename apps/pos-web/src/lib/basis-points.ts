/**
 * Basis points as text, without ever becoming a number that can drift.
 *
 * A VAT rate arrives as an exact integer — 1500 is fifteen percent — and the
 * only thing display needs to do is move a decimal point two places. Doing
 * that with `bp / 100` converts an exact value into a binary float and then
 * asks JavaScript to render it: correct today for the rates Saudi Arabia
 * uses, and one 725 away from `7.249999999999999`. There is no reason to take
 * the risk when the answer is integer division and a string.
 *
 * Rendered with Western digits and a dot, which is what `Numeric` isolates and
 * what a ZATCA invoice shows. Trailing zeros are dropped: 750 reads "7.5%",
 * not "7.50%".
 */
export function formatBasisPoints(basisPoints: number): string {
  if (!Number.isInteger(basisPoints)) {
    throw new TypeError(`Basis points must be an integer: ${String(basisPoints)}`);
  }
  if (basisPoints < 0 || basisPoints > 10_000) {
    throw new RangeError(`Basis points out of range: ${String(basisPoints)}`);
  }

  // Integer division and remainder, on values that cannot lose precision.
  const value = BigInt(basisPoints);
  const whole = value / 100n;
  const fraction = value % 100n;

  if (fraction === 0n) return `${whole.toString()}%`;

  const digits = fraction.toString().padStart(2, '0');
  const trimmed = digits.endsWith('0') ? digits.slice(0, 1) : digits;
  return `${whole.toString()}.${trimmed}%`;
}
