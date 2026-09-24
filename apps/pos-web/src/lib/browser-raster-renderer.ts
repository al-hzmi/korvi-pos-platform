import type { RasterBitmap, RasterRenderer } from '../../../../packages/printing/src/index';

const LINE_HEIGHT_DOTS = 48;
const INLINE_PADDING_DOTS = 8;
const FONT_SIZE_PX = 28;
const INK_ALPHA_THRESHOLD = 72;

function containsRtl(value: string): boolean {
  return /[\u0590-\u08ff\ufb1d-\ufefc]/u.test(value);
}

/**
 * Offline raster text adapter for the installed WebView/browser runtime.
 *
 * Canvas text layout supplies a real shaping/bidi/font engine instead of
 * guessing an ESC/POS Arabic code page. The resulting monochrome bitmap is
 * deliberately device-agnostic and is consumed by the existing GS v 0 path.
 */
export function createBrowserRasterRenderer(): RasterRenderer {
  return {
    async renderLine(text: string, widthInDots: number): Promise<RasterBitmap> {
      if (!Number.isInteger(widthInDots) || widthInDots <= 0) {
        throw new Error('raster width must be a positive integer');
      }
      if (typeof document === 'undefined') {
        throw new Error('browser raster renderer requires a DOM canvas runtime');
      }

      const canvas = document.createElement('canvas');
      canvas.width = widthInDots;
      canvas.height = LINE_HEIGHT_DOTS;

      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) throw new Error('2D canvas raster renderer is unavailable');

      context.font = `600 ${String(FONT_SIZE_PX)}px "Noto Sans Arabic", "Segoe UI", Tahoma, Arial, sans-serif`;
      context.textBaseline = 'middle';

      const rtl = containsRtl(text);
      context.direction = rtl ? 'rtl' : 'ltr';
      context.textAlign = rtl ? 'right' : 'left';

      const x = rtl ? widthInDots - INLINE_PADDING_DOTS : INLINE_PADDING_DOTS;
      const maxWidth = Math.max(1, widthInDots - INLINE_PADDING_DOTS * 2);
      context.fillText(text, x, LINE_HEIGHT_DOTS / 2, maxWidth);

      const rgba = context.getImageData(0, 0, widthInDots, LINE_HEIGHT_DOTS).data;
      const bytesPerRow = Math.ceil(widthInDots / 8);
      const data = new Uint8Array(bytesPerRow * LINE_HEIGHT_DOTS);

      for (let y = 0; y < LINE_HEIGHT_DOTS; y += 1) {
        for (let xDot = 0; xDot < widthInDots; xDot += 1) {
          const pixelOffset = (y * widthInDots + xDot) * 4;
          const alpha = rgba[pixelOffset + 3] ?? 0;
          if (alpha < INK_ALPHA_THRESHOLD) continue;

          const byteOffset = y * bytesPerRow + Math.floor(xDot / 8);
          data[byteOffset] = (data[byteOffset] ?? 0) | (0x80 >> (xDot % 8));
        }
      }

      return {
        width: widthInDots,
        height: LINE_HEIGHT_DOTS,
        data,
      };
    },
  };
}
