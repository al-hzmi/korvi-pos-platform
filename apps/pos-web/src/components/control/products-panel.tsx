'use client';

import { useEffect, useState } from 'react';
import { BidiIsolate, Button, CardSurface, Numeric } from '@korvi/ui';
import { Field } from '../field';
import { StatusNote } from '../status-note';
import { ApiError } from '../../lib/api';
import { formatBasisPoints } from '../../lib/basis-points';
import { formatMinor, parseSarToMinor } from '../../lib/money';
import { useProductSearch } from '../../hooks/use-product-search';
import type { JSX } from 'react';
import type { ApiClient } from '../../lib/api';

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.serverMessage !== null) return error.serverMessage;
  return fallback;
}

export function ProductsPanel({
  api,
  canWrite = false,
}: {
  readonly api: ApiClient;
  readonly canWrite?: boolean;
}): JSX.Element {
  const search = useProductSearch(api);
  const [ready, setReady] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createFailure, setCreateFailure] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [sku, setSku] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [productType, setProductType] = useState<'unit' | 'weighted'>('unit');
  const [unitLabel, setUnitLabel] = useState('each');
  const [priceSar, setPriceSar] = useState('');
  const [barcode, setBarcode] = useState('');

  const browse = search.browse;
  useEffect(() => {
    browse();
    setReady(true);
  }, [browse]);

  const createProduct = async (): Promise<void> => {
    const normalizedSku = sku.trim();
    const normalizedName = nameAr.trim();
    const normalizedUnit = unitLabel.trim();
    const price = parseSarToMinor(priceSar);

    if (normalizedSku === '' || normalizedName === '' || normalizedUnit === '') {
      setCreateFailure('أدخل رقم الصنف واسمه ووحدة البيع.');
      return;
    }
    if (!price.ok) {
      setCreateFailure(
        price.reason === 'precision'
          ? 'السعر يقبل هللتين كحد أقصى.'
          : 'أدخل السعر بالريال بصيغة صحيحة، مثل 12.50.',
      );
      return;
    }

    setCreating(true);
    setCreateFailure(null);
    setCreateSuccess(null);
    try {
      const created = await api.createAdminProduct({
        sku: normalizedSku,
        nameAr: normalizedName,
        ...(nameEn.trim() === '' ? {} : { nameEn: nameEn.trim() }),
        productType,
        unitLabel: normalizedUnit,
        priceMinor: price.value,
        ...(barcode.trim() === '' ? {} : { barcode: barcode.trim() }),
      });
      setSku('');
      setNameAr('');
      setNameEn('');
      setProductType('unit');
      setUnitLabel('each');
      setPriceSar('');
      setBarcode('');
      setCreateSuccess(`أُنشئ الصنف «${created.nameAr}» وأصبح مفعّلاً للبيع.`);
      browse();
    } catch (error) {
      setCreateFailure(errorMessage(error, 'تعذر إنشاء الصنف.'));
    } finally {
      setCreating(false);
    }
  };

  const rows = search.state.results;

  return (
    <div className="flex flex-col gap-4">
      {canWrite ? (
        <CardSurface className="p-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold text-foreground">إضافة صنف</h2>
            <p className="text-sm text-muted-foreground">
              السعر يُكتب بالريال ويُرسل للخادم كهللات صحيحة؛ الضريبة والمخزون يُحسمان وفق إعدادات المنشأة.
            </p>
          </div>

          {createFailure === null ? null : (
            <div className="mt-4">
              <StatusNote tone="danger" live>
                {createFailure}
              </StatusNote>
            </div>
          )}
          {createSuccess === null ? null : (
            <div className="mt-4">
              <StatusNote tone="success" live>
                {createSuccess}
              </StatusNote>
            </div>
          )}

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
              رقم الصنف
              <input
                value={sku}
                disabled={creating}
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                onChange={(event) => setSku(event.target.value)}
                className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
              الاسم العربي
              <input
                value={nameAr}
                disabled={creating}
                onChange={(event) => setNameAr(event.target.value)}
                className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
              الاسم الإنجليزي — اختياري
              <input
                value={nameEn}
                disabled={creating}
                dir="ltr"
                onChange={(event) => setNameEn(event.target.value)}
                className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
              نوع الصنف
              <select
                value={productType}
                disabled={creating}
                onChange={(event) => {
                  const next = event.target.value === 'weighted' ? 'weighted' : 'unit';
                  setProductType(next);
                  if (unitLabel === 'each' || unitLabel === 'kg') {
                    setUnitLabel(next === 'weighted' ? 'kg' : 'each');
                  }
                }}
                className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="unit">بالوحدة</option>
                <option value="weighted">بالوزن</option>
              </select>
            </label>

            <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
              وحدة البيع
              <input
                value={unitLabel}
                disabled={creating}
                autoComplete="off"
                dir="ltr"
                onChange={(event) => setUnitLabel(event.target.value)}
                className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
              السعر (ر.س)
              <input
                value={priceSar}
                disabled={creating}
                inputMode="decimal"
                autoComplete="off"
                dir="ltr"
                placeholder="12.50"
                onChange={(event) => setPriceSar(event.target.value)}
                className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-medium text-foreground md:col-span-2 xl:col-span-3">
              الباركود — حسب إعدادات المنشأة
              <input
                value={barcode}
                disabled={creating}
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                onChange={(event) => setBarcode(event.target.value)}
                className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
          </div>

          <div className="mt-4 flex justify-end">
            <Button loading={creating} onClick={() => void createProduct()}>
              إنشاء الصنف
            </Button>
          </div>
        </CardSurface>
      ) : (
        <p className="text-xs text-muted-foreground">
          عرض فقط في هذه الجلسة؛ إضافة الأصناف تتطلب صلاحية كتابة المنتجات.
        </p>
      )}

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
    </div>
  );
}
