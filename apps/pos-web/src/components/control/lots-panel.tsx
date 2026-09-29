'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { Field } from '../field';
import { StatusNote } from '../status-note';
import { ApiError } from '../../lib/api';
import type { JSX } from 'react';
import type { ApiClient } from '../../lib/api';
import type {
  AdminInventoryLot,
  AdminProductLotConfig,
  InventoryBalanceRow,
  InventoryBranch,
  ProductSummary,
} from '../../lib/api-types';

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.serverMessage !== null) return error.serverMessage;
  return fallback;
}

function provenanceLabel(value: AdminInventoryLot['provenance']): string {
  switch (value) {
    case 'received':
      return 'مستلمة';
    case 'produced':
      return 'منتجة';
    case 'historical-unknown':
      return 'رصيد تاريخي غير معروف';
    case 'manual-correction':
      return 'تصحيح يدوي';
  }
}

function statusLabel(value: AdminInventoryLot['status']): string {
  if (value === 'active') return 'نشطة';
  if (value === 'blocked') return 'محظورة';
  return 'مغلقة';
}

function dateStateLabel(value: AdminInventoryLot['dateState']): string {
  switch (value) {
    case 'unknown':
      return 'تاريخ غير معروف';
    case 'eligible':
      return 'ضمن التاريخ';
    case 'expired':
      return 'منتهية';
    case 'past-best-before':
      return 'تجاوزت الأفضل قبل';
  }
}

function quantityForBranch(lot: AdminInventoryLot, branchId: string): bigint {
  const row = lot.availabilityByBranch.find((entry) => entry.branchId === branchId);
  return BigInt(row?.quantityScaled ?? '0');
}

export function LotsPanel({
  api,
  preferredBranchId,
  onCommandLockChange,
}: {
  readonly api: ApiClient;
  readonly preferredBranchId: string | null;
  readonly onCommandLockChange?: (locked: boolean) => void;
}): JSX.Element {
  const [productTerm, setProductTerm] = useState('');
  const [products, setProducts] = useState<readonly ProductSummary[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<ProductSummary | null>(null);
  const [config, setConfig] = useState<AdminProductLotConfig | null>(null);
  const [branches, setBranches] = useState<readonly InventoryBranch[]>([]);
  const [branchId, setBranchId] = useState(preferredBranchId ?? '');
  const [balance, setBalance] = useState<InventoryBalanceRow | null>(null);
  const [selectionPolicy, setSelectionPolicy] = useState<'fefo' | 'fifo'>('fefo');
  const [dateRequirement, setDateRequirement] = useState<'optional' | 'required'>('optional');
  const [sourceLotId, setSourceLotId] = useState('');
  const [targetLotId, setTargetLotId] = useState('');
  const [reclassQuantity, setReclassQuantity] = useState('');
  const [reclassReason, setReclassReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [unresolved, setUnresolved] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const branchNames = useMemo(
    () => new Map(branches.map((branch) => [branch.id, branch.nameAr] as const)),
    [branches],
  );

  const activeLots = useMemo(
    () => config?.lots.filter((lot) => lot.status === 'active') ?? [],
    [config],
  );

  const loadBranches = useCallback(async (): Promise<void> => {
    const rows: InventoryBranch[] = [];
    let cursor: string | undefined;
    do {
      const page = await api.inventoryBranches({
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      rows.push(...page.rows);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined && rows.length < 1000);
    setBranches(rows);
    if (branchId === '') {
      const preferred =
        preferredBranchId === null ? null : rows.find((row) => row.id === preferredBranchId);
      setBranchId(preferred?.id ?? rows[0]?.id ?? '');
    }
  }, [api, branchId, preferredBranchId]);

  useEffect(() => {
    void loadBranches().catch((error: unknown) => {
      setFailure(messageOf(error, 'تعذر تحميل الفروع.'));
    });
  }, [loadBranches]);

  const loadBalance = useCallback(
    async (productId: string, selectedBranchId: string): Promise<InventoryBalanceRow | null> => {
      if (selectedBranchId === '') return null;
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 25; pageNumber += 1) {
        const page = await api.inventoryBalances({
          branchId: selectedBranchId,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        const found = page.rows.find((row) => row.productId === productId);
        if (found !== undefined) return found;
        if (page.nextCursor === null) return null;
        cursor = page.nextCursor;
      }
      throw new Error('inventory balance pagination exceeded the guarded search window');
    },
    [api],
  );

  const loadConfig = useCallback(
    async (product: ProductSummary, selectedBranchId = branchId): Promise<void> => {
      const [nextConfig, nextBalance] = await Promise.all([
        api.adminLotConfig(product.id),
        loadBalance(product.id, selectedBranchId),
      ]);
      setConfig(nextConfig);
      setSelectionPolicy(nextConfig.selectionPolicy);
      setDateRequirement(nextConfig.dateRequirement);
      setBalance(nextBalance);
      setSourceLotId('');
      setTargetLotId('');
      setReclassQuantity('');
      setReclassReason('');
    },
    [api, branchId, loadBalance],
  );

  const search = async (): Promise<void> => {
    const q = productTerm.trim();
    if (q === '') {
      setProducts([]);
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      setProducts(await api.products({ q, limit: 30 }));
    } catch (error) {
      setFailure(messageOf(error, 'تعذر البحث في الأصناف.'));
    } finally {
      setBusy(false);
    }
  };

  const selectProduct = async (product: ProductSummary): Promise<void> => {
    setSelectedProduct(product);
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      await loadConfig(product);
    } catch (error) {
      setConfig(null);
      setFailure(messageOf(error, 'تعذر تحميل سياسة الدفعات لهذا الصنف.'));
    } finally {
      setBusy(false);
    }
  };

  const runCommand = useCallback(
    async (work: () => Promise<AdminProductLotConfig>, success: string): Promise<void> => {
      if (busy || unresolved) return;
      setBusy(true);
      setFailure(null);
      setNotice(null);
      onCommandLockChange?.(true);
      let safeToUnlock = false;
      try {
        const next = await work();
        setConfig(next);
        setSelectionPolicy(next.selectionPolicy);
        setDateRequirement(next.dateRequirement);
        if (selectedProduct !== null) {
          setBalance(await loadBalance(selectedProduct.id, branchId));
        }
        setNotice(success);
        safeToUnlock = true;
      } catch (error) {
        setFailure(
          messageOf(error, 'تعذر حسم نتيجة العملية. ستتم إعادة قراءة حقائق الدفعات من الخادم.'),
        );
        if (selectedProduct !== null) {
          try {
            await loadConfig(selectedProduct);
            safeToUnlock = true;
          } catch {
            setUnresolved(true);
            setFailure(
              'تعذر حسم العملية وتعذر إعادة قراءة الدفعات. تم قفل القسم حتى تنجح المصالحة مع الخادم.',
            );
          }
        }
      } finally {
        setBusy(false);
        if (safeToUnlock) onCommandLockChange?.(false);
      }
    },
    [branchId, busy, loadBalance, loadConfig, onCommandLockChange, selectedProduct, unresolved],
  );

  const reconcile = async (): Promise<void> => {
    if (selectedProduct === null || busy) return;
    setBusy(true);
    setFailure(null);
    onCommandLockChange?.(true);
    try {
      await loadConfig(selectedProduct);
      setUnresolved(false);
      setNotice('تمت إعادة قراءة سياسة الدفعات والأرصدة من الخادم.');
      onCommandLockChange?.(false);
    } catch (error) {
      setUnresolved(true);
      setFailure(messageOf(error, 'ما زال تعذر حسم حالة الدفعات. يبقى القسم مقفلًا.'));
    } finally {
      setBusy(false);
    }
  };

  const enable = async (): Promise<void> => {
    if (selectedProduct === null) return;
    await runCommand(
      () =>
        api.enableAdminLotTracking(selectedProduct.id, {
          selectionPolicy,
          dateRequirement,
        }),
      'تم تفعيل تتبع الدفعات. أي رصيد سابق حُفظ كدفعة تاريخية مجهولة المصدر بدل اختلاق أصل له.',
    );
  };

  const savePolicy = async (): Promise<void> => {
    if (selectedProduct === null || config === null) return;
    await runCommand(
      () =>
        api.updateAdminLotPolicy(selectedProduct.id, {
          expectedRevision: config.revision,
          selectionPolicy,
          dateRequirement,
        }),
      'تم تحديث سياسة اختيار الدفعات.',
    );
  };

  const changeLotStatus = async (
    lot: AdminInventoryLot,
    status: AdminInventoryLot['status'],
  ): Promise<void> => {
    await runCommand(
      () =>
        api.updateAdminLotStatus(lot.id, {
          expectedRevision: lot.revision,
          status,
        }),
      status === 'active'
        ? 'تمت إعادة الدفعة إلى الحالة النشطة.'
        : status === 'blocked'
          ? 'تم حظر الدفعة من الاستهلاك.'
          : 'تم إغلاق الدفعة بعد التحقق من أن رصيدها صفر.',
    );
  };

  const reclassify = async (): Promise<void> => {
    if (
      selectedProduct === null ||
      config === null ||
      balance === null ||
      branchId === '' ||
      sourceLotId === '' ||
      targetLotId === '' ||
      sourceLotId === targetLotId
    ) {
      setFailure('اختر فرعًا ودفعتين مختلفتين قبل إعادة التصنيف.');
      return;
    }
    let quantity: bigint;
    try {
      quantity = BigInt(reclassQuantity);
    } catch {
      setFailure('اكتب كمية صحيحة بمقياس المخزون.');
      return;
    }
    if (quantity <= 0n) {
      setFailure('كمية إعادة التصنيف يجب أن تكون أكبر من صفر.');
      return;
    }
    const source = config.lots.find((lot) => lot.id === sourceLotId);
    if (source === undefined || quantityForBranch(source, branchId) < quantity) {
      setFailure('الدفعة المصدر لا تملك الكمية المطلوبة في هذا الفرع.');
      return;
    }
    if (reclassReason.trim() === '') {
      setFailure('اكتب سبب إعادة التصنيف.');
      return;
    }
    await runCommand(
      () =>
        api.reclassifyAdminLots({
          operationId: crypto.randomUUID(),
          productId: selectedProduct.id,
          branchId,
          expectedBalanceRevision: balance.revision,
          reason: reclassReason.trim(),
          lines: [
            { lotId: sourceLotId, quantityScaled: (-quantity).toString() },
            { lotId: targetLotId, quantityScaled: quantity.toString() },
          ],
        }),
      'تمت إعادة توزيع الهوية بين الدفعات دون تغيير إجمالي رصيد الصنف.',
    );
    setReclassQuantity('');
    setReclassReason('');
  };

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
      {unresolved ? (
        <CardSurface className="flex flex-col gap-3 border-destructive/30 p-4">
          <StatusNote tone="danger" live>
            توجد نتيجة غير محسومة. لا تغيّر سياسة أو دفعة حتى تنجح إعادة القراءة.
          </StatusNote>
          <div>
            <Button variant="outline" disabled={busy} onClick={() => void reconcile()}>
              إعادة القراءة وحسم الحالة
            </Button>
          </div>
        </CardSurface>
      ) : null}

      <CardSurface className="p-5">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-foreground">
            إدارة الدفعات وتواريخ الصلاحية
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            الرصيد الإجمالي يبقى من سجل المخزون الأساسي. هذه الشاشة تدير هوية الدفعات فقط، ولا تنشئ
            رصيدًا موازيًا أو تكلفة جديدة.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Field
            id="lot-product-search"
            label="بحث الصنف"
            value={productTerm}
            className="min-w-0 flex-1"
            placeholder="الاسم أو SKU أو الباركود"
            onChange={(event) => setProductTerm(event.currentTarget.value)}
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
            disabled={busy}
            onClick={() => void search()}
          >
            بحث
          </Button>
        </div>
        {products.length === 0 ? null : (
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {products.map((product) => (
              <button
                key={product.id}
                type="button"
                disabled={busy || unresolved || !product.trackInventory}
                className="rounded-lg border border-border bg-background p-3 text-start transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void selectProduct(product)}
              >
                <span className="block text-sm font-medium text-foreground">{product.nameAr}</span>
                <span className="mt-1 block font-mono text-xs text-muted-foreground">
                  {product.sku}
                </span>
                {!product.trackInventory ? (
                  <span className="mt-1 block text-xs text-destructive">لا يتتبع المخزون</span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </CardSurface>

      {selectedProduct === null || config === null ? null : (
        <>
          <CardSurface className="p-5">
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-foreground">{config.nameAr}</h2>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{config.sku}</p>
              </div>
              <span className="rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                {config.trackingMode === 'required' ? 'تتبع الدفعات مفعل' : 'غير مفعل'}
              </span>
            </div>
            <fieldset disabled={busy || unresolved} className="grid gap-4 md:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
                سياسة الاختيار عند الصرف
                <select
                  className="h-touch rounded-md border border-input bg-background px-3"
                  value={selectionPolicy}
                  onChange={(event) =>
                    setSelectionPolicy(event.currentTarget.value as 'fefo' | 'fifo')
                  }
                >
                  <option value="fefo">FEFO — الأقرب انتهاءً أولًا</option>
                  <option value="fifo">FIFO — الأقدم دخولًا أولًا</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
                تاريخ الدفعة
                <select
                  className="h-touch rounded-md border border-input bg-background px-3"
                  value={dateRequirement}
                  onChange={(event) =>
                    setDateRequirement(event.currentTarget.value as 'optional' | 'required')
                  }
                >
                  <option value="optional">اختياري</option>
                  <option value="required">إلزامي</option>
                </select>
              </label>
            </fieldset>
            <div className="mt-4 flex justify-end">
              {config.trackingMode === 'none' ? (
                <Button disabled={busy || unresolved} onClick={() => void enable()}>
                  تفعيل تتبع الدفعات
                </Button>
              ) : (
                <Button disabled={busy || unresolved} onClick={() => void savePolicy()}>
                  حفظ السياسة
                </Button>
              )}
            </div>
            {config.trackingMode === 'none' ? (
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                عند التفعيل، أي رصيد موجود مسبقًا سيُحفظ كـ «رصيد تاريخي غير معروف» لكل فرع. لن ينسب
                كورفي هذا الرصيد إلى فاتورة أو دفعة لم يثبتها.
              </p>
            ) : null}
          </CardSurface>

          {config.trackingMode === 'required' ? (
            <CardSurface className="p-5">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-foreground">حقائق الصلاحية</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    قراءة مشتقة من الدفعات الحالية فقط؛ لا تغيّر المخزون ولا تنفذ قرارًا تلقائيًا.
                  </p>
                </div>
                <span className="rounded-md bg-muted px-2.5 py-1 font-mono text-xs text-muted-foreground">
                  {config.expiryIntelligence.businessDate}
                </span>
              </div>
              <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-lg border border-border bg-background p-3">
                  <dt className="text-xs text-muted-foreground">الرصيد المؤهل للصرف</dt>
                  <dd className="mt-1 font-mono text-lg font-semibold text-foreground">
                    {config.expiryIntelligence.eligibleQuantityScaled}
                  </dd>
                </div>
                <div className="rounded-lg border border-border bg-background p-3">
                  <dt className="text-xs text-muted-foreground">كمية منتهية</dt>
                  <dd className="mt-1 font-mono text-lg font-semibold text-foreground">
                    {config.expiryIntelligence.expiredQuantityScaled}
                  </dd>
                </div>
                <div className="rounded-lg border border-border bg-background p-3">
                  <dt className="text-xs text-muted-foreground">تاريخ غير معروف</dt>
                  <dd className="mt-1 font-mono text-lg font-semibold text-foreground">
                    {config.expiryIntelligence.unknownDateQuantityScaled}
                  </dd>
                </div>
                <div className="rounded-lg border border-border bg-background p-3">
                  <dt className="text-xs text-muted-foreground">أقرب انتهاء مؤهل</dt>
                  <dd className="mt-1 font-mono text-sm font-semibold text-foreground">
                    {config.expiryIntelligence.soonestEligibleExpiryDate ?? '—'}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                تجاوز «الأفضل قبل»:{' '}
                <span className="font-mono">
                  {config.expiryIntelligence.pastBestBeforeQuantityScaled}
                </span>
                {' · '}محظور/مغلق:{' '}
                <span className="font-mono">
                  {config.expiryIntelligence.blockedOrClosedQuantityScaled}
                </span>
                {' · '}إجمالي موزع على الدفعات:{' '}
                <span className="font-mono">
                  {config.expiryIntelligence.totalAvailableQuantityScaled}
                </span>
              </p>
            </CardSurface>
          ) : null}

          {config.trackingMode === 'required' ? (
            <CardSurface className="p-5">
              <div className="mb-4">
                <h2 className="text-base font-semibold text-foreground">سجل الدفعات</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  الحالة والهوية والتاريخ حقائق مستقلة عن رصيد الصنف الإجمالي.
                </p>
              </div>
              {config.lots.length === 0 ? (
                <p className="text-sm text-muted-foreground">لا توجد دفعات مسجلة بعد.</p>
              ) : (
                <div className="grid gap-3">
                  {config.lots.map((lot) => (
                    <div key={lot.id} className="rounded-lg border border-border bg-background p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-sm font-semibold text-foreground">
                              {lot.internalCode}
                            </span>
                            <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                              {statusLabel(lot.status)}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {provenanceLabel(lot.provenance)}
                            {lot.externalBatchReference === null
                              ? ''
                              : ` · Batch: ${lot.externalBatchReference}`}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {lot.dateKind === null || lot.dateValue === null
                              ? 'لا يوجد تاريخ مثبت'
                              : `${lot.dateKind === 'expiry' ? 'انتهاء' : 'أفضل قبل'}: ${lot.dateValue}`}
                            {' · '}
                            {dateStateLabel(lot.dateState)}
                            {lot.daysUntilDate === null
                              ? ''
                              : ` · ${lot.daysUntilDate >= 0 ? 'متبقي' : 'متجاوز'} ${Math.abs(lot.daysUntilDate)} يوم`}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            المتاح:{' '}
                            <span className="font-mono">{lot.totalAvailableQuantityScaled}</span>
                            {' · '}المؤهل للصرف:{' '}
                            <span className="font-mono">
                              {lot.eligibleForConsumptionQuantityScaled}
                            </span>
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {lot.status === 'active' ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy || unresolved}
                              onClick={() => void changeLotStatus(lot, 'blocked')}
                            >
                              حظر
                            </Button>
                          ) : lot.status === 'blocked' ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy || unresolved}
                              onClick={() => void changeLotStatus(lot, 'active')}
                            >
                              إعادة التفعيل
                            </Button>
                          ) : null}
                          {lot.status !== 'closed' ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy || unresolved}
                              onClick={() => void changeLotStatus(lot, 'closed')}
                            >
                              إغلاق
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {lot.availabilityByBranch.length === 0 ? (
                          <span className="text-xs text-muted-foreground">الرصيد: 0</span>
                        ) : (
                          lot.availabilityByBranch.map((row) => (
                            <span
                              key={row.branchId}
                              className="rounded-md border border-border bg-muted/30 px-2 py-1 text-xs text-muted-foreground"
                            >
                              {branchNames.get(row.branchId) ?? row.branchId.slice(0, 8)}:{' '}
                              <span className="font-mono">{row.quantityScaled}</span>
                            </span>
                          ))
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardSurface>
          ) : null}

          {config.trackingMode === 'required' && activeLots.length >= 2 ? (
            <CardSurface className="p-5">
              <div className="mb-4">
                <h2 className="text-base font-semibold text-foreground">تصحيح هوية الدفعة</h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  ينقل كمية بين هويتين داخل الفرع نفسه فقط. مجموع الصنف لا يتغير ولا تُنشأ حركة
                  مخزون جديدة.
                </p>
              </div>
              <fieldset disabled={busy || unresolved} className="grid gap-4 md:grid-cols-2">
                <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
                  الفرع
                  <select
                    className="h-touch rounded-md border border-input bg-background px-3"
                    value={branchId}
                    onChange={(event) => {
                      const next = event.currentTarget.value;
                      setBranchId(next);
                      if (selectedProduct !== null) {
                        void loadBalance(selectedProduct.id, next)
                          .then(setBalance)
                          .catch(() => setBalance(null));
                      }
                    }}
                  >
                    <option value="">اختر الفرع</option>
                    {branches
                      .filter((branch) => branch.isActive)
                      .map((branch) => (
                        <option key={branch.id} value={branch.id}>
                          {branch.nameAr}
                        </option>
                      ))}
                  </select>
                </label>
                <Field
                  id="lot-reclass-quantity"
                  label="الكمية بمقياس المخزون"
                  inputMode="numeric"
                  value={reclassQuantity}
                  onChange={(event) => setReclassQuantity(event.currentTarget.value)}
                />
                <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
                  من الدفعة
                  <select
                    className="h-touch rounded-md border border-input bg-background px-3"
                    value={sourceLotId}
                    onChange={(event) => setSourceLotId(event.currentTarget.value)}
                  >
                    <option value="">اختر المصدر</option>
                    {activeLots.map((lot) => (
                      <option key={lot.id} value={lot.id}>
                        {lot.internalCode} — {quantityForBranch(lot, branchId).toString()}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
                  إلى الدفعة
                  <select
                    className="h-touch rounded-md border border-input bg-background px-3"
                    value={targetLotId}
                    onChange={(event) => setTargetLotId(event.currentTarget.value)}
                  >
                    <option value="">اختر الهدف</option>
                    {activeLots.map((lot) => (
                      <option key={lot.id} value={lot.id}>
                        {lot.internalCode}
                      </option>
                    ))}
                  </select>
                </label>
                <Field
                  id="lot-reclass-reason"
                  label="سبب التصحيح"
                  value={reclassReason}
                  maxLength={200}
                  className="md:col-span-2"
                  onChange={(event) => setReclassReason(event.currentTarget.value)}
                />
              </fieldset>
              <div className="mt-4 flex justify-end">
                <Button
                  disabled={busy || unresolved || balance === null}
                  onClick={() => void reclassify()}
                >
                  اعتماد إعادة التصنيف
                </Button>
              </div>
            </CardSurface>
          ) : null}
        </>
      )}
    </div>
  );
}
