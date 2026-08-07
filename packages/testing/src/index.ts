import type { Clock, RandomSource } from '@korvi/domain';

/**
 * Determinism helpers.
 *
 * Anything that reads the wall clock or the entropy pool is untestable by
 * definition, so the domain takes both as interfaces and this package supplies
 * the fakes. A test that has to sleep to observe ordering is a test that will
 * eventually fail on a loaded CI runner.
 */

export interface ControllableClock extends Clock {
  set(milliseconds: number): void;
  advance(milliseconds: number): void;
}

export function controllableClock(start = 1_700_000_000_000): ControllableClock {
  let current = start;
  return {
    now: () => current,
    set: (milliseconds: number) => {
      current = milliseconds;
    },
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
  };
}

/**
 * A counter-based byte source. Not cryptographic and not pretending to be —
 * its whole job is to make a generated id reproducible in an assertion.
 */
export function seededRandom(seed = 1): RandomSource {
  let state = seed >>> 0;
  return {
    fill(target: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
      for (let index = 0; index < target.length; index += 1) {
        state = (state * 1_664_525 + 1_013_904_223) >>> 0;
        target[index] = (state >>> 24) & 0xff;
      }
      return target;
    },
  };
}
