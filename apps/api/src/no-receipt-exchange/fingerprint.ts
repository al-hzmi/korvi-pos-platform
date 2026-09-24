import { createHash } from 'node:crypto';

export interface NoReceiptExchangeIntent {
  readonly terminalId: string;
  readonly expectedShiftId: string;
  readonly reason: string;
  readonly evidenceNote: string;
  readonly approvedAllowanceMinor: string;
  readonly acceptedLines: readonly {
    readonly productId: string;
    readonly quantityScaled: string;
  }[];
  readonly replacementLines: readonly {
    readonly productId: string;
    readonly quantityScaled: string;
  }[];
  readonly tenders: readonly {
    readonly kind: string;
    readonly amountMinor: string;
    readonly scheme: string;
    readonly reference: string;
  }[];
}

function sortedLines(
  lines: NoReceiptExchangeIntent['acceptedLines'],
): readonly (readonly string[])[] {
  return lines
    .map((line): readonly string[] => [line.productId, line.quantityScaled])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function fingerprintNoReceiptExchangeIntent(
  intent: NoReceiptExchangeIntent,
): string {
  const tenders = intent.tenders
    .map(
      (tender): readonly string[] => [
        tender.kind,
        tender.amountMinor,
        tender.scheme,
        tender.reference,
      ],
    )
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  const canonical = JSON.stringify([
    'no-receipt-exchange-v1',
    intent.terminalId,
    intent.expectedShiftId,
    intent.reason,
    intent.evidenceNote,
    intent.approvedAllowanceMinor,
    sortedLines(intent.acceptedLines),
    sortedLines(intent.replacementLines),
    tenders,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}
