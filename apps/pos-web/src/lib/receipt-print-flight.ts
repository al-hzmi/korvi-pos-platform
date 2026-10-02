import type { FiscalReceipt, SaleSummary } from './api-types';

export type FiscalReceiptPrinter = (sale: SaleSummary, receipt: FiscalReceipt) => Promise<void>;
export type ReceiptPrintFlightOutcome = 'printed' | 'busy';

export interface ReceiptPrintFlight {
  run(print: () => Promise<void>): Promise<ReceiptPrintFlightOutcome>;
}

/**
 * Serialises one physical receipt send without owning any fiscal state.
 *
 * A second click while the first socket write is outstanding is ignored. Once
 * the attempt settles — success or failure — the same finalized receipt may be
 * retried/reprinted. Nothing here can create or mutate a sale or invoice.
 */
export function createReceiptPrintFlight(): ReceiptPrintFlight {
  let inFlight = false;

  return {
    async run(print) {
      if (inFlight) return 'busy';
      inFlight = true;
      try {
        await print();
        return 'printed';
      } finally {
        inFlight = false;
      }
    },
  };
}
