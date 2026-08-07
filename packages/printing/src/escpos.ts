import { encodeTextFor } from './encoding/text-encoder.js';
import type { PrinterProfile } from './profiles/types.js';

/**
 * ESC/POS command construction.
 *
 * Byte building only — no transport, no device handle, no DOM. A receipt is a
 * value here, which is what makes it testable: you assert on bytes instead of
 * feeding paper through a printer to find out whether the layout changed.
 *
 * The builder carries a profile so that every text write goes through the
 * encoding pipeline for that device. Revision 1 had a builder with no profile
 * and a single hardcoded UTF-8 path, which is how the Arabic bug got in.
 */

const ESC = 0x1b;
const GS = 0x1d;

export type Alignment = 'start' | 'center' | 'end';

export class EscPosBuilder {
  private readonly chunks: Uint8Array[] = [];

  public constructor(public readonly profile: PrinterProfile) {}

  public get columns(): number {
    return this.profile.capabilities.columns;
  }

  public raw(bytes: Uint8Array): this {
    this.chunks.push(bytes);
    return this;
  }

  /** ESC @ — reset to a known state, then select the profile's code page. */
  public initialise(): this {
    this.raw(Uint8Array.from([ESC, 0x40]));
    const page = this.profile.capabilities.codePageId;
    if (page !== null) {
      this.raw(Uint8Array.from([ESC, 0x74, page & 0xff]));
    }
    return this;
  }

  public align(alignment: Alignment): this {
    const code = alignment === 'start' ? 0 : alignment === 'center' ? 1 : 2;
    return this.raw(Uint8Array.from([ESC, 0x61, code]));
  }

  public bold(on: boolean): this {
    return this.raw(Uint8Array.from([ESC, 0x45, on ? 1 : 0]));
  }

  public doubleHeight(on: boolean): this {
    return this.raw(Uint8Array.from([GS, 0x21, on ? 0x01 : 0x00]));
  }

  /** Encode through the profile's pipeline — never a bare TextEncoder. */
  public text(value: string): this {
    return this.raw(encodeTextFor(this.profile, value));
  }

  public line(value = ''): this {
    return this.text(value).raw(Uint8Array.from([0x0a]));
  }

  /** ASCII rule; written directly because it needs no encoding. */
  public rule(character = '-'): this {
    const width = this.columns;
    return this.raw(Uint8Array.from(Array<number>(width).fill(character.charCodeAt(0)))).raw(
      Uint8Array.from([0x0a]),
    );
  }

  public feed(lines = 1): this {
    return this.raw(Uint8Array.from([ESC, 0x64, lines & 0xff]));
  }

  public cut(): this {
    // Partial cut leaves a tab so the receipt does not drop; devices without it
    // get a full cut rather than an unrecognised command.
    return this.raw(
      Uint8Array.from([GS, 0x56, this.profile.capabilities.supportsPartialCut ? 0x01 : 0x00]),
    );
  }

  public build(): Uint8Array {
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

export function escpos(profile: PrinterProfile): EscPosBuilder {
  return new EscPosBuilder(profile);
}

/**
 * Lay a label and an amount on one line, amount flush to the end.
 *
 * Truncates the label rather than wrapping: a total that slides onto a second
 * line is worse than a shortened item name.
 */
export function twoColumn(label: string, amount: string, width: number): string {
  const room = width - amount.length - 1;
  const trimmed = label.length > room ? `${label.slice(0, Math.max(0, room - 1))}…` : label;
  const padding = Math.max(1, width - trimmed.length - amount.length);
  return `${trimmed}${' '.repeat(padding)}${amount}`;
}
