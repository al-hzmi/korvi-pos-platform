'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, CardSurface, Numeric } from '@korvi/ui';
import { Field } from '../field';
import { StatusNote } from '../status-note';
import { ApiError } from '../../lib/api';
import { formatMinor } from '../../lib/money';
import type { JSX } from 'react';
import type { ApiClient } from '../../lib/api';
import type { AdminPromotion, AdminPromotionCoupon, ProductSummary } from '../../lib/api-types';

type PromotionStatus = AdminPromotion['status'];

interface CreateDraft {
  readonly merchantCode: string;
  readonly name: string;
  readonly activationMode: 'automatic' | 'coupon';
  readonly priority: string;
  readonly stackingMode: 'stackable' | 'exclusive';
  readonly effectKind: 'fixed' | 'percentage';
  readonly effectValue: string;
  readonly minimumEligibleSubtotalMinor: string;
  readonly targetKind: 'basket' | 'products';
}

const INITIAL_DRAFT: CreateDraft = {
  merchantCode: '',
  name: '',
  activationMode: 'automatic',
  priority: '100',
  stackingMode: 'stackable',
  effectKind: 'percentage',
  effectValue: '1000',
  minimumEligibleSubtotalMinor: '0',
  targetKind: 'basket',
};

const STATUS_LABEL: Readonly<Record<PromotionStatus, string>> = {
  draft: 'مسودة',
  active: 'نشط',
  paused: 'موقوف',
  archived: 'مؤرشف',
};

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.serverMessage !== null) return error.serverMessage;
  return fallback;
}

function effectLabel(promotion: AdminPromotion): string {
  if (promotion.effectKind === 'percentage') {
    const basisPoints = BigInt(promotion.effectValue);
    const whole = basisPoints / 100n;
    const fraction = basisPoints % 100n;
    return fraction === 0n
      ? `${whole.toString()}%`
      : `${whole.toString()}.${fraction.toString().padStart(2, '0')}%`;
  }
  return `${formatMinor(promotion.effectValue)} ر.س`;
}

function couponStatusLabel(status: AdminPromotionCoupon['status']): string {
  if (status === 'active') return 'نشط';
  if (status === 'paused') return 'موقوف';
  return 'متقاعد';
}

export function PromotionsPanel({
  api,
  onCommandLockChange,
}: {
  readonly api: ApiClient;
  readonly onCommandLockChange?: (locked: boolean) => void;
}): JSX.Element {
  const [promotions, setPromotions] = useState<readonly AdminPromotion[] | null>(null);
  const [draft, setDraft] = useState<CreateDraft>(INITIAL_DRAFT);
  const [selectedProducts, setSelectedProducts] = useState<readonly ProductSummary[]>([]);
  const [productTerm, setProductTerm] = useState('');
  const [productResults, setProductResults] = useState<readonly ProductSummary[]>([]);
  const [productSearching, setProductSearching] = useState(false);
  const [couponDrafts, setCouponDrafts] = useState<Record<string, string>>({});
  const [couponLimits, setCouponLimits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<readonly AdminPromotion[]> => {
      const value = await api.adminPromotions(signal === undefined ? undefined : { signal });
      setPromotions(value);
      return value;
    },
    [api],
  );

  useEffect(() => {
    const controller = new AbortController();
    setFailure(null);
    void load(controller.signal).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setFailure(messageOf(error, 'تعذر تحميل العروض والكوبونات.'));
      setPromotions([]);
    });
    return () => controller.abort();
  }, [load]);

  const runCommand = useCallback(
    async (work: () => Promise<unknown>, success: string): Promise<void> => {
      if (busy) return;
      setBusy(true);
      setFailure(null);
      setNotice(null);
      onCommandLockChange?.(true);
      try {
        await work();
        await load();
        setNotice(success);
      } catch (error) {
        setFailure(
          messageOf(
            error,
            'تعذر تأكيد التغيير. أعد تحميل القائمة قبل اتخاذ قرار آخر حتى لا تعمل على نسخة قديمة.',
          ),
        );
        try {
          await load();
        } catch {
          // Preserve the original command failure; the operator already has an
          // explicit instruction not to make another decision from stale data.
        }
      } finally {
        setBusy(false);
        onCommandLockChange?.(false);
      }
    },
    [busy, load, onCommandLockChange],
  );

  const selectedIds = useMemo(
    () => new Set(selectedProducts.map((product) => product.id)),
    [selectedProducts],
  );

  const searchProducts = async (): Promise<void> => {
    const q = productTerm.trim();
    if (q === '') {
      setProductResults([]);
      return;
    }
    setProductSearching(true);
    setFailure(null);
    try {
      setProductResults(await api.products({ q, limit: 30 }));
    } catch (error) {
      setFailure(messageOf(error, 'تعذر البحث في الأصناف.'));
    } finally {
      setProductSearching(false);
    }
  };

  const createPromotion = async (): Promise<void> => {
    const priority = Number(draft.priority);
    if (!Number.isInteger(priority)) {
      setFailure('الأولوية يجب أن تكون رقمًا صحيحًا.');
      return;
    }
    if (draft.targetKind === 'products' && selectedProducts.length === 0) {
      setFailure('اختر صنفًا واحدًا على الأقل للعرض المخصص للأصناف.');
      return;
    }
    await runCommand(async () => {
      await api.createAdminPromotion({
        merchantCode: draft.merchantCode.trim(),
        name: draft.name.trim(),
        activationMode: draft.activationMode,
        priority,
        stackingMode: draft.stackingMode,
        startsAt: null,
        endsAt: null,
        effectKind: draft.effectKind,
        effectValue: draft.effectValue.trim(),
        minimumEligibleSubtotalMinor: draft.minimumEligibleSubtotalMinor.trim(),
        targetKind: draft.targetKind,
        productIds:
          draft.targetKind === 'products' ? selectedProducts.map((product) => product.id) : [],
      });
      setDraft(INITIAL_DRAFT);
      setSelectedProducts([]);
      setProductResults([]);
      setProductTerm('');
    }, 'تم إنشاء العرض كمسودة. راجع تفاصيله ثم فعّله عندما يصبح جاهزًا.');
  };

  const changeStatus = async (
    promotion: AdminPromotion,
    status: Exclude<PromotionStatus, 'draft'>,
  ): Promise<void> => {
    await runCommand(
      () =>
        api.updateAdminPromotion(promotion.id, {
          expectedRevision: promotion.revision,
          status,
        }),
      status === 'active'
        ? 'تم تفعيل العرض وأصبح الخادم يقيّمه عند البيع.'
        : status === 'paused'
          ? 'تم إيقاف العرض.'
          : 'تمت أرشفة العرض.',
    );
  };

  const createCoupon = async (promotion: AdminPromotion): Promise<void> => {
    const code = couponDrafts[promotion.id]?.trim() ?? '';
    const rawLimit = couponLimits[promotion.id]?.trim() ?? '';
    if (code === '') {
      setFailure('اكتب كود الخصم قبل الحفظ.');
      return;
    }
    let limit: number | null = null;
    if (rawLimit !== '') {
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit <= 0) {
        setFailure('حد الاستخدام يجب أن يكون عددًا صحيحًا أكبر من صفر.');
        return;
      }
    }
    await runCommand(async () => {
      await api.createAdminCoupon(promotion.id, {
        code,
        status: 'active',
        startsAt: null,
        endsAt: null,
        totalRedemptionLimit: limit,
      });
      setCouponDrafts((current) => ({ ...current, [promotion.id]: '' }));
      setCouponLimits((current) => ({ ...current, [promotion.id]: '' }));
    }, 'تم إنشاء كود الخصم.');
  };

  const changeCouponStatus = async (
    coupon: AdminPromotionCoupon,
    status: AdminPromotionCoupon['status'],
  ): Promise<void> => {
    await runCommand(
      () =>
        api.updateAdminCoupon(coupon.id, {
          expectedRevision: coupon.revision,
          status,
        }),
      status === 'active'
        ? 'تم تفعيل كود الخصم.'
        : status === 'paused'
          ? 'تم إيقاف كود الخصم.'
          : 'تم تقاعد كود الخصم ولن يعود صالحًا للبيع.',
    );
  };

  if (promotions === null) {
    return (
      <CardSurface className="p-6">
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          جارٍ تحميل العروض والكوبونات…
        </p>
      </CardSurface>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {failure === null ? null : (
        <StatusNote tone="danger" live>
          {failure}
        </StatusNote>
      )}
      {notice === null ? null : (
        <StatusNote tone="success" live>
          {notice}
        </StatusNote>
      )}

      <CardSurface className="p-5">
        <div className="mb-5">
          <h2 className="text-base font-semibold text-foreground">إنشاء عرض</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            يبدأ العرض كمسودة. السعر النهائي، الأهلية، التكديس وحدود الكوبون تُحسم على الخادم فقط.
          </p>
        </div>

        <fieldset disabled={busy} className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Field
              id="promotion-code"
              label="رمز العرض الداخلي"
              value={draft.merchantCode}
              maxLength={64}
              onChange={(event) =>
                setDraft((current) => ({ ...current, merchantCode: event.currentTarget.value }))
              }
            />
            <Field
              id="promotion-name"
              label="اسم العرض"
              value={draft.name}
              maxLength={160}
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.currentTarget.value }))
              }
            />
            <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
              طريقة التفعيل
              <select
                className="h-touch rounded-md border border-input bg-background px-3"
                value={draft.activationMode}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    activationMode: event.currentTarget.value as 'automatic' | 'coupon',
                  }))
                }
              >
                <option value="automatic">تلقائي</option>
                <option value="coupon">كوبون</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
              التكديس
              <select
                className="h-touch rounded-md border border-input bg-background px-3"
                value={draft.stackingMode}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    stackingMode: event.currentTarget.value as 'stackable' | 'exclusive',
                  }))
                }
              >
                <option value="stackable">قابل للتكديس</option>
                <option value="exclusive">حصري</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
              نوع الخصم
              <select
                className="h-touch rounded-md border border-input bg-background px-3"
                value={draft.effectKind}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    effectKind: event.currentTarget.value as 'fixed' | 'percentage',
                  }))
                }
              >
                <option value="percentage">نسبة — basis points</option>
                <option value="fixed">مبلغ ثابت — هللات</option>
              </select>
            </label>
            <Field
              id="promotion-effect-value"
              label={
                draft.effectKind === 'percentage'
                  ? 'قيمة النسبة (1000 = 10%)'
                  : 'قيمة الخصم بالهللات'
              }
              inputMode="numeric"
              value={draft.effectValue}
              onChange={(event) =>
                setDraft((current) => ({ ...current, effectValue: event.currentTarget.value }))
              }
            />
            <Field
              id="promotion-minimum"
              label="الحد الأدنى المؤهل بالهللات"
              inputMode="numeric"
              value={draft.minimumEligibleSubtotalMinor}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  minimumEligibleSubtotalMinor: event.currentTarget.value,
                }))
              }
            />
            <Field
              id="promotion-priority"
              label="الأولوية"
              inputMode="numeric"
              value={draft.priority}
              onChange={(event) =>
                setDraft((current) => ({ ...current, priority: event.currentTarget.value }))
              }
            />
          </div>

          <div className="grid gap-3 md:grid-cols-[14rem_1fr]">
            <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
              النطاق
              <select
                className="h-touch rounded-md border border-input bg-background px-3"
                value={draft.targetKind}
                onChange={(event) => {
                  const targetKind = event.currentTarget.value as 'basket' | 'products';
                  setDraft((current) => ({ ...current, targetKind }));
                  if (targetKind === 'basket') setSelectedProducts([]);
                }}
              >
                <option value="basket">السلة</option>
                <option value="products">أصناف محددة</option>
              </select>
            </label>

            {draft.targetKind === 'products' ? (
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Field
                    id="promotion-product-search"
                    label="بحث الأصناف"
                    value={productTerm}
                    className="min-w-0"
                    onChange={(event) => setProductTerm(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void searchProducts();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="self-end"
                    disabled={productSearching}
                    onClick={() => void searchProducts()}
                  >
                    {productSearching ? 'جارٍ البحث…' : 'بحث'}
                  </Button>
                </div>
                {productResults.length === 0 ? null : (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {productResults.map((product) => {
                      const checked = selectedIds.has(product.id);
                      return (
                        <label
                          key={product.id}
                          className="flex items-center gap-3 rounded-md border border-border bg-background p-3 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => {
                              setSelectedProducts((current) =>
                                event.currentTarget.checked
                                  ? [...current, product]
                                  : current.filter((entry) => entry.id !== product.id),
                              );
                            }}
                          />
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{product.nameAr}</span>
                            <span
                              className="block truncate text-xs text-muted-foreground"
                              dir="ltr"
                            >
                              {product.sku}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
                {selectedProducts.length === 0 ? null : (
                  <p className="mt-3 text-xs text-muted-foreground">
                    الأصناف المحددة: <Numeric value={String(selectedProducts.length)} />
                  </p>
                )}
              </div>
            ) : (
              <div className="flex items-center rounded-lg border border-border bg-muted/30 px-4 text-sm text-muted-foreground">
                العرض يُقيّم على السلة المؤهلة كاملة.
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <Button
              type="button"
              disabled={
                draft.merchantCode.trim() === '' ||
                draft.name.trim() === '' ||
                draft.effectValue.trim() === '' ||
                draft.minimumEligibleSubtotalMinor.trim() === ''
              }
              onClick={() => void createPromotion()}
            >
              إنشاء كمسودة
            </Button>
          </div>
        </fieldset>
      </CardSurface>

      <div className="grid gap-4">
        {promotions.length === 0 ? (
          <CardSurface className="p-6">
            <p className="text-sm text-muted-foreground">لا توجد عروض بعد.</p>
          </CardSurface>
        ) : (
          promotions.map((promotion) => (
            <CardSurface key={promotion.id} className="p-5">
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-foreground">{promotion.name}</h3>
                      <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-medium">
                        {STATUS_LABEL[promotion.status]}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground" dir="ltr">
                      {promotion.merchantCode} · rev {promotion.revision}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {promotion.status === 'draft' || promotion.status === 'paused' ? (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => void changeStatus(promotion, 'active')}
                      >
                        تفعيل
                      </Button>
                    ) : null}
                    {promotion.status === 'active' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void changeStatus(promotion, 'paused')}
                      >
                        إيقاف
                      </Button>
                    ) : null}
                    {promotion.status !== 'archived' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void changeStatus(promotion, 'archived')}
                      >
                        أرشفة
                      </Button>
                    ) : null}
                  </div>
                </div>

                <dl className="grid gap-2 text-sm sm:grid-cols-2 xl:grid-cols-5">
                  <div className="rounded-md bg-muted/40 p-3">
                    <dt className="text-xs text-muted-foreground">الخصم</dt>
                    <dd className="mt-1 font-semibold">{effectLabel(promotion)}</dd>
                  </div>
                  <div className="rounded-md bg-muted/40 p-3">
                    <dt className="text-xs text-muted-foreground">التفعيل</dt>
                    <dd className="mt-1 font-semibold">
                      {promotion.activationMode === 'automatic' ? 'تلقائي' : 'كوبون'}
                    </dd>
                  </div>
                  <div className="rounded-md bg-muted/40 p-3">
                    <dt className="text-xs text-muted-foreground">التكديس</dt>
                    <dd className="mt-1 font-semibold">
                      {promotion.stackingMode === 'exclusive' ? 'حصري' : 'قابل للتكديس'}
                    </dd>
                  </div>
                  <div className="rounded-md bg-muted/40 p-3">
                    <dt className="text-xs text-muted-foreground">النطاق</dt>
                    <dd className="mt-1 font-semibold">
                      {promotion.targetKind === 'basket'
                        ? 'السلة'
                        : `${promotion.productIds.length} صنف`}
                    </dd>
                  </div>
                  <div className="rounded-md bg-muted/40 p-3">
                    <dt className="text-xs text-muted-foreground">الأولوية</dt>
                    <dd className="mt-1 font-semibold">
                      <Numeric value={String(promotion.priority)} />
                    </dd>
                  </div>
                </dl>

                {promotion.activationMode !== 'coupon' ? null : (
                  <div className="border-t border-border pt-4">
                    <h4 className="text-sm font-semibold">أكواد الخصم</h4>
                    {promotion.status === 'archived' ? null : (
                      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_12rem_auto]">
                        <Field
                          id={`coupon-code-${promotion.id}`}
                          label="كود جديد"
                          value={couponDrafts[promotion.id] ?? ''}
                          maxLength={64}
                          onChange={(event) =>
                            setCouponDrafts((current) => ({
                              ...current,
                              [promotion.id]: event.currentTarget.value,
                            }))
                          }
                        />
                        <Field
                          id={`coupon-limit-${promotion.id}`}
                          label="حد الاستخدام (اختياري)"
                          inputMode="numeric"
                          value={couponLimits[promotion.id] ?? ''}
                          onChange={(event) =>
                            setCouponLimits((current) => ({
                              ...current,
                              [promotion.id]: event.currentTarget.value,
                            }))
                          }
                        />
                        <Button
                          type="button"
                          className="self-end"
                          disabled={busy}
                          onClick={() => void createCoupon(promotion)}
                        >
                          إضافة الكوبون
                        </Button>
                      </div>
                    )}

                    {promotion.coupons.length === 0 ? (
                      <p className="mt-3 text-sm text-muted-foreground">
                        لا توجد أكواد خصم لهذا العرض.
                      </p>
                    ) : (
                      <div className="mt-3 overflow-x-auto">
                        <table className="w-full min-w-[42rem] text-sm">
                          <thead>
                            <tr className="border-b border-border text-start text-xs text-muted-foreground">
                              <th className="p-2 text-start">الكود</th>
                              <th className="p-2 text-start">الحالة</th>
                              <th className="p-2 text-start">الاستخدام</th>
                              <th className="p-2 text-start">الحد</th>
                              <th className="p-2 text-start">الإجراء</th>
                            </tr>
                          </thead>
                          <tbody>
                            {promotion.coupons.map((coupon) => (
                              <tr key={coupon.id} className="border-b border-border/70">
                                <td className="p-2 font-mono font-semibold" dir="ltr">
                                  {coupon.normalizedCode}
                                </td>
                                <td className="p-2">{couponStatusLabel(coupon.status)}</td>
                                <td className="p-2">
                                  <Numeric value={String(coupon.observedRedemptionCount)} />
                                </td>
                                <td className="p-2">
                                  {coupon.totalRedemptionLimit === null ? (
                                    'بلا حد'
                                  ) : (
                                    <Numeric value={String(coupon.totalRedemptionLimit)} />
                                  )}
                                </td>
                                <td className="p-2">
                                  <div className="flex gap-2">
                                    {coupon.status === 'paused' ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={busy}
                                        onClick={() => void changeCouponStatus(coupon, 'active')}
                                      >
                                        تفعيل
                                      </Button>
                                    ) : null}
                                    {coupon.status === 'active' ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={busy}
                                        onClick={() => void changeCouponStatus(coupon, 'paused')}
                                      >
                                        إيقاف
                                      </Button>
                                    ) : null}
                                    {coupon.status !== 'retired' ? (
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        disabled={busy}
                                        onClick={() => void changeCouponStatus(coupon, 'retired')}
                                      >
                                        تقاعد
                                      </Button>
                                    ) : null}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </CardSurface>
          ))
        )}
      </div>
    </div>
  );
}
