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
    <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-border bg-card/95 px-3 shadow-sm backdrop-blur sm:px-5">
      <div className="flex min-w-0 items-center gap-3 sm:gap-4">
        <div className="flex h-10 shrink-0 items-center rounded-lg border border-border bg-background px-2.5 shadow-sm">
          <KorviMark size="sm" />
        </div>
        <div className="min-w-0">
          <p className="hidden text-[10px] font-medium uppercase tracking-wide text-muted-foreground sm:block">
            نقطة البيع الحالية
          </p>
          <p className="truncate text-sm font-semibold text-foreground">
            {terminal.label}
            <span className="mx-1.5 text-muted-foreground" aria-hidden="true">
              ·
            </span>
            <BidiIsolate className="font-normal text-muted-foreground">{terminal.code}</BidiIsolate>
          </p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <span
          className={
            online
              ? 'flex h-8 items-center gap-2 rounded-md bg-success/10 px-2.5 text-xs font-semibold text-success ring-1 ring-inset ring-success/30'
              : 'flex h-8 items-center gap-2 rounded-md bg-warning/10 px-2.5 text-xs font-semibold text-warning ring-1 ring-inset ring-warning/30'
          }
        >
          <span
            aria-hidden="true"
            className={
              online ? 'h-2 w-2 rounded-full bg-success' : 'h-2 w-2 rounded-full bg-warning'
            }
          />
          <span className="hidden sm:inline">
            {online ? 'متصل · الوردية مفتوحة' : 'تشغيل محلي'}
          </span>
          <span className="sm:hidden">{online ? 'متصل' : 'محلي'}</span>
        </span>
        {showControlCentre && online ? (
          <a
            href="/control"
            className="hidden h-touch items-center rounded-md border border-input bg-background px-3 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background md:inline-flex"
          >
            لوحة التحكم
          </a>
        ) : null}
        <div className="hidden min-w-0 border-s border-border ps-3 lg:block">
          <p className="text-[10px] text-muted-foreground">الكاشير</p>
          <p className="max-w-36 truncate text-sm font-semibold text-foreground">{cashierName}</p>
        </div>
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
