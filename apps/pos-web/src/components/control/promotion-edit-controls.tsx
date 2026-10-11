'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, CardSurface, Numeric } from '@korvi/ui';
import { Field } from '../field';
import { StatusNote } from '../status-note';
import type { JSX } from 'react';
import type { ApiClient } from '../../lib/api';
import type { AdminPromotion, AdminPromotionCoupon, ProductSummary } from '../../lib/api-types';

type RunCommand = (work: () => Promise<unknown>, success: string) => Promise<void>;

function toLocalDateTime(value: string | null): string {
  if (value === null) return '';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '';
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function fromLocalDateTime(value: string): string | null {
  if (value.trim() === '') return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('invalid date');
  return parsed.toISOString();
}

interface PromotionEditDraft {
  readonly merchantCode: string;
  readonly name: string;
  readonly activationMode: 'automatic' | 'coupon';
  readonly priority: string;
  readonly stackingMode: 'stackable' | 'exclusive';
  readonly effectKind: 'fixed' | 'percentage';
  readonly effectValue: string;
  readonly minimumEligibleSubtotalMinor: string;
  readonly targetKind: 'basket' | 'products';
  readonly startsAt: string;
  readonly endsAt: string;
}

function draftFrom(promotion: AdminPromotion): PromotionEditDraft {
  return {
    merchantCode: promotion.merchantCode,
    name: promotion.name,
    activationMode: promotion.activationMode,
    priority: String(promotion.priority),
    stackingMode: promotion.stackingMode,
    effectKind: promotion.effectKind,
    effectValue: promotion.effectValue,
    minimumEligibleSubtotalMinor: promotion.minimumEligibleSubtotalMinor,
    targetKind: promotion.targetKind,
    startsAt: toLocalDateTime(promotion.startsAt),
    endsAt: toLocalDateTime(promotion.endsAt),
  };
}

export function PromotionEditControl({
  api,
  promotion,
  disabled,
  runCommand,
}: {
  readonly api: ApiClient;
  readonly promotion: AdminPromotion;
  readonly disabled: boolean;
  readonly runCommand: RunCommand;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PromotionEditDraft>(() => draftFrom(promotion));
  const [targetIds, setTargetIds] = useState<readonly string[]>(promotion.productIds);
  const [knownProducts, setKnownProducts] = useState<Readonly<Record<string, ProductSummary>>>({});
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<readonly ProductSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    setDraft(draftFrom(promotion));
    setTargetIds(promotion.productIds);
    setKnownProducts({});
    setTerm('');
    setResults([]);
    setFailure(null);
  }, [promotion]);

  const selected = useMemo(() => new Set(targetIds), [targetIds]);
  const editable = promotion.status === 'draft' || promotion.status === 'paused';

  const updateDraft = (patch: Partial<PromotionEditDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  if (!editable) return <></>;

  const search = async (): Promise<void> => {
    const q = term.trim();
    if (q === '') {
      setResults([]);
      return;
    }
    setSearching(true);
    setFailure(null);
    try {
      const found = await api.products({ q, limit: 30 });
      setResults(found);
      setKnownProducts((current) => {
        const next: Record<string, ProductSummary> = { ...current };
        for (const product of found) next[product.id] = product;
        return next;
      });
    } catch {
      setFailure('تعذر البحث في الأصناف. أعد المحاولة.');
    } finally {
      setSearching(false);
    }
  };

  const toggleTarget = (product: ProductSummary, checked: boolean): void => {
    setKnownProducts((current) => ({ ...current, [product.id]: product }));
    setTargetIds((current) =>
      checked
        ? current.includes(product.id)
          ? current
          : [...current, product.id]
        : current.filter((id) => id !== product.id),
    );
  };

  const save = async (): Promise<void> => {
    const priority = Number(draft.priority);
    if (!Number.isInteger(priority)) {
      setFailure('الأولوية يجب أن تكون رقمًا صحيحًا.');
      return;
    }
    if (draft.name.trim() === '' || draft.merchantCode.trim() === '') {
      setFailure('اسم العرض ورمزه الداخلي مطلوبان.');
      return;
    }
    if (draft.effectValue.trim() === '' || draft.minimumEligibleSubtotalMinor.trim() === '') {
      setFailure('قيمة الخصم والحد الأدنى مطلوبان.');
      return;
    }
    if (draft.targetKind === 'products' && targetIds.length === 0) {
      setFailure('اختر صنفًا واحدًا على الأقل قبل حفظ نطاق الأصناف.');
      return;
    }

    let startsAt: string | null;
    let endsAt: string | null;
    try {
      startsAt = fromLocalDateTime(draft.startsAt);
      endsAt = fromLocalDateTime(draft.endsAt);
    } catch {
      setFailure('وقت بداية أو نهاية العرض غير صالح.');
      return;
    }

    setFailure(null);
    await runCommand(
      () =>
        api.updateAdminPromotion(promotion.id, {
          expectedRevision: promotion.revision,
          merchantCode: draft.merchantCode.trim(),
          name: draft.name.trim(),
          activationMode: draft.activationMode,
          priority,
          stackingMode: draft.stackingMode,
          startsAt,
          endsAt,
          effectKind: draft.effectKind,
          effectValue: draft.effectValue.trim(),
          minimumEligibleSubtotalMinor: draft.minimumEligibleSubtotalMinor.trim(),
          targetKind: draft.targetKind,
          productIds: draft.targetKind === 'products' ? targetIds : [],
        }),
      'تم حفظ إعدادات العرض وإعادة قراءة النسخة المعتمدة من الخادم.',
    );
    setOpen(false);
  };

  if (!open) {
    return (
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          تعديل الإعدادات
        </Button>
      </div>
    );
  }

  return (
    <CardSurface className="border-primary/15 bg-primary/[0.025] p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">تعديل العرض</h4>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            الحفظ مشروط بالنسخة الحالية rev {promotion.revision}. إذا سبقك تعديل آخر سيرفض الخادم
            الطلب بدل الكتابة فوقه.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => setOpen(false)}
        >
          إغلاق
        </Button>
      </div>

      {failure === null ? null : (
        <StatusNote tone="danger" className="mb-4" live>
          {failure}
        </StatusNote>
      )}

      <fieldset disabled={disabled} className="grid gap-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Field
            id={`promotion-edit-code-${promotion.id}`}
            label="رمز العرض الداخلي"
            value={draft.merchantCode}
            maxLength={64}
            onChange={(event) => updateDraft({ merchantCode: event.currentTarget.value })}
          />
          <Field
            id={`promotion-edit-name-${promotion.id}`}
            label="اسم العرض"
            value={draft.name}
            maxLength={160}
            onChange={(event) => updateDraft({ name: event.currentTarget.value })}
          />
          <Field
            id={`promotion-edit-priority-${promotion.id}`}
            label="الأولوية"
            inputMode="numeric"
            value={draft.priority}
            onChange={(event) => updateDraft({ priority: event.currentTarget.value })}
          />
          <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
            التكديس
            <select
              className="h-touch rounded-md border border-input bg-background px-3"
              value={draft.stackingMode}
              onChange={(event) =>
                updateDraft({
                  stackingMode: event.currentTarget.value as 'stackable' | 'exclusive',
                })
              }
            >
              <option value="stackable">قابل للتكديس</option>
              <option value="exclusive">حصري</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
            طريقة التفعيل
            <select
              className="h-touch rounded-md border border-input bg-background px-3"
              value={draft.activationMode}
              disabled={promotion.coupons.length > 0}
              onChange={(event) =>
                updateDraft({
                  activationMode: event.currentTarget.value as 'automatic' | 'coupon',
                })
              }
            >
              <option value="automatic">تلقائي</option>
              <option value="coupon">كوبون</option>
            </select>
            {promotion.coupons.length === 0 ? null : (
              <span className="text-xs font-normal text-muted-foreground">
                لا يمكن تحويل عرض لديه كوبونات إلى تلقائي؛ retire/archive الكوبونات لا يحذف التاريخ.
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
            نوع الخصم
            <select
              className="h-touch rounded-md border border-input bg-background px-3"
              value={draft.effectKind}
              onChange={(event) =>
                updateDraft({
                  effectKind: event.currentTarget.value as 'fixed' | 'percentage',
                })
              }
            >
              <option value="percentage">نسبة — basis points</option>
              <option value="fixed">مبلغ ثابت — هللات</option>
            </select>
          </label>
          <Field
            id={`promotion-edit-effect-${promotion.id}`}
            label={
              draft.effectKind === 'percentage' ? 'قيمة النسبة (1000 = 10%)' : 'قيمة الخصم بالهللات'
            }
            inputMode="numeric"
            value={draft.effectValue}
            onChange={(event) => updateDraft({ effectValue: event.currentTarget.value })}
          />
          <Field
            id={`promotion-edit-minimum-${promotion.id}`}
            label="الحد الأدنى المؤهل بالهللات"
            inputMode="numeric"
            value={draft.minimumEligibleSubtotalMinor}
            onChange={(event) =>
              updateDraft({ minimumEligibleSubtotalMinor: event.currentTarget.value })
            }
          />
          <Field
            id={`promotion-edit-start-${promotion.id}`}
            label="يبدأ في (اختياري)"
            type="datetime-local"
            value={draft.startsAt}
            onChange={(event) => updateDraft({ startsAt: event.currentTarget.value })}
          />
          <Field
            id={`promotion-edit-end-${promotion.id}`}
            label="ينتهي في (اختياري)"
            type="datetime-local"
            value={draft.endsAt}
            onChange={(event) => updateDraft({ endsAt: event.currentTarget.value })}
          />
        </div>

        <div className="grid gap-3 md:grid-cols-[14rem_1fr]">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
            النطاق
            <select
              className="h-touch rounded-md border border-input bg-background px-3"
              value={draft.targetKind}
              onChange={(event) =>
                updateDraft({
                  targetKind: event.currentTarget.value as 'basket' | 'products',
                })
              }
            >
              <option value="basket">السلة</option>
              <option value="products">أصناف محددة</option>
            </select>
          </label>

          {draft.targetKind === 'products' ? (
            <div className="rounded-lg border border-border bg-background p-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Field
                  id={`promotion-edit-product-search-${promotion.id}`}
                  label="بحث الأصناف"
                  value={term}
                  className="min-w-0"
                  onChange={(event) => setTerm(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void search();
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="self-end"
                  disabled={searching}
                  onClick={() => void search()}
                >
                  {searching ? 'جارٍ البحث…' : 'بحث'}
                </Button>
              </div>

              {targetIds.length === 0 ? null : (
                <div className="mt-3 flex flex-wrap gap-2">
                  {targetIds.map((id) => (
                    <span
                      key={id}
                      className="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-2.5 py-1 text-xs"
                    >
                      <span className="max-w-[14rem] truncate">
                        {knownProducts[id]?.nameAr ?? `صنف ${id.slice(0, 8)}…`}
                      </span>
                      <button
                        type="button"
                        className="font-semibold text-muted-foreground hover:text-foreground"
                        aria-label={`إزالة ${knownProducts[id]?.nameAr ?? id}`}
                        onClick={() =>
                          setTargetIds((current) => current.filter((entry) => entry !== id))
                        }
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {results.length === 0 ? null : (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {results.map((product) => (
                    <label
                      key={product.id}
                      className="flex items-center gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(product.id)}
                        onChange={(event) => toggleTarget(product, event.currentTarget.checked)}
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{product.nameAr}</span>
                        <span className="block truncate text-xs text-muted-foreground" dir="ltr">
                          {product.sku}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}

              <p className="mt-3 text-xs text-muted-foreground">
                الهدف المعتمد بعد الحفظ: <Numeric value={String(targetIds.length)} /> صنف. تغيير
                targets مسموح فقط للمسودة أو العرض الموقوف.
              </p>
            </div>
          ) : (
            <div className="flex items-center rounded-lg border border-border bg-background px-4 text-sm text-muted-foreground">
              سيُحذف allow-list الحالي عند الحفظ ويصبح العرض على السلة.
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={disabled} onClick={() => setOpen(false)}>
            إلغاء
          </Button>
          <Button type="button" disabled={disabled} onClick={() => void save()}>
            حفظ التعديلات
          </Button>
        </div>
      </fieldset>
    </CardSurface>
  );
}

export function CouponEditControl({
  api,
  coupon,
  disabled,
  runCommand,
}: {
  readonly api: ApiClient;
  readonly coupon: AdminPromotionCoupon;
  readonly disabled: boolean;
  readonly runCommand: RunCommand;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState(coupon.normalizedCode);
  const [limit, setLimit] = useState(
    coupon.totalRedemptionLimit === null ? '' : String(coupon.totalRedemptionLimit),
  );
  const [startsAt, setStartsAt] = useState(toLocalDateTime(coupon.startsAt));
  const [endsAt, setEndsAt] = useState(toLocalDateTime(coupon.endsAt));
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    setCode(coupon.normalizedCode);
    setLimit(coupon.totalRedemptionLimit === null ? '' : String(coupon.totalRedemptionLimit));
    setStartsAt(toLocalDateTime(coupon.startsAt));
    setEndsAt(toLocalDateTime(coupon.endsAt));
    setFailure(null);
  }, [coupon]);

  if (coupon.status === 'retired') return <></>;

  const save = async (): Promise<void> => {
    const normalizedCode = code.trim();
    if (normalizedCode === '') {
      setFailure('كود الخصم مطلوب.');
      return;
    }

    let totalRedemptionLimit: number | null = null;
    if (limit.trim() !== '') {
      totalRedemptionLimit = Number(limit);
      if (!Number.isInteger(totalRedemptionLimit) || totalRedemptionLimit <= 0) {
        setFailure('حد الاستخدام يجب أن يكون عددًا صحيحًا أكبر من صفر.');
        return;
      }
      if (totalRedemptionLimit < coupon.observedRedemptionCount) {
        setFailure('لا يمكن جعل حد الاستخدام أقل من عدد مرات الاستخدام المسجلة.');
        return;
      }
    }

    let nextStartsAt: string | null;
    let nextEndsAt: string | null;
    try {
      nextStartsAt = fromLocalDateTime(startsAt);
      nextEndsAt = fromLocalDateTime(endsAt);
    } catch {
      setFailure('وقت بداية أو نهاية الكوبون غير صالح.');
      return;
    }

    setFailure(null);
    await runCommand(
      () =>
        api.updateAdminCoupon(coupon.id, {
          expectedRevision: coupon.revision,
          code: normalizedCode,
          startsAt: nextStartsAt,
          endsAt: nextEndsAt,
          totalRedemptionLimit,
        }),
      'تم حفظ إعدادات كود الخصم وإعادة قراءة النسخة المعتمدة من الخادم.',
    );
    setOpen(false);
  };

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        تعديل
      </Button>
    );
  }

  return (
    <div className="mt-2 min-w-[24rem] rounded-lg border border-border bg-background p-3">
      {failure === null ? null : (
        <StatusNote tone="danger" className="mb-3" live>
          {failure}
        </StatusNote>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          id={`coupon-edit-code-${coupon.id}`}
          label="الكود"
          value={code}
          maxLength={64}
          onChange={(event) => setCode(event.currentTarget.value)}
        />
        <Field
          id={`coupon-edit-limit-${coupon.id}`}
          label="حد الاستخدام"
          inputMode="numeric"
          value={limit}
          placeholder="بلا حد"
          onChange={(event) => setLimit(event.currentTarget.value)}
        />
        <Field
          id={`coupon-edit-start-${coupon.id}`}
          label="يبدأ في"
          type="datetime-local"
          value={startsAt}
          onChange={(event) => setStartsAt(event.currentTarget.value)}
        />
        <Field
          id={`coupon-edit-end-${coupon.id}`}
          label="ينتهي في"
          type="datetime-local"
          value={endsAt}
          onChange={(event) => setEndsAt(event.currentTarget.value)}
        />
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => setOpen(false)}
        >
          إلغاء
        </Button>
        <Button type="button" size="sm" disabled={disabled} onClick={() => void save()}>
          حفظ
        </Button>
      </div>
    </div>
  );
}
