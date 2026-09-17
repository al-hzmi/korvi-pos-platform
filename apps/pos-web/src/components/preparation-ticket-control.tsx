'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { StatusNote } from './status-note';
import { createReceiptPrintFlight } from '../lib/receipt-print-flight';
import type { PreparationTicket, PreparationTicketPrinter } from '../lib/preparation-ticket';
import type { ReceiptPrintFlight } from '../lib/receipt-print-flight';
import type { JSX } from 'react';

type PrepPrintState = 'idle' | 'printing' | 'printed' | 'failed';

export interface PreparationTicketControlProps {
  readonly ticket: PreparationTicket;
  readonly printer?: PreparationTicketPrinter | undefined;
}

export function PreparationTicketControl({
  ticket,
  printer,
}: PreparationTicketControlProps): JSX.Element {
  const [state, setState] = useState<PrepPrintState>('idle');
  const flight = useRef<ReceiptPrintFlight | null>(null);
  const autoStarted = useRef<string | null>(null);
  flight.current ??= createReceiptPrintFlight();

  const print = useCallback(async (): Promise<void> => {
    if (printer === undefined) {
      setState('failed');
      return;
    }
    setState('printing');
    try {
      const outcome = await flight.current!.run(() => printer(ticket));
      if (outcome === 'printed') setState('printed');
    } catch {
      setState('failed');
    }
  }, [printer, ticket]);

  useEffect(() => {
    if (autoStarted.current === ticket.sourceOperationId) return;
    autoStarted.current = ticket.sourceOperationId;
    void print();
  }, [print, ticket.sourceOperationId]);

  const label =
    state === 'printing'
      ? 'جارٍ طباعة تذكرة التحضير…'
      : state === 'failed'
        ? 'إعادة محاولة تذكرة التحضير'
        : state === 'printed'
          ? 'إعادة طباعة تذكرة التحضير'
          : 'طباعة تذكرة التحضير';

  return (
    <CardSurface className="shrink-0 border-border/80 p-3 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">تذكرة التحضير — غير ضريبية</p>
          <p className="text-xs text-muted-foreground">رقم الطلب {ticket.orderNumber}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={state === 'printing'}
          onClick={() => void print()}
        >
          {label}
        </Button>
      </div>
      {state === 'failed' ? (
        <StatusNote tone="warning" className="mt-2" live>
          تعذّرت طباعة تذكرة التحضير أو لم تُهيأ طابعتها. البيع المالي لم يتغير؛ أعد طباعة نفس
          التذكرة فقط.
        </StatusNote>
      ) : state === 'printed' ? (
        <StatusNote tone="success" className="mt-2" live>
          أُرسلت تذكرة التحضير غير الضريبية. إعادة الطباعة لا تنشئ بيعاً أو فاتورة جديدة.
        </StatusNote>
      ) : null}
    </CardSurface>
  );
}
