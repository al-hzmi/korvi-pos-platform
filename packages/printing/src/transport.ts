/**
 * Transport boundary — declared in Phase 0, implemented later.
 *
 * Rendering and delivery are separated on purpose: the byte layout of a receipt
 * is worth testing exhaustively and does not change when the cable does. USB,
 * Bluetooth, network and WebUSB all become adapters behind this interface.
 */
export interface PrinterTransport {
  readonly id: string;
  send(payload: Uint8Array): Promise<void>;
  isAvailable(): Promise<boolean>;
}
