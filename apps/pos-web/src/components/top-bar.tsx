'use client';

import { useEffect, useState } from 'react';
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
 * Offline mode is explicit: the badge changes state, back-office navigation is
 * hidden, and logout is blocked because the HttpOnly server session cannot be
 * revoked without a confirmed response.
 */
export function TopBar({
  cashierName,
  showControlCentre,
  terminal,
  onSignOut,
  signOutBlocked,
  busy,
}: TopBarProps): JSX.Element {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    globalThis.addEventListener('online', update);
    globalThis.addEventListener('offline', update);
    return () => {
      globalThis.removeEventListener('online', update);
      globalThis.removeEventListener('offline', update);
    };
  }, []);

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-4">
      <div className="flex items-center gap-4">
        <KorviMark size="sm" />
        <span className="hidden text-sm text-muted-foreground sm:inline">الفرع الحالي</span>
        <span className="text-sm text-foreground">
          {terminal.label} · <BidiIsolate>{terminal.code}</BidiIsolate>
        </span>
      </div>

      <div className="flex items-center gap-3">
        <span
          className={
            online
              ? 'flex items-center gap-2 rounded-md bg-success/10 px-2 py-1 text-xs font-medium text-success ring-1 ring-inset ring-success/30'
              : 'flex items-center gap-2 rounded-md bg-warning/10 px-2 py-1 text-xs font-medium text-warning ring-1 ring-inset ring-warning/30'
          }
        >
          <span
            aria-hidden="true"
            className={online ? 'h-2 w-2 rounded-full bg-success' : 'h-2 w-2 rounded-full bg-warning'}
          />
          {online ? 'وردية مفتوحة' : 'تشغيل محلي'}
        </span>
        {showControlCentre && online ? (
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
          disabled={busy || signOutBlocked || !online}
          title={
            !online
              ? 'يلزم الاتصال بالخادم لتأكيد تسجيل الخروج بأمان.'
              : signOutBlocked
                ? 'لا يمكن الخروج قبل حسم العملية الحالية.'
                : undefined
          }
        >
          خروج
        </Button>
      </div>
    </header>
  );
}
