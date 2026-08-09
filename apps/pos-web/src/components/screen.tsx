import { KorviMark } from '@korvi/ui';
import type { JSX, ReactNode } from 'react';

/**
 * The full-height frame used before the cashier workspace opens.
 *
 * Deliberately quiet: this is a machine at a counter, not a landing page.
 */
export interface ScreenProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

export function Screen({ title, subtitle, children, footer }: ScreenProps): JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <KorviMark size="lg" />
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
            {subtitle === undefined ? null : (
              <p className="text-sm text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
        {children}
        {footer === undefined ? null : (
          <p className="text-center text-xs text-muted-foreground">{footer}</p>
        )}
      </div>
    </main>
  );
}
