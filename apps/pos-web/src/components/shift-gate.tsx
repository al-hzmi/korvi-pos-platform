'use client';

import { useCallback, useState } from 'react';
import { BidiIsolate, Button, CardSurface, Numeric } from '@korvi/ui';
import { Field } from './field';
import { Screen } from './screen';
import { StatusNote } from './status-note';
import { formatMinor, parseSarToMinor } from '../lib/money';
import type { JSX } from 'react';
import type { TerminalSummary } from '../lib/api-types';
import type { Failure } from '../lib/failures';

/**
 * Opening the drawer.
 *
 * The float is typed in riyals and sent in halalas, converted by string
 * arithmetic through the domain's own parser. "20.5" is 2050 and "20.50" is
 * 2050; neither goes anywhere near a float (ADR-0002).
 */
export interface ShiftGateProps {
  readonly terminal: TerminalSummary;
  readonly busy: boolean;
  readonly failure: Failure | null;
  readonly onOpen: (openingFloatMinor: string) => void;
  readonly onChangeTerminal: (() => void) | null;
  readonly onSignOut: () => void;
}

export function ShiftGate({
  terminal,
  busy,
  failure,
  onOpen,
  onChangeTerminal,
  onSignOut,
}: ShiftGateProps): JSX.Element {
  const [amount, setAmount] = useState('');
  const [touched, setTouched] = useState(false);

  const parsedAmount = parseSarToMinor(amount);
  const invalid = touched && !parsedAmount.ok && amount.trim() !== '';

  const submit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setTouched(true);
      const parsed = parseSarToMinor(amount.trim() === '' ? '0' : amount);
      if (!parsed.ok || busy) return;
      onOpen(parsed.value);
    },
    [amount, busy, onOpen],
  );

  return (
    <Screen title="افتح وردية" subtitle={`لا توجد وردية مفتوحة على ${terminal.label}`}>
      <CardSurface className="p-6">
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          {failure === null ? null : (
            <StatusNote tone="warning" live>
              {failure.message}
            </StatusNote>
          )}

          <Field
            id="opening-float"
            label="النقد الافتتاحي في الدرج (ريال)"
            inputMode="decimal"
            autoComplete="off"
            dir="ltr"
            autoFocus
            disabled={busy}
            invalid={invalid}
            value={amount}
            hint={
              parsedAmount.ok ? (
                <span>
                  يُسجَّل بمقدار <Numeric value={formatMinor(parsedAmount.value)} /> ريال
                </span>
              ) : (
                'اتركه فارغاً إذا كان الدرج صفراً. حتى منزلتين عشريتين.'
              )
            }
            onChange={(event) => {
              setAmount(event.target.value);
            }}
            onBlur={() => {
              setTouched(true);
            }}
          />

          <Button type="submit" size="lg" loading={busy} className="mt-2 w-full">
            {busy ? 'جارٍ الفتح…' : 'فتح الوردية'}
          </Button>
        </form>
      </CardSurface>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          الصندوق: <BidiIsolate>{terminal.code}</BidiIsolate>
        </span>
        <span className="flex gap-2">
          {onChangeTerminal === null ? null : (
            <Button variant="ghost" size="sm" onClick={onChangeTerminal}>
              تغيير الصندوق
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onSignOut}>
            خروج
          </Button>
        </span>
      </div>
    </Screen>
  );
}
