import { MissingCapabilityError } from './errors.js';

/**
 * Raster boundary — declared in Phase 0, implemented later.
 *
 * Some devices have no Arabic code page at all. The only honest output for
 * those is a bitmap of the rendered line, which means a real text renderer:
 * a font, a shaper, a layout engine. That is a Phase 1 dependency, not
 * something to fake here.
 *
 * The port exists now so the pipeline is shaped correctly from the start, and
 * so a raster-only profile fails loudly rather than silently taking a text
 * path that would print nonsense.
 */
export interface RasterBitmap {
  /** Width in dots. Must not exceed the profile's dotsPerLine. */
  readonly width: number;
  readonly height: number;
  /** 1 bit per pixel, row-major, MSB first — the layout `GS v 0` expects. */
  readonly data: Uint8Array;
}

export interface RasterRenderer {
  renderLine(text: string, widthInDots: number): Promise<RasterBitmap>;
}

/** `GS v 0` — print a raster bit image. */
export function rasterCommand(bitmap: RasterBitmap): Uint8Array {
  const bytesPerRow = Math.ceil(bitmap.width / 8);
  const expected = bytesPerRow * bitmap.height;

  if (bitmap.data.length !== expected) {
    throw new MissingCapabilityError(
      `Raster payload is ${String(bitmap.data.length)} bytes; ` +
        `${String(bitmap.width)}x${String(bitmap.height)} needs ${String(expected)}.`,
    );
  }

  const header = Uint8Array.from([
    0x1d,
    0x76,
    0x30,
    0x00,
    bytesPerRow & 0xff,
    (bytesPerRow >> 8) & 0xff,
    bitmap.height & 0xff,
    (bitmap.height >> 8) & 0xff,
  ]);

  const out = new Uint8Array(header.length + bitmap.data.length);
  out.set(header, 0);
  out.set(bitmap.data, header.length);
  return out;
}
