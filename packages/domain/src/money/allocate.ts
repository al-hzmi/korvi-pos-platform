import { InvalidAmountError } from '../errors.js';
import type { Money } from './money.js';

/**
 * Split `total` across `weights` so that nothing is created or destroyed.
 *
 * Uses the largest-remainder method: give everyone their floor share, then hand
 * the leftover minor units out one at a time to the largest fractional
 * remainders, breaking ties by index so the result is deterministic — the same
 * inputs give the same split on the terminal, on the server, and in a test.
 *
 * The post-condition that matters:
 *
 *     sum(allocate(total, weights)) === total
 *
 * always, for every input, including negative totals and lopsided weights.
 * A discount that does not satisfy this is a discount that leaks halalas.
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) {
    throw new InvalidAmountError('allocate: needs at least one weight.');
  }
  if (weights.some((weight) => weight < 0n)) {
    throw new InvalidAmountError('allocate: weights must not be negative.');
  }

  const totalWeight = weights.reduce((acc, weight) => acc + weight, 0n);
  if (totalWeight === 0n) {
    throw new InvalidAmountError('allocate: weights must not sum to zero.');
  }

  // Work on the magnitude so bigint truncation is always toward zero, then
  // re-apply the sign. Allocating -100 must mirror allocating +100 exactly.
  const negative = total < 0n;
  const magnitude = negative ? -total : total;

  const shares: bigint[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let distributed = 0n;

  for (let index = 0; index < weights.length; index += 1) {
    const weight = weights[index] ?? 0n;
    const scaled = magnitude * weight;
    const share = scaled / totalWeight;
    shares.push(share);
    remainders.push({ index, remainder: scaled % totalWeight });
    distributed += share;
  }

  let leftover = magnitude - distributed;

  remainders.sort((a, b) => {
    if (a.remainder === b.remainder) return a.index - b.index;
    return a.remainder > b.remainder ? -1 : 1;
  });

  for (const entry of remainders) {
    if (leftover <= 0n) break;
    shares[entry.index] = (shares[entry.index] ?? 0n) + 1n;
    leftover -= 1n;
  }

  return negative ? shares.map((share) => -share) : shares;
}

/** `allocate` lifted to Money, preserving the currency of the total. */
export function allocateMoney(total: Money, weights: readonly bigint[]): Money[] {
  return allocate(total.minor, weights).map((minor) => ({ currency: total.currency, minor }));
}

/** Split evenly across `parts`, leftover halalas going to the earliest parts. */
export function allocateEvenly(total: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new InvalidAmountError('allocateEvenly: parts must be a positive integer.');
  }
  return allocateMoney(total, new Array<bigint>(parts).fill(1n));
}
