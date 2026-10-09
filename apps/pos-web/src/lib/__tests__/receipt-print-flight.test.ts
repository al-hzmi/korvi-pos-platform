import { describe, expect, it, vi } from 'vitest';
import { createReceiptPrintFlight } from '../receipt-print-flight';

describe('receipt print flight', () => {
  it('reports a successful physical send', async () => {
    const flight = createReceiptPrintFlight();
    const print = vi.fn(async () => undefined);

    await expect(flight.run(print)).resolves.toBe('printed');
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('blocks a duplicate click while the same print is outstanding', async () => {
    const flight = createReceiptPrintFlight();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const print = vi.fn(() => pending);

    const first = flight.run(print);
    await expect(flight.run(print)).resolves.toBe('busy');
    expect(print).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toBe('printed');
  });

  it('releases the guard after printer failure so the same receipt can retry', async () => {
    const flight = createReceiptPrintFlight();
    const failure = new Error('printer offline');
    const failingPrint = vi.fn(async () => {
      throw failure;
    });

    await expect(flight.run(failingPrint)).rejects.toBe(failure);

    const retry = vi.fn(async () => undefined);
    await expect(flight.run(retry)).resolves.toBe('printed');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('allows deliberate sequential reprints after the previous send completed', async () => {
    const flight = createReceiptPrintFlight();
    const printSameFinalizedReceipt = vi.fn(async () => undefined);

    await expect(flight.run(printSameFinalizedReceipt)).resolves.toBe('printed');
    await expect(flight.run(printSameFinalizedReceipt)).resolves.toBe('printed');
    expect(printSameFinalizedReceipt).toHaveBeenCalledTimes(2);
  });
});
