'use client';

import { BidiIsolate, CardSurface, Numeric, cn } from '@korvi/ui';
import { Field } from './field';
import { StatusNote } from './status-note';
import { formatMinor } from '../lib/money';
import type { JSX, Ref } from 'react';
import type { ProductSummary } from '../lib/api-types';
import type { SearchState } from '../lib/search';

/**
 * Search, and the results of searching.
 *
 * The field is the largest thing on the screen because it is where every sale
 * starts, and it keeps the focus: a scanner types into whatever is focused, so
 * anything that steals focus turns the next scan into keystrokes nowhere.
 *
 * The results area holds its height while a query is in flight. A list that
 * collapses and re-expands moves the item the cashier was reaching for.
 */
export interface ProductPanelProps {
  readonly term: string;
  readonly state: SearchState;
  readonly disabled: boolean;
  readonly inputRef: Ref<HTMLInputElement>;
  readonly onTermChange: (term: string) => void;
  readonly onSubmitTerm: () => void;
  readonly onPick: (product: ProductSummary) => void;
}

export function ProductPanel({
  term,
  state,
  disabled,
  inputRef,
  onTermChange,
  onSubmitTerm,
  onPick,
}: ProductPanelProps): JSX.Element {
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4" aria-label="البحث عن صنف">
      <Field
        id="product-search"
        label="ابحث أو امسح الباركود"
        type="search"
        inputMode="search"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        autoFocus
        disabled={disabled}
        value={term}
        inputRef={inputRef}
        className="h-touch-lg text-lg"
        placeholder="اسم الصنف، الرمز، أو الباركود"
        onChange={(event) => {
          onTermChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onSubmitTerm();
          }
        }}
      />

      {/*
        Available, and nothing more than that. The server orders this list by
        SKU and computes no popularity, frequency or recency of any kind, so
        calling these the most-used lines would be a claim the product cannot
        support — and one a merchant would make purchasing decisions on.
      */}
      {state.status === 'ready' && state.results.length > 0 && term.trim() === '' ? (
        <p className="-mt-1 text-xs text-muted-foreground">
          الأصناف المتاحة — اضغط على الصنف لإضافته، أو امسح الباركود.
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={state.status === 'loading'}>
        {state.status === 'failed' && state.failure !== null ? (
          <StatusNote tone="warning" live>
            {state.failure.message}
          </StatusNote>
        ) : null}

        {state.status === 'idle' ? (
          <p className="py-10 text-center text-sm text-muted-foreground">جارٍ تحميل الأصناف…</p>
        ) : null}

        {state.status === 'loading' ? (
          <ul className="grid grid-cols-2 gap-3 xl:grid-cols-3">
            {[0, 1, 2, 3].map((slot) => (
              <li
                key={slot}
                aria-hidden="true"
                className="h-28 animate-pulse rounded-lg border border-border bg-muted"
              />
            ))}
          </ul>
        ) : null}

        {state.status === 'ready' && state.results.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground" role="status">
            {term.trim() === ''
              ? 'لا توجد أصناف مفعّلة في هذه المنشأة بعد.'
              : 'لا توجد نتائج مطابقة.'}
          </p>
        ) : null}

        {state.status === 'ready' && state.results.length > 0 ? (
          <ul className="grid grid-cols-2 gap-3 xl:grid-cols-3">
            {state.results.map((product) => (
              <li key={product.id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onPick(product);
                  }}
                  className={cn(
                    'flex h-28 w-full flex-col justify-between rounded-lg border border-border',
                    'bg-card p-3 text-start transition-colors',
                    'hover:border-primary/40 hover:bg-accent',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                    'disabled:pointer-events-none disabled:opacity-50',
                  )}
                >
                  <span className="line-clamp-2 text-sm font-medium text-card-foreground">
                    {product.nameAr}
                  </span>
                  <span className="flex items-end justify-between gap-2">
                    <span className="flex flex-col items-start gap-0.5">
                      <BidiIsolate className="text-xs text-muted-foreground">
                        {product.sku}
                      </BidiIsolate>
                      {product.productType === 'weighted' ? (
                        <span className="text-[10px] font-medium text-muted-foreground">
                          بالوزن {product.unitLabel === null ? '' : `· ${product.unitLabel}`}
                        </span>
                      ) : null}
                    </span>
                    <Numeric
                      value={formatMinor(product.priceMinor)}
                      className="text-lg font-semibold text-foreground"
                    />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

export function ProductPanelSurface({ children }: { readonly children: JSX.Element }): JSX.Element {
  return <CardSurface className="flex min-h-0 flex-1 flex-col p-4">{children}</CardSurface>;
}
