import { MissingCapabilityError } from './errors.js';
import type { PrinterProfile } from './profiles/types.js';

/**
 * Native ESC/POS QR, via the `GS ( k` symbol-storage function set.
 *
 * The ZATCA payload has to reach the customer as a scannable symbol; a receipt
 * carrying the Base64 as text is not a compliant simplified tax invoice. This
 * is why QR support is a declared capability rather than an afterthought — on a
 * device without the firmware, these command bytes print as literal characters
 * across the paper.
 */

const GS = 0x1d;
const FN_MODEL = 0x41;
const FN_SIZE = 0x43;
const FN_ERROR_CORRECTION = 0x45;
const FN_STORE = 0x50;
const FN_PRINT = 0x51;

/**
 * Error-correction level.
 *
 * `M` (15%) is the default here: a thermal receipt smudges and is often
 * scanned from a phone at an angle, and `L` leaves too little margin. `Q` and
 * `H` inflate the symbol enough to matter on 80mm paper.
 */
export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

const EC_LEVEL: Record<QrErrorCorrection, number> = { L: 48, M: 49, Q: 50, H: 51 };

export interface QrOptions {
  /** Module size in dots, 1-16. 6 keeps a ZATCA payload scannable on 80mm. */
  readonly moduleSize?: number;
  readonly errorCorrection?: QrErrorCorrection;
}

function header(dataLength: number, functionCode: number): number[] {
  // pL, pH count the payload plus the two-byte function prefix.
  const length = dataLength + 3;
  return [GS, 0x28, 0x6b, length & 0xff, (length >> 8) & 0xff, 0x31, functionCode];
}

/**
 * Build the full command sequence for one QR symbol.
 *
 * The payload is Latin-1 by construction — the ZATCA QR carries Base64 — so it
 * is written byte-for-byte and never passed through a code page.
 */
export function qrCommand(
  profile: PrinterProfile,
  payload: string,
  options: QrOptions = {},
): Uint8Array {
  if (profile.capabilities.qr !== 'native') {
    throw new MissingCapabilityError(
      `Profile "${profile.id}" declares qr="${profile.capabilities.qr}"; ` +
        'render the symbol with a RasterRenderer instead of emitting GS ( k.',
    );
  }

  const moduleSize = options.moduleSize ?? 6;
  if (!Number.isInteger(moduleSize) || moduleSize < 1 || moduleSize > 16) {
    throw new MissingCapabilityError('QR module size must be an integer between 1 and 16.');
  }

  const bytes: number[] = [];

  // Model 2 — the only model in general use.
  bytes.push(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, FN_MODEL, 0x32, 0x00);
  // Module size.
  bytes.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, FN_SIZE, moduleSize);
  // Error correction.
  bytes.push(
    GS,
    0x28,
    0x6b,
    0x03,
    0x00,
    0x31,
    FN_ERROR_CORRECTION,
    EC_LEVEL[options.errorCorrection ?? 'M'],
  );

  // Store the payload in the symbol buffer.
  const data: number[] = [];
  for (const character of payload) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint > 0xff) {
      throw new MissingCapabilityError(
        'QR payload must be single-byte; the ZATCA payload is Base64 by construction.',
      );
    }
    data.push(codePoint);
  }
  bytes.push(...header(data.length, FN_STORE), 0x30, ...data);

  // Print it.
  bytes.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, FN_PRINT, 0x30);

  return Uint8Array.from(bytes);
}
