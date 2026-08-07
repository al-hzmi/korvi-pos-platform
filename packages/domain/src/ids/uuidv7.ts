import { IdGenerationError } from '../errors.js';

/**
 * Monotonic UUIDv7, per RFC 9562 §5.7 and the "replace leftmost random bits
 * with increased clock precision" / dedicated-counter guidance in §6.2.
 *
 * v7 carries a 48-bit millisecond timestamp in its high bits, so identifiers
 * sort into creation order as plain strings. That is what lets an offline
 * terminal mint ids for hours and have the server replay them in the order the
 * sales actually happened (ADR-0003).
 *
 * The ordering guarantee is only worth having if it cannot break, so three
 * failure modes are handled explicitly rather than left to chance:
 *
 *   Counter exhaustion. Bursts share a millisecond. A 12-bit counter wrapping
 *     silently at 4096 produces a *lower* id than the one before it, which
 *     inverts the sale order and cannot be detected after the fact. Here the
 *     counter is 42 bits (12 in rand_a + 30 in rand_b), and on exhaustion the
 *     generator borrows a millisecond from the future rather than wrapping.
 *
 *   Clock rollback. NTP corrections and a merchant fixing the till clock both
 *     move time backwards. A naive generator then emits ids that sort before
 *     already-issued ones. Here the last-issued timestamp is a floor: the
 *     generator never emits below it, so ordering survives the correction.
 *
 *   Unbounded drift. Borrowing and floors are only safe while the gap stays
 *     small. Past a bounded tolerance the generator refuses rather than
 *     inventing a timestamp far from real time — a hard failure is recoverable,
 *     a silently wrong chronology is not.
 */

export interface Clock {
  now(): number;
}

/**
 * The `ArrayBuffer` generic is load-bearing: `crypto.getRandomValues` refuses a
 * view backed by a `SharedArrayBuffer`, so a bare `Uint8Array` -- which widens
 * to `ArrayBufferLike` -- does not satisfy it.
 */
export interface RandomSource {
  fill(target: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
}

export interface IdGenerator {
  next(): string;
}

export const systemClock: Clock = { now: () => Date.now() };

export const systemRandom: RandomSource = {
  fill(target: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
    globalThis.crypto.getRandomValues(target);
    return target;
  },
};

const UUID_BYTES = 16;
const MAX_TIMESTAMP = 0xffff_ffff_ffffn;

/**
 * Counter width: 12 bits of rand_a plus the 30 leftmost bits of rand_b.
 *
 * 2^42 is about 4.4e12 ids inside one millisecond -- unreachable by any real
 * terminal, which is the point. 34 bits of rand_b are left untouched so every
 * id still carries entropy and is not guessable from its predecessor.
 */
const COUNTER_BITS = 42n;
const RAND_B_FREE_BITS = 32n;
const MIN_COUNTER_BITS = 12n;

/** How far ahead borrowing may run before the generator refuses. */
const DEFAULT_MAX_DRIFT_MS = 10_000;

export interface UuidV7Options {
  readonly clock?: Clock;
  readonly random?: RandomSource;
  /**
   * Tolerance, in milliseconds, for both counter borrowing and clock rollback.
   * Beyond it the generator throws instead of guessing.
   */
  readonly maxDriftMs?: number;
  /**
   * Usable counter width, for tests only.
   *
   * At the default 42 bits, exhausting the counter inside one millisecond
   * needs on the order of 2^41 calls -- unreachable, which is the point, but
   * it also means the borrow path could never be exercised. Narrowing this to
   * 12 reproduces revision 1's counter width exactly and lets a test prove the
   * generator borrows instead of wrapping. The bit layout does not change.
   */
  readonly counterBits?: number;
}

export function createUuidV7Generator(options: UuidV7Options = {}): IdGenerator {
  const clock = options.clock ?? systemClock;
  const random = options.random ?? systemRandom;
  const maxDriftMs = options.maxDriftMs ?? DEFAULT_MAX_DRIFT_MS;

  if (!Number.isInteger(maxDriftMs) || maxDriftMs < 0) {
    throw new IdGenerationError('maxDriftMs must be a non-negative integer.');
  }

  const counterBits = BigInt(options.counterBits ?? Number(COUNTER_BITS));
  if (counterBits < MIN_COUNTER_BITS || counterBits > COUNTER_BITS) {
    throw new IdGenerationError(
      `counterBits must be between ${MIN_COUNTER_BITS.toString()} and ` +
        `${COUNTER_BITS.toString()}.`,
    );
  }
  const counterMax = (1n << counterBits) - 1n;

  let lastTimestamp = -1n;
  let counter = 0n;

  return {
    next(): string {
      const observed = clock.now();
      if (!Number.isFinite(observed) || observed < 0) {
        throw new IdGenerationError('Clock returned a non-finite or negative timestamp.');
      }

      let timestamp = BigInt(Math.floor(observed));
      if (timestamp > MAX_TIMESTAMP) {
        throw new IdGenerationError('Timestamp exceeds the 48 bits UUIDv7 allows.');
      }

      if (timestamp > lastTimestamp) {
        // Time moved forward: reseed the counter from entropy so consecutive
        // milliseconds do not start from a predictable value.
        lastTimestamp = timestamp;
        counter = randomCounter(random, counterMax);
      } else {
        // Either the same millisecond, or the clock went backwards. Both are
        // handled by refusing to emit below the floor already issued.
        const rollback = lastTimestamp - timestamp;
        if (rollback > BigInt(maxDriftMs)) {
          throw new IdGenerationError(
            `Clock moved backwards by ${rollback.toString()}ms, beyond the ` +
              `${String(maxDriftMs)}ms tolerance. Refusing to issue an identifier ` +
              'that would sort before ones already written.',
          );
        }

        timestamp = lastTimestamp;

        if (counter >= counterMax) {
          // Exhausted inside this millisecond. Borrow the next one rather than
          // wrapping, which would emit a smaller id than the previous.
          const borrowed = lastTimestamp + 1n;
          if (borrowed - BigInt(Math.floor(observed)) > BigInt(maxDriftMs)) {
            throw new IdGenerationError(
              'UUIDv7 counter exhausted and borrowing would drift beyond the ' +
                `${String(maxDriftMs)}ms tolerance.`,
            );
          }
          if (borrowed > MAX_TIMESTAMP) {
            throw new IdGenerationError('Timestamp exceeds the 48 bits UUIDv7 allows.');
          }
          lastTimestamp = borrowed;
          timestamp = borrowed;
          counter = randomCounter(random, counterMax);
        } else {
          counter += 1n;
        }
      }

      return assemble(timestamp, counter, random);
    },
  };
}

/**
 * Seed the counter in the lower half of its range.
 *
 * Starting anywhere in the full range would leave a burst that begins near the
 * top with very little headroom before it has to borrow. Halving the seed
 * guarantees at least 2^41 increments before exhaustion while still keeping the
 * start unpredictable.
 */
function randomCounter(random: RandomSource, counterMax: bigint): bigint {
  const bytes = random.fill(new Uint8Array(new ArrayBuffer(8)));
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return (value & counterMax) >> 1n;
}

function assemble(timestamp: bigint, counter: bigint, random: RandomSource): string {
  const bytes = random.fill(new Uint8Array(new ArrayBuffer(UUID_BYTES)));

  // Bytes 0-5: the 48-bit timestamp, big-endian.
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((timestamp >> BigInt(8 * (5 - index))) & 0xffn);
  }

  // Counter, most significant 12 bits into rand_a (bytes 6-7, low nibble of 6),
  // the remaining 30 into the top of rand_b (bytes 8-11).
  const randA = (counter >> (COUNTER_BITS - 12n)) & 0xfffn;
  const randBHigh = counter & ((1n << (COUNTER_BITS - 12n)) - 1n);

  bytes[6] = 0x70 | Number((randA >> 8n) & 0x0fn); // version 7
  bytes[7] = Number(randA & 0xffn);

  // Byte 8 holds the RFC 9562 variant (10xx) in its top two bits, so only six
  // bits of it are available to the counter.
  const shifted = randBHigh << RAND_B_FREE_BITS; // occupy bits 61..32 of rand_b
  bytes[8] = 0x80 | Number((shifted >> 56n) & 0x3fn);
  bytes[9] = Number((shifted >> 48n) & 0xffn);
  bytes[10] = Number((shifted >> 40n) & 0xffn);
  bytes[11] = Number((shifted >> 32n) & 0xffn);
  // Bytes 12-15 keep their entropy untouched.

  return formatUuid(bytes);
}

function formatUuid(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Extract the embedded millisecond timestamp. Useful for audit tooling. */
export function timestampOfUuidV7(uuid: string): number {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) {
    throw new IdGenerationError(`Not a UUID: "${uuid}".`);
  }
  return Number(BigInt(`0x${hex.slice(0, 12)}`));
}

export function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

/**
 * The process-wide generator.
 *
 * Every identifier in Korvi comes from here or from an injected generator --
 * including infrastructure ids such as HTTP correlation ids. `crypto.randomUUID`
 * returns a v4, which carries no time and therefore cannot be ordered against a
 * sale that synced late (ADR-0003).
 */
export const uuidV7: IdGenerator = createUuidV7Generator();

/** Convenience for callers that just want an id. */
export function newId(): string {
  return uuidV7.next();
}
