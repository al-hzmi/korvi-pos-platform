import { InvalidAmountError } from '../errors.js';

/**
 * Quantity as a scaled integer.
 *
 * A grocery scale reports 0.125 kg, and `0.1 + 0.2 !== 0.3` applies to weights
 * exactly as it applies to money. Multiplying a floating weight by a price in
 * halalas reintroduces the drift ADR-0002 exists to prevent, one line at a
 * time, so quantity gets the same treatment money already has.
 *
 * Scale is fixed at 1e-3: milligram-per-gram resolution for weighed goods, and
 * exact for whole units. Three decimals is what retail scales report and what
 * ZATCA line quantities carry.
 */
export const QUANTITY_SCALE = 1_000n;
export const QUANTITY_DECIMALS = 3;

export type Quantity = bigint & { readonly __brand: 'Quantity' };

export function quantity(scaled: bigint): Quantity {
  if (scaled < 0n) {
    throw new InvalidAmountError(`Quantity must not be negative, got ${scaled.toString()}.`);
  }
  return scaled as Quantity;
}

/** Whole units: `units(3)` is three items. */
export function units(count: number): Quantity {
  if (!Number.isInteger(count) || count < 0) {
    throw new InvalidAmountError(
      `Unit count must be a non-negative integer, got ${String(count)}.`,
    );
  }
  return quantity(BigInt(count) * QUANTITY_SCALE);
}

export const ONE_UNIT: Quantity = units(1);
export const ZERO_QUANTITY: Quantity = quantity(0n);

/**
 * Parse "1.125" without a float.
 *
 * The same textual route money takes, and for the same reason: a scale reading
 * arrives as a decimal string, and `Number()` on it is where the drift starts.
 */
export function quantityFromDecimalString(input: string): Quantity {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (match === null) {
    throw new InvalidAmountError(`Not a decimal quantity: "${input}".`);
  }
  const fraction = match[2] ?? '';
  if (fraction.length > QUANTITY_DECIMALS) {
    throw new InvalidAmountError(
      `"${input}" is finer than ${String(QUANTITY_DECIMALS)} decimal places; refusing to round.`,
    );
  }
  const whole = BigInt(match[1] ?? '0');
  const padded = fraction.padEnd(QUANTITY_DECIMALS, '0');
  return quantity(whole * QUANTITY_SCALE + BigInt(padded === '' ? '0' : padded));
}

export function quantityToDecimalString(value: Quantity): string {
  const whole = value / QUANTITY_SCALE;
  const fraction = value % QUANTITY_SCALE;
  return `${whole.toString()}.${fraction.toString().padStart(QUANTITY_DECIMALS, '0')}`;
}

/** Trim trailing zeros for display: 2.000 -> "2", 0.500 -> "0.5". */
export function quantityToDisplayString(value: Quantity): string {
  const text = quantityToDecimalString(value);
  return text.replace(/\.?0+$/, '') || '0';
}

export function addQuantity(a: Quantity, b: Quantity): Quantity {
  return quantity(a + b);
}

export function subtractQuantity(a: Quantity, b: Quantity): Quantity {
  if (b > a) {
    throw new InvalidAmountError('Quantity would go negative.');
  }
  return quantity(a - b);
}

export function isWholeUnits(value: Quantity): boolean {
  return value % QUANTITY_SCALE === 0n;
}

export function compareQuantity(a: Quantity, b: Quantity): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function quantityToJson(value: Quantity): string {
  return value.toString();
}

export function quantityFromJson(value: string): Quantity {
  if (!/^\d+$/.test(value)) {
    throw new InvalidAmountError(`Scaled quantity must be a non-negative integer string.`);
  }
  return quantity(BigInt(value));
}
