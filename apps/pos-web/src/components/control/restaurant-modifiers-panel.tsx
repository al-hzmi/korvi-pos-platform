'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BidiIsolate, Button, CardSurface, Numeric } from '@korvi/ui';
import { Field } from '../field';
import { StatusNote } from '../status-note';
import { ApiError } from '../../lib/api';
import { formatMinor, parseSarToMinor } from '../../lib/money';
import type { JSX } from 'react';
import type { ApiClient } from '../../lib/api';
import type { ProductSummary, RestaurantModifierAdminGroup } from '../../lib/api-types';

function messageFor(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.serverMessage !== null) return error.serverMessage;
  return fallback;
}

function integerField(value: string, fallback: number): number | null {
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function RestaurantModifiersPanel({
  api,
  onCommandLockChange = () => undefined,
}: {
  readonly api: ApiClient;
  readonly onCommandLockChange?: (locked: boolean) => void;
}): JSX.Element {
  const [groups, setGroups] = useState<readonly RestaurantModifierAdminGroup[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [groupCode, setGroupCode] = useState('');
  const [groupName, setGroupName] = useState('');
  const [groupMin, setGroupMin] = useState('0');
  const [groupMax, setGroupMax] = useState('1');

  const [optionGroupId, setOptionGroupId] = useState('');
  const [optionCode, setOptionCode] = useState('');
  const [optionName, setOptionName] = useState('');
  const [optionDeltaSar, setOptionDeltaSar] = useState('0.00');

  const [productTerm, setProductTerm] = useState('');
  const [products, setProducts] = useState<readonly ProductSummary[]>([]);
  const [searchingProducts, setSearchingProducts] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<ProductSummary | null>(null);
  const [attachedGroupIds, setAttachedGroupIds] = useState<readonly string[]>([]);
  const [draftGroupIds, setDraftGroupIds] = useState<readonly string[]>([]);
  const [loadingAttachments, setLoadingAttachments] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setFailure(null);
    try {
      const rows = await api.restaurantModifierGroups();
      setGroups(rows);
      setOptionGroupId((current) =>
        current !== '' && rows.some((group) => group.id === current)
          ? current
          : (rows[0]?.id ?? ''),
      );
    } catch (error) {
      setFailure(messageFor(error, 'تعذر تحميل مجموعات إضافات المطعم.'));
      setGroups([]);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const withMutation = useCallback(
    async (work: () => Promise<void>): Promise<void> => {
      if (busy) return;
      setBusy(true);
      setFailure(null);
      setSuccess(null);
      onCommandLockChange(true);
      try {
        await work();
      } catch (error) {
        setFailure(messageFor(error, 'تعذر حفظ إعدادات إضافات المطعم.'));
      } finally {
        setBusy(false);
        onCommandLockChange(false);
      }
    },
    [busy, onCommandLockChange],
  );

  const createGroup = async (): Promise<void> => {
    const minSelections = integerField(groupMin, -1);
    const maxSelections = integerField(groupMax, -1);
    if (
      groupCode.trim() === '' ||
      groupName.trim() === '' ||
      minSelections === null ||
      maxSelections === null ||
      minSelections < 0 ||
      maxSelections < 1 ||
      minSelections > maxSelections ||
      maxSelections > 32
    ) {
      setFailure('أدخل تعريفًا صحيحًا للمجموعة وحدود اختيار منطقية.');
      return;
    }

    await withMutation(async () => {
      await api.createRestaurantModifierGroup({
        code: groupCode.trim(),
        nameAr: groupName.trim(),
        nameEn: null,
        minSelections,
        maxSelections,
        sortOrder: groups?.length ?? 0,
      });
      setGroupCode('');
      setGroupName('');
      setGroupMin('0');
      setGroupMax('1');
      setSuccess('تم إنشاء مجموعة الإضافات.');
      await load();
    });
  };

  const createOption = async (): Promise<void> => {
    const parsed = parseSarToMinor(optionDeltaSar);
    if (
      optionGroupId === '' ||
      optionCode.trim() === '' ||
      optionName.trim() === '' ||
      !parsed.ok
    ) {
      setFailure('اختر مجموعة وأدخل رمزًا واسمًا وزيادة سعر صحيحة.');
      return;
    }

    const group = groups?.find((candidate) => candidate.id === optionGroupId);
    await withMutation(async () => {
      await api.createRestaurantModifierOption(optionGroupId, {
        code: optionCode.trim(),
        nameAr: optionName.trim(),
        nameEn: null,
        priceDeltaMinor: parsed.value,
        sortOrder: group?.options.length ?? 0,
      });
      setOptionCode('');
      setOptionName('');
      setOptionDeltaSar('0.00');
      setSuccess('تمت إضافة خيار modifier إلى المجموعة.');
      await load();
    });
  };

  const toggleGroup = async (group: RestaurantModifierAdminGroup): Promise<void> => {
    await withMutation(async () => {
      await api.updateRestaurantModifierGroup(group.id, {
        expectedRevision: group.revision,
        isActive: !group.isActive,
      });
      setSuccess(group.isActive ? 'تم إيقاف المجموعة.' : 'تم تفعيل المجموعة.');
      await load();
    });
  };

  const toggleOption = async (
    group: RestaurantModifierAdminGroup,
    optionId: string,
  ): Promise<void> => {
    const option = group.options.find((candidate) => candidate.id === optionId);
    if (option === undefined) return;
    await withMutation(async () => {
      await api.updateRestaurantModifierOption(option.id, {
        expectedRevision: option.revision,
        isActive: !option.isActive,
      });
      setSuccess(option.isActive ? 'تم إيقاف الخيار.' : 'تم تفعيل الخيار.');
      await load();
    });
  };

  const searchProducts = async (): Promise<void> => {
    setSearchingProducts(true);
    setFailure(null);
    try {
      setProducts(await api.products({ q: productTerm.trim(), limit: 20 }));
    } catch (error) {
      setFailure(messageFor(error, 'تعذر البحث في المنتجات.'));
    } finally {
      setSearchingProducts(false);
    }
  };

  const chooseProduct = async (product: ProductSummary): Promise<void> => {
    setSelectedProduct(product);
    setLoadingAttachments(true);
    setFailure(null);
    try {
      const ids = await api.restaurantProductModifierGroups(product.id);
      setAttachedGroupIds(ids);
      setDraftGroupIds(ids);
    } catch (error) {
      setFailure(messageFor(error, 'تعذر قراءة مجموعات المنتج.'));
      setAttachedGroupIds([]);
      setDraftGroupIds([]);
    } finally {
      setLoadingAttachments(false);
    }
  };

  const saveAttachments = async (): Promise<void> => {
    if (selectedProduct === null) return;
    await withMutation(async () => {
      const ids = await api.setRestaurantProductModifierGroups(selectedProduct.id, {
        expectedGroupIds: attachedGroupIds,
        groupIds: draftGroupIds,
      });
      setAttachedGroupIds(ids);
      setDraftGroupIds(ids);
      setSuccess('تم حفظ ربط مجموعات الإضافات بالمنتج.');
    });
  };

  const activeGroups = useMemo(() => groups?.filter((group) => group.isActive) ?? [], [groups]);

  if (groups === null) {
    return (
      <CardSurface className="p-6">
        <p className="text-center text-sm text-muted-foreground" role="status">
          جارٍ تحميل مجموعات إضافات المطعم…
        </p>
      </CardSurface>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <CardSurface className="p-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold text-foreground">إدارة إضافات المطعم</h2>
          <p className="text-sm text-muted-foreground">
            عرّف مجموعات وخيارات قابلة لإعادة الاستخدام. الكاشير يختار الهوية فقط، والخادم يحسم
            الأهلية والسعر والمراجعة قبل إنشاء الطلب أو البيع.
          </p>
        </div>

        {failure === null ? null : (
          <div className="mt-4">
            <StatusNote tone="danger" live>
              {failure}
            </StatusNote>
          </div>
        )}
        {success === null ? null : (
          <div className="mt-4">
            <StatusNote tone="success" live>
              {success}
            </StatusNote>
          </div>
        )}

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Field
            id="modifier-group-code"
            label="رمز المجموعة"
            value={groupCode}
            disabled={busy}
            autoComplete="off"
            onChange={(event) => setGroupCode(event.currentTarget.value)}
          />
          <Field
            id="modifier-group-name"
            label="اسم المجموعة"
            value={groupName}
            disabled={busy}
            onChange={(event) => setGroupName(event.currentTarget.value)}
          />
          <Field
            id="modifier-group-min"
            label="الحد الأدنى للاختيار"
            type="number"
            min="0"
            max="32"
            value={groupMin}
            disabled={busy}
            onChange={(event) => setGroupMin(event.currentTarget.value)}
          />
          <Field
            id="modifier-group-max"
            label="الحد الأقصى للاختيار"
            type="number"
            min="1"
            max="32"
            value={groupMax}
            disabled={busy}
            onChange={(event) => setGroupMax(event.currentTarget.value)}
          />
        </div>
        <div className="mt-4 flex justify-end">
          <Button loading={busy} onClick={() => void createGroup()}>
            إنشاء المجموعة
          </Button>
        </div>
      </CardSurface>

      <CardSurface className="p-5">
        <h3 className="text-sm font-semibold text-foreground">إضافة خيار إلى مجموعة</h3>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
            المجموعة
            <select
              value={optionGroupId}
              disabled={busy || groups.length === 0}
              onChange={(event) => setOptionGroupId(event.currentTarget.value)}
              className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
            >
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.nameAr}
                </option>
              ))}
            </select>
          </label>
          <Field
            id="modifier-option-code"
            label="رمز الخيار"
            value={optionCode}
            disabled={busy}
            autoComplete="off"
            onChange={(event) => setOptionCode(event.currentTarget.value)}
          />
          <Field
            id="modifier-option-name"
            label="اسم الخيار"
            value={optionName}
            disabled={busy}
            onChange={(event) => setOptionName(event.currentTarget.value)}
          />
          <Field
            id="modifier-option-price"
            label="زيادة السعر (ر.س)"
            inputMode="decimal"
            value={optionDeltaSar}
            disabled={busy}
            onChange={(event) => setOptionDeltaSar(event.currentTarget.value)}
          />
        </div>
        <div className="mt-4 flex justify-end">
          <Button loading={busy} disabled={groups.length === 0} onClick={() => void createOption()}>
            إضافة الخيار
          </Button>
        </div>
      </CardSurface>

      <CardSurface className="p-5">
        <h3 className="text-sm font-semibold text-foreground">المجموعات الحالية</h3>
        {groups.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">لا توجد مجموعات إضافات بعد.</p>
        ) : (
          <div className="mt-4 grid gap-3 xl:grid-cols-2">
            {groups.map((group) => (
              <section key={group.id} className="rounded-lg border border-border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-foreground">{group.nameAr}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      <BidiIsolate>{group.code}</BidiIsolate>
                      {' · '}
                      {group.minSelections}–{group.maxSelections} اختيارات
                      {' · '}
                      مراجعة <BidiIsolate>{group.revision}</BidiIsolate>
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void toggleGroup(group)}
                  >
                    {group.isActive ? 'إيقاف المجموعة' : 'تفعيل المجموعة'}
                  </Button>
                </div>

                <div className="mt-3 flex flex-col gap-2">
                  {group.options.length === 0 ? (
                    <p className="text-xs text-muted-foreground">لا توجد خيارات في هذه المجموعة.</p>
                  ) : (
                    group.options.map((option) => (
                      <div
                        key={option.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/60 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">{option.nameAr}</p>
                          <p className="text-xs text-muted-foreground">
                            <BidiIsolate>{option.code}</BidiIsolate>
                            {' · +'}
                            <Numeric value={formatMinor(option.priceDeltaMinor)} />
                            {' ر.س'}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => void toggleOption(group, option.id)}
                        >
                          {option.isActive ? 'إيقاف الخيار' : 'تفعيل الخيار'}
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </section>
            ))}
          </div>
        )}
      </CardSurface>

      <CardSurface className="p-5">
        <h3 className="text-sm font-semibold text-foreground">ربط الإضافات بالمنتج</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          اختر المنتج ثم اربطه بالمجموعات النشطة. الحفظ يستخدم قائمة المجموعات الحالية كشرط
          optimistic concurrency.
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <div className="flex-1">
            <Field
              id="modifier-product-search"
              label="ابحث عن منتج"
              type="search"
              value={productTerm}
              disabled={busy}
              placeholder="اسم المنتج أو SKU"
              onChange={(event) => setProductTerm(event.currentTarget.value)}
            />
          </div>
          <div className="flex items-end">
            <Button
              variant="outline"
              loading={searchingProducts}
              disabled={busy}
              onClick={() => void searchProducts()}
            >
              بحث
            </Button>
          </div>
        </div>

        {products.length === 0 ? null : (
          <div className="mt-3 flex flex-wrap gap-2">
            {products.map((product) => (
              <Button
                key={product.id}
                variant={selectedProduct?.id === product.id ? 'primary' : 'outline'}
                size="sm"
                disabled={busy}
                onClick={() => void chooseProduct(product)}
              >
                {product.nameAr} · {product.sku}
              </Button>
            ))}
          </div>
        )}

        {selectedProduct === null ? null : (
          <div className="mt-4 rounded-lg border border-border p-4">
            <p className="font-medium text-foreground">{selectedProduct.nameAr}</p>
            <p className="text-xs text-muted-foreground">
              <BidiIsolate>{selectedProduct.sku}</BidiIsolate>
            </p>

            {loadingAttachments ? (
              <p className="mt-3 text-sm text-muted-foreground" role="status">
                جارٍ تحميل ربط المجموعات…
              </p>
            ) : (
              <>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {activeGroups.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      فعّل مجموعة واحدة على الأقل قبل ربط المنتج.
                    </p>
                  ) : (
                    activeGroups.map((group) => {
                      const checked = draftGroupIds.includes(group.id);
                      return (
                        <label
                          key={group.id}
                          className="flex min-h-touch items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={busy}
                            onChange={(event) => {
                              // React releases currentTarget after the handler; capture the
                              // checked intent before passing a callback to the state queue.
                              const checked = event.currentTarget.checked;
                              setDraftGroupIds((current) =>
                                checked
                                  ? [...current, group.id]
                                  : current.filter((id) => id !== group.id),
                              );
                            }}
                          />
                          <span>{group.nameAr}</span>
                        </label>
                      );
                    })
                  )}
                </div>
                <div className="mt-4 flex justify-end">
                  <Button
                    loading={busy}
                    disabled={loadingAttachments}
                    onClick={() => void saveAttachments()}
                  >
                    حفظ ربط المجموعات
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </CardSurface>
    </div>
  );
}
