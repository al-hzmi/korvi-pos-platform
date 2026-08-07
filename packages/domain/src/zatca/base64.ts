const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64 over raw bytes, written out rather than delegated.
 *
 * `Buffer` is Node-only and `btoa` is byte-string-only; the TLV payload has to
 * encode identically in the browser (offline, on the terminal) and on the
 * server (during sync), so the encoder lives here as plain arithmetic.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let output = '';

  for (let index = 0; index < bytes.length; index += 3) {
    const byte0 = bytes[index] ?? 0;
    const byte1 = bytes[index + 1];
    const byte2 = bytes[index + 2];

    output += ALPHABET[byte0 >> 2];
    output += ALPHABET[((byte0 & 0x03) << 4) | ((byte1 ?? 0) >> 4)];
    output += byte1 === undefined ? '=' : ALPHABET[((byte1 & 0x0f) << 2) | ((byte2 ?? 0) >> 6)];
    output += byte2 === undefined ? '=' : ALPHABET[byte2 & 0x3f];
  }

  return output;
}
