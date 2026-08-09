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
  readonly dispatch: (action: CartAction) => void;
}

function CartRow({ line, locked, lineTotalMinor, dispatch }: CartRowProps): JSX.Element {
  const [draft, setDraft] = useState(() => formatScaled(line.quantityScaled));
  const [invalid, setInvalid] = useState(false);

  // The line is the authority; the field is a draft of it. Anything that
  // changes the quantity elsewhere (a step, a re-scan) has to show up here.
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
    <li className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-card-foreground">{line.nameAr}</span>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <BidiIsolate>{line.sku}</BidiIsolate>
            <span aria-hidden="true">·</span>
            <Numeric value={formatMinor(line.unitPriceMinor)} />
            {line.unitLabel === null ? null : <span>/ {line.unitLabel}</span>}
          </span>
        </div>
        <Numeric
          value={formatMinor(lineTotalMinor)}
          className="shrink-0 text-lg font-semibold text-foreground"
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {/* Whole-unit steppers belong to whole-unit products. "One less" has
              no meaning on 0.750 kg, and a generic implementation of it is how
              a minus button ends up increasing a quantity. A weighed line is
              edited in the field beside this. */}
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
            className="numeric h-touch w-20 rounded-md border border-input bg-background text-center text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50 aria-[invalid=true]:border-destructive"
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

      {invalid ? (
        <p className="text-xs text-destructive" role="status">
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
  readonly dispatch: (action: CartAction) => void;
}

export function CartPanel({ lines, preview, locked, dispatch }: CartPanelProps): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between pb-2">
        <h2 className="text-base font-semibold text-card-foreground">السلة</h2>
        {lines.length === 0 ? null : (
          <Button
            variant="ghost"
            size="sm"
            disabled={locked}
            onClick={() => {
              dispatch({ type: 'clear' });
            }}
          >
            إفراغ
          </Button>
        )}
      </div>

      {lines.length === 0 ? (
        <p className="flex flex-1 items-center justify-center py-8 text-center text-sm text-muted-foreground">
          السلة فارغة.
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {lines.map((line, index) => (
            <CartRow
              key={line.productId}
              line={line}
              locked={locked}
              lineTotalMinor={(preview.lines[index]?.total.minor ?? 0n).toString()}
              dispatch={dispatch}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
