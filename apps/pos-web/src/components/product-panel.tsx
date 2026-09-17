'use client';

import { useEffect, useMemo, useState } from 'react';
import { BidiIsolate, CardSurface, Numeric, cn } from '@korvi/ui';
import { Field } from './field';
import { StatusNote } from './status-note';
import { formatMinor } from '../lib/money';
import type { JSX, Ref } from 'react';
import type { ProductSummary } from '../lib/api-types';
import type { SearchState } from '../lib/search';

export interface ProductPanelProps {
  readonly term: string;
  readonly state: SearchState;
  readonly disabled: boolean;
  readonly inputRef: Ref<HTMLInputElement>;
  readonly onTermChange: (term: string) => void;
  readonly onSubmitTerm: () => void;
  readonly onPick: (product: ProductSummary) => void;
  readonly quickService: boolean;
  readonly enableImages: boolean;
}

interface CategoryChoice {
  readonly id: string;
  readonly nameAr: string;
  readonly sortOrder: number;
}

export function ProductPanel({
  term,
  state,
  disabled,
  inputRef,
  onTermChange,
  onSubmitTerm,
  onPick,
  quickService,
  enableImages,
}: ProductPanelProps): JSX.Element {
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);

  const categories = useMemo<readonly CategoryChoice[]>(() => {
    const unique = new Map<string, CategoryChoice>();
    for (const product of state.results) {
      const id = product.categoryId ?? null;
      const nameAr = product.categoryNameAr ?? null;
      if (id === null || nameAr === null || nameAr.trim() === '') continue;
      const sortOrder = product.categorySortOrder ?? Number.MAX_SAFE_INTEGER;
      const current = unique.get(id);
      if (current === undefined || sortOrder < current.sortOrder) {
        unique.set(id, { id, nameAr, sortOrder });
      }
    }
    return [...unique.values()].sort(
      (left, right) =>
        left.sortOrder - right.sortOrder || left.nameAr.localeCompare(right.nameAr, 'ar'),
    );
  }, [state.results]);

  useEffect(() => {
    if (
      selectedCategoryId !== null &&
      !categories.some((category) => category.id === selectedCategoryId)
    ) {
      setSelectedCategoryId(null);
    }
  }, [categories, selectedCategoryId]);

  const visibleProducts = useMemo(
    () =>
      quickService && selectedCategoryId !== null
        ? state.results.filter((product) => product.categoryId === selectedCategoryId)
        : state.results,
    [quickService, selectedCategoryId, state.results],
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4" aria-label="البحث عن صنف">
      <div className="rounded-lg border border-border bg-background/70 p-3 shadow-sm">
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
          className="h-touch-lg text-lg font-medium"
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
      </div>

      {quickService && categories.length > 0 ? (
        <nav className="flex gap-2 overflow-x-auto pb-1" aria-label="فئات القائمة">
          <button
            type="button"
            disabled={disabled}
            onClick={() => setSelectedCategoryId(null)}
            className={cn(
              'shrink-0 rounded-lg border px-4 py-2 text-sm font-semibold',
              selectedCategoryId === null
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-card text-card-foreground',
              'disabled:pointer-events-none disabled:opacity-50',
            )}
          >
            الكل
          </button>
          {categories.map((category) => (
            <button
              key={category.id}
              type="button"
              disabled={disabled}
              onClick={() => setSelectedCategoryId(category.id)}
              className={cn(
                'shrink-0 rounded-lg border px-4 py-2 text-sm font-semibold',
                selectedCategoryId === category.id
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-card text-card-foreground',
                'disabled:pointer-events-none disabled:opacity-50',
              )}
            >
              {category.nameAr}
            </button>
          ))}
        </nav>
      ) : null}

      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            {quickService ? 'قائمة المنتجات' : 'الأصناف المتاحة'}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {quickService
              ? 'اختر الفئة ثم اضغط المنتج لإضافته مباشرة.'
              : 'اختر الصنف مباشرة أو استخدم قارئ الباركود للانتقال السريع.'}
          </p>
        </div>
        {state.status === 'ready' && visibleProducts.length > 0 ? (
          <span className="shrink-0 rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
            {visibleProducts.length} صنف
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pe-1" aria-busy={state.status === 'loading'}>
        {state.status === 'failed' && state.failure !== null ? (
          <StatusNote tone="warning" live>
            {state.failure.message}
          </StatusNote>
        ) : null}

        {state.status === 'idle' ? (
          <p className="py-12 text-center text-sm text-muted-foreground">جارٍ تحميل الأصناف…</p>
        ) : null}

        {state.status === 'loading' ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-4">
            {[0, 1, 2, 3, 4, 5].map((slot) => (
              <li
                key={slot}
                aria-hidden="true"
                className={cn(
                  'animate-pulse rounded-lg border border-border bg-muted',
                  enableImages ? 'h-52' : 'h-36',
                )}
              />
            ))}
          </ul>
        ) : null}

        {state.status === 'ready' && state.results.length === 0 ? (
          <div
            className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 px-6 text-center"
            role="status"
          >
            <div>
              <p className="text-sm font-medium text-foreground">
                {term.trim() === '' ? 'لا توجد أصناف مفعّلة بعد' : 'لا توجد نتائج مطابقة'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {term.trim() === ''
                  ? 'أضف الأصناف من لوحة التحكم لتظهر هنا.'
                  : 'جرّب الاسم أو رمز الصنف أو الباركود.'}
              </p>
            </div>
          </div>
        ) : null}

        {state.status === 'ready' && state.results.length > 0 && visibleProducts.length === 0 ? (
          <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 px-6 text-center">
            <p className="text-sm font-medium text-muted-foreground">لا توجد أصناف في هذه الفئة.</p>
          </div>
        ) : null}

        {state.status === 'ready' && visibleProducts.length > 0 ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-4">
            {visibleProducts.map((product) => {
              const imageUrl = enableImages ? (product.imageUrl ?? null) : null;
              return (
                <li key={product.id}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      onPick(product);
                    }}
                    className={cn(
                      'group flex w-full flex-col overflow-hidden rounded-lg border border-border',
                      'bg-card text-start shadow-sm transition-[transform,box-shadow,border-color,background-color]',
                      'hover:-translate-y-0.5 hover:border-primary/40 hover:bg-accent/40 hover:shadow-md',
                      'active:translate-y-0 active:shadow-sm',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                      'disabled:pointer-events-none disabled:opacity-50',
                      enableImages ? 'h-52' : 'h-36 p-4',
                    )}
                  >
                    {enableImages ? (
                      <span
                        aria-hidden="true"
                        className={cn(
                          'flex h-28 w-full shrink-0 items-center justify-center bg-muted bg-cover bg-center',
                          imageUrl === null ? 'text-3xl font-bold text-muted-foreground' : '',
                        )}
                        style={
                          imageUrl === null
                            ? undefined
                            : { backgroundImage: `url(${JSON.stringify(imageUrl)})` }
                        }
                      >
                        {imageUrl === null ? product.nameAr.slice(0, 1) : null}
                      </span>
                    ) : null}

                    <span
                      className={cn(
                        'flex w-full flex-1 flex-col justify-between',
                        enableImages ? 'p-3' : '',
                      )}
                    >
                      <span className="flex items-start justify-between gap-2">
                        <span className="line-clamp-2 text-base font-semibold leading-6 text-card-foreground">
                          {product.nameAr}
                        </span>
                        {product.productType === 'weighted' ? (
                          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                            وزن
                          </span>
                        ) : null}
                      </span>

                      <span className="flex items-end justify-between gap-3">
                        <span className="flex min-w-0 flex-col items-start gap-1">
                          <BidiIsolate className="max-w-full truncate rounded-md bg-muted/70 px-1.5 py-0.5 text-xs text-muted-foreground">
                            {product.sku}
                          </BidiIsolate>
                          {product.productType === 'weighted' && product.unitLabel !== null ? (
                            <span className="text-[10px] text-muted-foreground">
                              {product.unitLabel}
                            </span>
                          ) : null}
                        </span>
                        <span className="flex shrink-0 items-baseline gap-1">
                          <Numeric
                            value={formatMinor(product.priceMinor)}
                            className="text-2xl font-bold tracking-tight text-foreground"
                          />
                          <span className="text-[10px] font-medium text-muted-foreground">ر.س</span>
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

export function ProductPanelSurface({ children }: { readonly children: JSX.Element }): JSX.Element {
  return <CardSurface className="flex min-h-0 flex-1 flex-col p-4">{children}</CardSurface>;
}
