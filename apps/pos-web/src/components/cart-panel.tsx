'use client';

import { useEffect, useState } from 'react';
import { BidiIsolate, Button, Numeric } from '@korvi/ui';
import { formatMinor } from '../lib/money';
import { formatScaled, parseQuantityToScaled } from '../lib/quantity';
import type { JSX } from 'react';
import type { PricedCart } from '@korvi/domain';
import type { CartAction, CartLine } from '../lib/cart';

/**
 * The basket.
 *
 * Quantity is edited as text and committed as a scaled integer, so a weighed
 * item can be typed as 1.250 without a float ever existing. A unit item is
 * stepped rather than typed, because a tin cannot be sold in thirds and the
 * server refuses one that is.
 */
interface CartRowProps {
  readonly line: CartLine;
  readonly locked: boolean;
  readonly lineTotalMinor: string;
  readonly quickService: boolean;
  readonly dispatch: (action: CartAction) => void;
}

function CartRow({
  line,
  locked,
  lineTotalMinor,
  quickService,
  dispatch,
}: CartRowProps): JSX.Element {
  const [draft, setDraft] = useState(() => formatScaled(line.quantityScaled));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setDraft(formatScaled(line.quantityScaled));
    setInvalid(false);
  }, [line.quantityScaled]);

  const commit = (): void => {
    const parsed = parseQuantityToScaled(draft, line.productType);
    if (!parsed.ok) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    dispatch({ type: 'set-quantity', productId: line.productId, quantityScaled: parsed.value });
  };

  const quantityLabel = `كمية ${line.nameAr}`;
  const stepped = line.productType === 'unit';

  return (
    <li className="rounded-lg border border-border bg-background p-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-sm font-semibold text-card-foreground">{line.nameAr}</span>
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <BidiIsolate className="rounded-md bg-muted px-1.5 py-0.5">{line.sku}</BidiIsolate>
            <span aria-hidden="true">·</span>
            <span className="flex items-baseline gap-1">
              <Numeric value={formatMinor(line.unitPriceMinor)} />
              <span className="text-[10px]">ر.س</span>
            </span>
            {line.unitLabel === null ? null : <span>/ {line.unitLabel}</span>}
          </span>
        </div>
        <span className="flex shrink-0 items-baseline gap-1">
          <Numeric
            value={formatMinor(lineTotalMinor)}
            className="text-lg font-bold text-foreground"
          />
          <span className="text-[10px] text-muted-foreground">ر.س</span>
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/70 pt-2.5">
        <div className="flex items-center gap-1">
          {stepped ? (
            <Button
              variant="outline"
              size="icon"
              aria-label={`إنقاص ${quantityLabel}`}
              disabled={locked}
              onClick={() => {
                dispatch({ type: 'step', productId: line.productId, direction: -1 });
              }}
            >
              −
            </Button>
          ) : null}

          <label className="sr-only" htmlFor={`qty-${line.productId}`}>
            {quantityLabel}
          </label>
          <input
            id={`qty-${line.productId}`}
            inputMode="decimal"
            dir="ltr"
            disabled={locked}
            aria-invalid={invalid}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
            }}
            className="numeric h-touch w-20 rounded-md border border-input bg-background text-center text-base font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50 aria-[invalid=true]:border-destructive"
          />

          {stepped ? (
            <Button
              variant="outline"
              size="icon"
              aria-label={`زيادة ${quantityLabel}`}
              disabled={locked}
              onClick={() => {
                dispatch({ type: 'step', productId: line.productId, direction: 1 });
              }}
            >
              +
            </Button>
          ) : null}
          {stepped ? null : (
            <span className="text-xs text-muted-foreground">{line.unitLabel ?? 'وزن'}</span>
          )}
        </div>

        <Button
          variant="ghost"
          size="sm"
          disabled={locked}
          aria-label={`حذف ${line.nameAr}`}
          onClick={() => {
            dispatch({ type: 'remove', productId: line.productId });
          }}
        >
          حذف
        </Button>
      </div>

      {quickService ? (
        <div className="mt-3 grid gap-2 border-t border-border/70 pt-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-muted-foreground">
            الخيارات
            <input
              value={line.preparationOptions ?? ''}
              disabled={locked}
              maxLength={280}
              placeholder="مثال: بدون بصل، حار"
              onChange={(event) => {
                dispatch({
                  type: 'set-preparation',
                  productId: line.productId,
                  options: event.target.value,
                  note: line.preparationNote ?? '',
                });
              }}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            />
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            ملاحظة التحضير
            <input
              value={line.preparationNote ?? ''}
              disabled={locked}
              maxLength={280}
              placeholder="مثال: تغليف منفصل"
              onChange={(event) => {
                dispatch({
                  type: 'set-preparation',
                  productId: line.productId,
                  options: line.preparationOptions ?? '',
                  note: event.target.value,
                });
              }}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            />
          </label>
        </div>
      ) : null}

      {invalid ? (
        <p className="mt-2 text-xs text-destructive" role="status">
          كمية غير صالحة لهذا الصنف.
        </p>
      ) : null}
    </li>
  );
}

export interface CartPanelProps {
  readonly lines: readonly CartLine[];
  /** Priced once by the workspace and passed down, so the figures cannot diverge. */
  readonly preview: PricedCart;
  readonly locked: boolean;
  readonly quickService?: boolean;
  readonly dispatch: (action: CartAction) => void;
}

export function CartPanel({
  lines,
  preview,
  locked,
  quickService = false,
  dispatch,
}: CartPanelProps): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-card-foreground">السلة</h2>
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {lines.length} {lines.length === 1 ? 'صنف' : 'أصناف'}
          </span>
        </div>
        {lines.length === 0 ? null : (
          <Button
            variant="ghost"
            size="sm"
            disabled={locked}
            onClick={() => {
              dispatch({ type: 'clear' });
            }}
          >
            إفراغ السلة
          </Button>
        )}
      </div>

      {lines.length === 0 ? (
        <div className="flex flex-1 items-center justify-center py-10 text-center">
          <div className="max-w-56">
            <div
              className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-muted/50 text-lg text-muted-foreground"
              aria-hidden="true"
            >
              +
            </div>
            <p className="text-sm font-medium text-foreground">السلة فارغة</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              امسح الباركود أو اختر صنفاً من القائمة لبدء البيع.
            </p>
          </div>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto py-3 pe-1">
          {lines.map((line, index) => (
            <CartRow
              key={line.productId}
              line={line}
              locked={locked}
              lineTotalMinor={(preview.lines[index]?.total.minor ?? 0n).toString()}
              quickService={quickService}
              dispatch={dispatch}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
