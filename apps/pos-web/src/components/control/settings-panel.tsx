'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { StatusNote } from '../status-note';
import { ApiError } from '../../lib/api';
import { formatBasisPoints } from '../../lib/basis-points';
import type { JSX } from 'react';
import type { ApiClient } from '../../lib/api';
import type { AdminSettingsPatch, AdminTenantSettings } from '../../lib/api-types';

interface SettingsDraft {
  readonly requireBarcode: boolean;
  readonly allowWeightedItems: boolean;
  readonly trackInventory: boolean;
  readonly allowNegativeStock: boolean;
  readonly enableProductImages: boolean;
  readonly receiptHeaderAr: string;
  readonly receiptFooterAr: string;
}

function draftOf(settings: AdminTenantSettings): SettingsDraft {
  return {
    requireBarcode: settings.requireBarcode,
    allowWeightedItems: settings.allowWeightedItems,
    trackInventory: settings.trackInventory,
    allowNegativeStock: settings.allowNegativeStock,
    enableProductImages: settings.enableProductImages,
    receiptHeaderAr: settings.receiptHeaderAr ?? '',
    receiptFooterAr: settings.receiptFooterAr ?? '',
  };
}

function patchOf(settings: AdminTenantSettings, draft: SettingsDraft): AdminSettingsPatch {
  const header = draft.receiptHeaderAr.trim() === '' ? null : draft.receiptHeaderAr;
  const footer = draft.receiptFooterAr.trim() === '' ? null : draft.receiptFooterAr;
  return {
    ...(draft.requireBarcode === settings.requireBarcode
      ? {}
      : { requireBarcode: draft.requireBarcode }),
    ...(draft.allowWeightedItems === settings.allowWeightedItems
      ? {}
      : { allowWeightedItems: draft.allowWeightedItems }),
    ...(draft.trackInventory === settings.trackInventory
      ? {}
      : { trackInventory: draft.trackInventory }),
    ...(draft.allowNegativeStock === settings.allowNegativeStock
      ? {}
      : { allowNegativeStock: draft.allowNegativeStock }),
    ...(draft.enableProductImages === settings.enableProductImages
      ? {}
      : { enableProductImages: draft.enableProductImages }),
    ...(header === settings.receiptHeaderAr ? {} : { receiptHeaderAr: header }),
    ...(footer === settings.receiptFooterAr ? {} : { receiptFooterAr: footer }),
  };
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.serverMessage !== null) return error.serverMessage;
  return fallback;
}

function BooleanSetting({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-border bg-background p-4">
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-foreground">{label}</span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-5 w-5 shrink-0 accent-primary"
      />
    </label>
  );
}

export function SettingsPanel({ api }: { readonly api: ApiClient }): JSX.Element {
  const [settings, setSettings] = useState<AdminTenantSettings | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = async (): Promise<void> => {
    setLoading(true);
    setFailure(null);
    try {
      const value = await api.adminSettings();
      setSettings(value);
      setDraft(draftOf(value));
    } catch (error) {
      setFailure(errorMessage(error, 'تعذر تحميل إعدادات المنشأة.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // The injected client is stable in production and in tests. A changed
    // client represents a changed transport and should reload the authority.
  }, [api]);

  const patch = useMemo(
    () => (settings === null || draft === null ? null : patchOf(settings, draft)),
    [draft, settings],
  );
  const changed = patch !== null && Object.keys(patch).length > 0;

  const update = <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]): void => {
    setSaved(false);
    setDraft((current) => (current === null ? current : { ...current, [key]: value }));
  };

  const save = async (): Promise<void> => {
    if (draft === null || patch === null || !changed) return;
    setSaving(true);
    setFailure(null);
    setSaved(false);
    try {
      // Send only fields this operator actually changed. A stale screen must
      // not overwrite an unrelated setting another administrator changed after
      // this page loaded.
      const value = await api.updateAdminSettings(patch);
      setSettings(value);
      setDraft(draftOf(value));
      setSaved(true);
    } catch (error) {
      setFailure(errorMessage(error, 'تعذر حفظ إعدادات المنشأة. لم يتم تأكيد التغيير.'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <CardSurface className="p-6">
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          جارٍ تحميل إعدادات المنشأة…
        </p>
      </CardSurface>
    );
  }

  if (settings === null || draft === null) {
    return (
      <CardSurface className="flex flex-col gap-4 p-6">
        <StatusNote tone="danger" live>
          {failure ?? 'تعذر تحميل إعدادات المنشأة.'}
        </StatusNote>
        <Button variant="outline" onClick={() => void load()}>
          إعادة المحاولة
        </Button>
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
      {saved ? (
        <StatusNote tone="success" live>
          حُفظت إعدادات المنشأة وأصبحت القراءة الحالية مطابقة للخادم.
        </StatusNote>
      ) : null}

      <CardSurface className="p-5">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-foreground">هوية التشغيل</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            معلومات مرجعية للمنشأة. لا يمكن تغيير التسعير أو الضريبة من هذه الشاشة.
          </p>
        </div>
        <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ['النشاط', settings.vertical],
            ['نمط السعر', settings.priceMode],
            ['العملة', settings.currency],
            ['ضريبة القيمة المضافة', formatBasisPoints(settings.defaultVatBasisPoints)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border bg-muted/40 p-3">
              <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
              <dd className="mt-1 text-sm font-semibold text-foreground" dir="auto">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </CardSurface>

      <CardSurface className="p-5">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-foreground">سلوك نقطة البيع</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            تغييرات تشغيلية تُطبّق على المنشأة الحالية فقط.
          </p>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <BooleanSetting
            label="اشتراط الباركود"
            description="يُبقي سير العمل معتمداً على الباركود عندما يكون ذلك مطلوباً للنشاط."
            checked={draft.requireBarcode}
            disabled={saving}
            onChange={(value) => update('requireBarcode', value)}
          />
          <BooleanSetting
            label="السماح بالأصناف الموزونة"
            description="يتيح كميات ذات مقياس 1000 للأصناف التي تُباع بالوزن."
            checked={draft.allowWeightedItems}
            disabled={saving}
            onChange={(value) => update('allowWeightedItems', value)}
          />
          <BooleanSetting
            label="تتبع المخزون"
            description="يعتمد حركة البيع على إعداد التتبع المخزني للمنشأة."
            checked={draft.trackInventory}
            disabled={saving}
            onChange={(value) => update('trackInventory', value)}
          />
          <BooleanSetting
            label="السماح بالمخزون السالب"
            description="قرار تشغيلي حساس؛ فعّله فقط عندما تكون سياسة المنشأة تسمح بذلك."
            checked={draft.allowNegativeStock}
            disabled={saving}
            onChange={(value) => update('allowNegativeStock', value)}
          />
          <BooleanSetting
            label="صور المنتجات"
            description="يعرض صور الأصناف في الواجهات التي تدعمها عندما تكون متاحة."
            checked={draft.enableProductImages}
            disabled={saving}
            onChange={(value) => update('enableProductImages', value)}
          />
        </div>
      </CardSurface>

      <CardSurface className="p-5">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-foreground">رأس وتذييل الإيصال</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            اترك الحقل فارغاً لمسح السطر. النص يُحفظ كما سيقرأه مسار الطباعة.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
            رأس الإيصال
            <input
              value={draft.receiptHeaderAr}
              disabled={saving}
              onChange={(event) => update('receiptHeaderAr', event.target.value)}
              className="h-touch rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              dir="rtl"
            />
          </label>
          <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
            تذييل الإيصال
            <input
              value={draft.receiptFooterAr}
              disabled={saving}
              onChange={(event) => update('receiptFooterAr', event.target.value)}
              className="h-touch rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              dir="rtl"
            />
          </label>
        </div>
      </CardSurface>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline"
          disabled={saving || !changed}
          onClick={() => setDraft(draftOf(settings))}
        >
          تراجع عن التغييرات
        </Button>
        <Button loading={saving} disabled={!changed} onClick={() => void save()}>
          حفظ الإعدادات
        </Button>
      </div>
    </div>
  );
}
