'use client';

import { BidiIsolate, Button, CardSurface } from '@korvi/ui';
import { Screen } from './screen';
import { StatusNote } from './status-note';
import type { JSX } from 'react';
import type { TerminalSummary } from '../lib/api-types';
import type { Failure } from '../lib/failures';

export interface TerminalPickerProps {
  readonly terminals: readonly TerminalSummary[];
  readonly onChoose: (terminal: TerminalSummary) => void;
  readonly onSignOut: () => void;
}

export function TerminalPicker({
  terminals,
  onChoose,
  onSignOut,
}: TerminalPickerProps): JSX.Element {
  return (
    <Screen title="اختر الصندوق" subtitle="الصناديق المفعّلة في فرعك">
      <CardSurface className="p-4">
        <ul className="flex flex-col gap-2">
          {terminals.map((terminal) => (
            <li key={terminal.id}>
              <Button
                variant="outline"
                size="lg"
                className="w-full justify-between"
                onClick={() => {
                  onChoose(terminal);
                }}
              >
                <span className="font-medium">{terminal.label}</span>
                <BidiIsolate className="text-sm text-muted-foreground">{terminal.code}</BidiIsolate>
              </Button>
            </li>
          ))}
        </ul>
      </CardSurface>
      <Button variant="ghost" onClick={onSignOut} className="mx-auto">
        تسجيل الخروج
      </Button>
    </Screen>
  );
}

export interface BlockedScreenProps {
  readonly title: string;
  readonly failure: Failure;
  readonly tone?: 'warning' | 'danger';
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly onChangeTerminal?: () => void;
  readonly onSignOut?: () => void;
  readonly signOutDisabled?: boolean;
}

/** A state the cashier cannot sell out of. Says what is wrong and who fixes it. */
export function BlockedScreen({
  title,
  failure,
  tone = 'warning',
  onRetry,
  retryLabel = 'إعادة المحاولة',
  onChangeTerminal,
  onSignOut,
  signOutDisabled = false,
}: BlockedScreenProps): JSX.Element {
  return (
    <Screen title={title}>
      <CardSurface className="flex flex-col gap-4 p-6">
        <StatusNote tone={tone} live>
          {failure.message}
        </StatusNote>
        <div className="flex flex-col gap-2">
          {onRetry === undefined ? null : (
            <Button size="lg" onClick={onRetry}>
              {retryLabel}
            </Button>
          )}
          {onChangeTerminal === undefined ? null : (
            <Button variant="outline" size="lg" onClick={onChangeTerminal}>
              اختيار صندوق آخر
            </Button>
          )}
          {onSignOut === undefined ? null : (
            <Button variant="ghost" onClick={onSignOut} disabled={signOutDisabled}>
              تسجيل الخروج
            </Button>
          )}
        </div>
      </CardSurface>
    </Screen>
  );
}
