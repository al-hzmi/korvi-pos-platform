import { describe, expect, it } from 'vitest';
import {
  createUuidV7Generator,
  isUuidV7,
  timestampOfUuidV7,
  type Clock,
  type RandomSource,
} from '../uuidv7.js';
import { IdGenerationError } from '../../errors.js';

/** A clock the test drives, so ordering assertions are not timing-dependent. */
function fixedClock(start: number): Clock & { set(value: number): void } {
  let current = start;
  return {
    now: () => current,
    set: (value: number) => {
      current = value;
    },
  };
}

/** Deterministic bytes, so the only varying part is what the generator sets. */
const constantRandom: RandomSource = {
  fill(target: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    target.fill(0xab);
    return target;
  },
};

/** Worst case for counter headroom: seeds the counter as high as allowed. */
const maxRandom: RandomSource = {
  fill(target: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    target.fill(0xff);
    return target;
  },
};

const isSorted = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || (values[index - 1] as string) < value);

describe('UUIDv7 format', () => {
  it('emits the version and variant bits RFC 9562 requires', () => {
    const generator = createUuidV7Generator({ random: constantRandom });
    for (let index = 0; index < 50; index += 1) {
      expect(isUuidV7(generator.next())).toBe(true);
    }
  });

  it('embeds the millisecond timestamp', () => {
    const clock = fixedClock(1_754_000_000_000);
    const generator = createUuidV7Generator({ clock, random: constantRandom });
    expect(timestampOfUuidV7(generator.next())).toBe(1_754_000_000_000);
  });

  it('leaves the trailing entropy bytes untouched', () => {
    // Bytes 12-15 must stay random; without them ids become guessable.
    const a = createUuidV7Generator().next();
    const b = createUuidV7Generator().next();
    expect(a.slice(-8)).not.toBe(b.slice(-8));
  });
});

describe('ordering across milliseconds', () => {
  it('sorts lexicographically in creation order', () => {
    const clock = fixedClock(1_000_000_000_000);
    const generator = createUuidV7Generator({ clock, random: constantRandom });

    const ids: string[] = [];
    for (let index = 0; index < 500; index += 1) {
      clock.set(1_000_000_000_000 + index);
      ids.push(generator.next());
    }

    expect(isSorted(ids)).toBe(true);
  });
});

describe('counter exhaustion', () => {
  it('stays monotonic well beyond 4096 ids in one millisecond', () => {
    // Revision 1 used a 12-bit counter that wrapped silently at 4096, so id
    // 4097 sorted *before* id 4096 and the sale order inverted undetectably.
    const clock = fixedClock(1_700_000_000_000);
    const generator = createUuidV7Generator({ clock, random: constantRandom });

    const ids: string[] = [];
    for (let index = 0; index < 20_000; index += 1) {
      ids.push(generator.next());
    }

    expect(new Set(ids).size).toBe(20_000);
    expect(isSorted(ids)).toBe(true);
  });

  it('holds ordering at exactly the old 4096 boundary', () => {
    const clock = fixedClock(1_700_000_000_000);
    const generator = createUuidV7Generator({ clock, random: constantRandom });

    const ids: string[] = [];
    for (let index = 0; index < 4_100; index += 1) {
      ids.push(generator.next());
    }

    expect(isSorted(ids)).toBe(true);
    // The old implementation produced a duplicate-or-lower id here.
    expect((ids[4_096] as string) > (ids[4_095] as string)).toBe(true);
  });

  it('borrows a future millisecond instead of wrapping when the counter runs out', () => {
    // Narrowed to revision 1's 12-bit counter so exhaustion is reachable; at
    // the production width of 42 bits this path needs ~2^41 calls. The logic
    // under test is identical, only the width differs.
    const clock = fixedClock(1_700_000_000_000);
    const generator = createUuidV7Generator({
      clock,
      random: maxRandom,
      counterBits: 12,
    });

    const ids: string[] = [];
    for (let index = 0; index < 20_000; index += 1) {
      ids.push(generator.next());
    }

    expect(isSorted(ids)).toBe(true);
    expect(new Set(ids).size).toBe(20_000);
    // Borrowing shows up as a timestamp ahead of the frozen clock. Revision 1
    // wrapped here and emitted a lower id instead.
    expect(timestampOfUuidV7(ids[19_999] as string)).toBeGreaterThan(1_700_000_000_000);
  });

  it('refuses when borrowing would drift past the tolerance', () => {
    const clock = fixedClock(1_700_000_000_000);
    const generator = createUuidV7Generator({
      clock,
      random: maxRandom,
      counterBits: 12,
      maxDriftMs: 0,
    });

    // Zero tolerance: the first borrow must throw rather than invent time.
    expect(() => {
      for (let index = 0; index < 20_000; index += 1) generator.next();
    }).toThrow(IdGenerationError);
  });

  it('rejects a counter width outside the supported range', () => {
    expect(() => createUuidV7Generator({ counterBits: 8 })).toThrow(IdGenerationError);
    expect(() => createUuidV7Generator({ counterBits: 64 })).toThrow(IdGenerationError);
  });
});

describe('clock rollback', () => {
  it('keeps ordering when the clock jumps backwards', () => {
    // NTP correction mid-shift, or a merchant fixing the till clock.
    const clock = fixedClock(1_700_000_005_000);
    const generator = createUuidV7Generator({ clock, random: constantRandom });

    const before: string[] = [];
    for (let index = 0; index < 10; index += 1) before.push(generator.next());

    clock.set(1_700_000_004_000); // one second backwards

    const after: string[] = [];
    for (let index = 0; index < 10; index += 1) after.push(generator.next());

    const all = [...before, ...after];
    expect(isSorted(all)).toBe(true);
    expect(new Set(all).size).toBe(all.length);
  });

  it('never emits a timestamp below the highest already issued', () => {
    const clock = fixedClock(1_700_000_005_000);
    const generator = createUuidV7Generator({ clock, random: constantRandom });

    const first = generator.next();
    clock.set(1_700_000_000_000); // five seconds backwards
    const second = generator.next();

    expect(timestampOfUuidV7(second)).toBeGreaterThanOrEqual(timestampOfUuidV7(first));
    expect(second > first).toBe(true);
  });

  it('recovers once the clock passes the previous high-water mark', () => {
    const clock = fixedClock(1_700_000_005_000);
    const generator = createUuidV7Generator({ clock, random: constantRandom });

    const first = generator.next();
    clock.set(1_700_000_004_000);
    const during = generator.next();
    clock.set(1_700_000_009_000);
    const after = generator.next();

    expect(isSorted([first, during, after])).toBe(true);
    expect(timestampOfUuidV7(after)).toBe(1_700_000_009_000);
  });

  it('refuses a rollback beyond the tolerance rather than issuing a wrong id', () => {
    const clock = fixedClock(1_700_000_000_000);
    const generator = createUuidV7Generator({ clock, random: constantRandom, maxDriftMs: 1_000 });

    generator.next();
    clock.set(1_699_999_000_000); // a thousand seconds backwards

    expect(() => generator.next()).toThrow(IdGenerationError);
    expect(() => generator.next()).toThrow(/backwards/i);
  });
});

describe('input validation', () => {
  it('rejects a clock outside the 48-bit range', () => {
    const generator = createUuidV7Generator({
      clock: { now: () => 2 ** 49 },
      random: constantRandom,
    });
    expect(() => generator.next()).toThrow(IdGenerationError);
  });

  it('rejects a non-finite clock', () => {
    const generator = createUuidV7Generator({
      clock: { now: () => Number.NaN },
      random: constantRandom,
    });
    expect(() => generator.next()).toThrow(IdGenerationError);
  });

  it('rejects a negative clock', () => {
    const generator = createUuidV7Generator({
      clock: { now: () => -1 },
      random: constantRandom,
    });
    expect(() => generator.next()).toThrow(IdGenerationError);
  });

  it('rejects a nonsensical drift tolerance', () => {
    expect(() => createUuidV7Generator({ maxDriftMs: -1 })).toThrow(IdGenerationError);
    expect(() => createUuidV7Generator({ maxDriftMs: 1.5 })).toThrow(IdGenerationError);
  });
});

describe('real entropy', () => {
  it('produces distinct, ordered ids under the system clock', () => {
    const generator = createUuidV7Generator();
    const ids: string[] = [];
    for (let index = 0; index < 5_000; index += 1) ids.push(generator.next());

    expect(new Set(ids).size).toBe(5_000);
    expect(isSorted(ids)).toBe(true);
  });
});
