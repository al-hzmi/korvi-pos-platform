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
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {[0, 1, 2, 3, 4, 5].map((slot) => (
              <li key={slot} aria-hidden="true" className="h-16 animate-pulse bg-muted/70" />
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
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {state.results.map((product) => (
              <li key={product.id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onPick(product);
                  }}
                  className={cn(
                    'grid min-h-16 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-2.5 text-start',
                    'transition-colors hover:bg-accent/70',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    'disabled:pointer-events-none disabled:opacity-50',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-medium leading-6 text-card-foreground">
                      {product.nameAr}
                    </span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                      <BidiIsolate className="truncate">{product.sku}</BidiIsolate>
                      {product.productType === 'weighted' ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="shrink-0">
                            بالوزن {product.unitLabel === null ? '' : `· ${product.unitLabel}`}
                          </span>
                        </>
                      ) : null}
                    </span>
                  </span>
                  <Numeric
                    value={formatMinor(product.priceMinor)}
                    className="shrink-0 text-lg font-semibold text-foreground"
                  />
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
