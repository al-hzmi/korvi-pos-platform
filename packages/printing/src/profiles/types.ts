/**
 * Printer capability model.
 *
 * Revision 1 selected a code page and then sent UTF-8 through a TextEncoder.
 * That is wrong on essentially every real device: an ESC/POS printer decodes
 * bytes through the code page it was told to use, so UTF-8 multi-byte
 * sequences arrive as pairs of unrelated glyphs. Arabic came out as mojibake on
 * anything that was not a UTF-8-native printer.
 *
 * The fix is to stop assuming. A profile states what a given model can actually
 * do, and the encoder picks a strategy from that rather than from hope.
 */

/** How text reaches the print head. */
export type TextEncodingKind =
  /** Legacy single-byte Arabic code page. Firmware shapes the letters. */
  | 'cp1256'
  /** Legacy code page addressing Arabic presentation forms directly. */
  | 'cp864'
  /** Modern printers that genuinely decode UTF-8. */
  | 'utf8'
  /** No usable text path: the line must be drawn and sent as a bitmap. */
  | 'raster';

/** How the device draws a QR code. */
export type QrSupport =
  /** Native ESC/POS `GS ( k` symbol-storage commands. */
  | 'native'
  /** No QR firmware; the symbol must be rendered and sent as a bitmap. */
  | 'raster'
  /** Device cannot print a QR at all. */
  | 'none';

export interface PrinterCapabilities {
  /** Characters per line at the default font. */
  readonly columns: number;
  /** Dots per line — needed to size any raster payload. */
  readonly dotsPerLine: number;
  readonly text: TextEncodingKind;
  /** ESC t page selector, when the encoding is a legacy code page. */
  readonly codePageId: number | null;
  /**
   * The device joins Arabic letters itself.
   *
   * When true we send base letters and leave shaping to the firmware. When
   * false we shape before sending. This is a claim about a specific model that
   * someone has observed on real hardware — it is never assumed, because a
   * device that does not shape prints disconnected letterforms and a device
   * that does shape would double-shape our presentation forms into nonsense.
   */
  readonly firmwareShapes: boolean;
  /**
   * The device runs its own bidirectional reordering.
   *
   * When false we reorder into visual order, because a legacy head emits bytes
   * strictly left to right.
   */
  readonly firmwareBidi: boolean;
  readonly qr: QrSupport;
  readonly supportsPartialCut: boolean;
  /**
   * Whether this profile's behaviour has been established for the specific model by physical hardware testing or authoritative vendor documentation.
   *
   * Unverified profiles must not take a text path. An unverified guess about
   * Arabic handling produces confident garbage on a tax invoice, which is
   * worse than refusing — so unknown devices fall back to raster.
   */
  readonly verified: boolean;
}

export interface PrinterProfile {
  readonly id: string;
  readonly vendor: string;
  readonly model: string;
  readonly capabilities: PrinterCapabilities;
  /** Why this profile is set up the way it is. Kept for the next reader. */
  readonly notes: string;
}
