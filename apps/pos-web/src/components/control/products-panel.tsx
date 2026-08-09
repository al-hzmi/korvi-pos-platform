'use client';

import { useEffect, useState } from 'react';
import { BidiIsolate, CardSurface, Numeric } from '@korvi/ui';
import { Field } from '../field';
import { StatusNote } from '../status-note';
import { formatBasisPoints } from '../../lib/basis-points';
import { formatMinor } from '../../lib/money';
import { useProductSearch } from '../../hooks/use-product-search';
import type { JSX } from 'react';
import type { ApiClient } from '../../lib/api';

/**
 * The catalogue, as it actually is.
 *
 * Read-only, because there is no product write API to be honest about yet. A
 * disabled "edit" button that has nothing behind it is worse than no button:
 * it promises a capability the product does not have.
 *
 * The same search controller the till uses, so the abort and ordering
 * guarantees are the ones already proven rather than a second implementation.
 */
export function ProductsPanel({ api }: { readonly api: ApiClient }): JSX.Element {
  const search = useProductSearch(api);
  const [ready, setReady] = useState(false);

  const browse = search.browse;
  useEffect(() => {
    browse();
    setReady(true);
  }, [browse]);

  const rows = search.state.results;

  return (
    <div className="flex flex-col gap-4">
      <Field
        id="control-product-search"
        label="ابحث في الأصناف"
        type="search"
        autoComplete="off"
        spellCheck={false}
        value={search.term}
        placeholder="اسم الصنف، الرمز، أو الباركود"
        onChange={(event) => {
          search.setTerm(event.target.value);
        }}
      />

      {search.state.status === 'failed' && search.state.failure !== null ? (
        <StatusNote tone="warning" live>
          {search.state.failure.message}
        </StatusNote>
      ) : null}

      {!ready || search.state.status === 'loading' ? (
        <p className="py-8 text-center text-sm text-muted-foreground" role="status">
          جارٍ التحميل…
        </p>
      ) : null}

      {search.state.status === 'ready' && rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground" role="status">
          لا توجد أصناف مطابقة.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <CardSurface className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-3 py-3 text-start font-medium">
                  الصنف
                </th>
                <th scope="col" className="px-3 py-3 text-start font-medium">
                  الرمز
                </th>
                <th scope="col" className="px-3 py-3 text-start font-medium">
                  الباركود
                </th>
                <th scope="col" className="px-3 py-3 text-start font-medium">
                  النوع
                </th>
                <th scope="col" className="px-3 py-3 text-start font-medium">
                  السعر
                </th>
                <th scope="col" className="px-3 py-3 text-start font-medium">
                  الضريبة
                </th>
                <th scope="col" className="px-3 py-3 text-start font-medium">
                  المخزون
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((product) => (
                <tr
                  key={product.id}
                  className="border-b border-border last:border-b-0 hover:bg-accent/40"
                >
                  <td className="px-3 py-4 font-medium text-card-foreground">{product.nameAr}</td>
                  <td className="px-3 py-4">
                    <BidiIsolate className="text-muted-foreground">{product.sku}</BidiIsolate>
                  </td>
                  <td className="px-3 py-4 text-muted-foreground">
                    {product.primaryBarcode === null ? (
                      <span aria-label="بدون باركود">—</span>
                    ) : (
                      <BidiIsolate>{product.primaryBarcode}</BidiIsolate>
                    )}
                  </td>
                  <td className="px-3 py-4 text-muted-foreground">
                    {product.productType === 'weighted' ? 'بالوزن' : 'بالوحدة'}
                    {product.unitLabel === null ? '' : ` · ${product.unitLabel}`}
                  </td>
                  <td className="px-3 py-4">
                    <Numeric value={formatMinor(product.priceMinor)} />
                  </td>
                  <td className="px-3 py-4">
                    <Numeric value={formatBasisPoints(product.vatBasisPoints)} />
                  </td>
                  <td className="px-3 py-4 text-muted-foreground">
                    {product.trackInventory ? 'يُتابَع' : 'لا يُتابَع'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardSurface>
      ) : null}

      <p className="text-xs text-muted-foreground">
        عرض فقط في هذه المرحلة. تعديل الأصناف يحتاج واجهة كتابة لم تُبنَ بعد.
      </p>
    </div>
  );
}
