'use client';

import { BidiIsolate, Button, KorviMark } from '@korvi/ui';
import type { JSX } from 'react';
import type { TerminalSummary } from '../lib/api-types';

export interface TopBarProps {
  readonly cashierName: string;
  /** Shown only to a principal the server would let in anyway. */
  readonly showControlCentre: boolean;
  readonly terminal: TerminalSummary;
  readonly onSignOut: () => void;
  /** True while a transaction of unknown outcome is outstanding. */
  readonly signOutBlocked: boolean;
  readonly busy: boolean;
}

/**
 * Where the cashier is, in one line.
 *
 * The shift indicator names its state in words as well as colour: a green dot
 * on its own is not a status anybody can read out loud (§7.3).
 */
export function TopBar({
  cashierName,
  showControlCentre,
  terminal,
  onSignOut,
  signOutBlocked,
  busy,
}: TopBarProps): JSX.Element {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-4">
      <div className="flex items-center gap-4">
        <KorviMark size="sm" />
        {/* A truncated UUID is an implementation detail, not branch context.
            There is no safe display name in the contract this strike may read,
            so the till says which branch it means without pretending to name
            it. */}
        <span className="hidden text-sm text-muted-foreground sm:inline">الفرع الحالي</span>
        <span className="text-sm text-foreground">
          {terminal.label} · <BidiIsolate>{terminal.code}</BidiIsolate>
        </span>
      </div>

      <div className="flex items-center gap-3">
        <span className="flex items-center gap-2 rounded-md bg-success/10 px-2 py-1 text-xs font-medium text-success ring-1 ring-inset ring-success/30">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-success" />
          وردية مفتوحة
        </span>
        {showControlCentre ? (
          <a
            href="/control"
            className="hidden h-touch items-center rounded-md border border-input px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:inline-flex"
          >
            لوحة التحكم
          </a>
        ) : null}
        <span className="hidden text-sm font-medium text-foreground md:inline">{cashierName}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onSignOut}
          disabled={busy || signOutBlocked}
          title={signOutBlocked ? 'لا يمكن الخروج قبل حسم العملية الحالية.' : undefined}
        >
          خروج
        </Button>
      </div>
    </header>
  );
}
