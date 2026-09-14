'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { newId } from '@korvi/domain';
import { Button, CardSurface, Numeric } from '@korvi/ui';
import { StatusNote } from '../status-note';
import { formatTimestamp } from '../../lib/datetime';
import { describeFailure } from '../../lib/failures';
import { formatMinor } from '../../lib/money';
import { createCustomersApi } from '../../lib/customers-api';
import type { FormEvent, JSX } from 'react';
import type {
  CustomerDetail,
  CustomerPage,
  CustomerSummary,
  CustomersApi,
} from '../../lib/customers-api';
import type { Failure } from '../../lib/failures';

type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly page: CustomerPage }
  | { readonly kind: 'failed'; readonly failure: Failure };

type DetailState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'loading'; readonly customerId: string }
  | { readonly kind: 'ready'; readonly detail: CustomerDetail }
  | { readonly kind: 'failed'; readonly customerId: string; readonly failure: Failure };

type CommandState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly operationId: string }
  | {
      readonly kind: 'failed';
      readonly operationId: string | null;
      readonly failure: Failure;
      readonly ambiguous: boolean;
    }
  | { readonly kind: 'succeeded'; readonly replayed: boolean };

interface CustomerDraft {
  readonly nameAr: string;
  readonly nameEn: string;
  readonly phone: string;
  readonly email: string;
  readonly vatNumber: string;
}

const EMPTY_DRAFT: CustomerDraft = {
  nameAr: '',
  nameEn: '',
  phone: '',
  email: '',
  vatNumber: '',
};

function nullable(value: string): string | null {
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function ambiguousFailure(failure: Failure): boolean {
  return failure.action === 'retry-same' || failure.code === 'operation_in_progress';
}

function InputField({
  label,
  value,
  onChange,
  dir,
  inputMode,
  disabled = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly dir?: 'ltr' | 'rtl';
  readonly inputMode?: 'text' | 'email' | 'tel' | 'numeric';
  readonly disabled?: boolean;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-foreground">{label}</span>
      <input
        className="h-touch rounded-md border border-input bg-background px-3 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        value={value}
        dir={dir}
        inputMode={inputMode}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function CustomerList({
  state,
  selectedId,
  loadingMore,
  onSelect,
  onRetry,
  onLoadMore,
}: {
  readonly state: ListState;
  readonly selectedId: string | null;
  readonly loadingMore: boolean;
  readonly onSelect: (customerId: string) => void;
  readonly onRetry: () => void;
  readonly onLoadMore: () => void;
}): JSX.Element {
  if (state.kind === 'loading') {
    return (
      <CardSurface className="p-8 text-center text-sm text-muted-foreground" role="status">
        جارٍ تحميل العملاء…
      </CardSurface>
    );
  }

  if (state.kind === 'failed') {
    return (
      <CardSurface className="flex flex-col gap-3 p-4">
        <StatusNote tone="danger" live>
          {state.failure.message}
        </StatusNote>
        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={onRetry}>
            إعادة المحاولة
          </Button>
        </div>
      </CardSurface>
    );
  }

  return (
    <CardSurface className="overflow-hidden">
      {state.page.items.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted-foreground">لا يوجد عملاء مطابقون.</p>
      ) : (
        <div className="divide-y divide-border">
          {state.page.items.map((customer) => (
            <button
              key={customer.id}
              type="button"
              onClick={() => onSelect(customer.id)}
              className={`flex w-full items-center justify-between gap-4 px-4 py-3 text-start transition-colors hover:bg-accent ${
                selectedId === customer.id ? 'bg-accent' : ''
              }`}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium text-foreground">{customer.nameAr}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground" dir="ltr">
                  {customer.phone ?? customer.email ?? 'بدون بيانات اتصال'}
                </span>
              </span>
              <span
                className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-medium ${
                  customer.isActive
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {customer.isActive ? 'نشط' : 'غير نشط'}
              </span>
            </button>
          ))}
        </div>
      )}
      {state.page.nextCursor === null ? null : (
        <div className="border-t border-border p-3 text-center">
          <Button type="button" variant="outline" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? 'جارٍ التحميل…' : 'تحميل المزيد'}
          </Button>
        </div>
      )}
    </CardSurface>
  );
}

function CustomerDetailCard({
  state,
  canWrite,
  command,
  onRetry,
  onUpdate,
}: {
  readonly state: DetailState;
  readonly canWrite: boolean;
  readonly command: CommandState;
  readonly onRetry: (customerId: string) => void;
  readonly onUpdate: (
    customer: CustomerSummary,
    draft: CustomerDraft,
    nextActive: boolean,
    operationId?: string,
  ) => Promise<void>;
}): JSX.Element {
  const [draft, setDraft] = useState<CustomerDraft>(EMPTY_DRAFT);
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (state.kind !== 'ready') return;
    const customer = state.detail.customer;
    setDraft({
      nameAr: customer.nameAr,
      nameEn: customer.nameEn ?? '',
      phone: customer.phone ?? '',
      email: customer.email ?? '',
      vatNumber: customer.vatNumber ?? '',
    });
    setActive(customer.isActive);
  }, [state]);

  if (state.kind === 'closed') {
    return (
      <CardSurface className="p-8 text-center text-sm text-muted-foreground">
        اختر عميلاً لعرض ملفه وعلاقته بالمبيعات.
      </CardSurface>
    );
  }

  if (state.kind === 'loading') {
    return (
      <CardSurface className="p-8 text-center text-sm text-muted-foreground" role="status">
        جارٍ تحميل ملف العميل…
      </CardSurface>
    );
  }

  if (state.kind === 'failed') {
    return (
      <CardSurface className="flex flex-col gap-3 p-4">
        <StatusNote tone="danger" live>
          {state.failure.message}
        </StatusNote>
        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={() => onRetry(state.customerId)}>
            إعادة المحاولة
          </Button>
        </div>
      </CardSurface>
    );
  }

  const customer = state.detail.customer;
  const busy = command.kind === 'running';
  const retryOperationId =
    command.kind === 'failed' && command.ambiguous ? command.operationId ?? undefined : undefined;

  return (
    <CardSurface className="flex flex-col gap-5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-card-foreground">{customer.nameAr}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            آخر تحديث {formatTimestamp(customer.updatedAt)} · {state.detail.salesCount} عملية بيع
          </p>
        </div>
        <span className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
          {customer.isActive ? 'نشط' : 'غير نشط'}
        </span>
      </div>

      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void onUpdate(customer, draft, active, retryOperationId);
        }}
      >
        <InputField
          label="الاسم العربي"
          value={draft.nameAr}
          disabled={!canWrite || busy}
          onChange={(value) => setDraft((current) => ({ ...current, nameAr: value }))}
        />
        <InputField
          label="الاسم الإنجليزي"
          value={draft.nameEn}
          dir="ltr"
          disabled={!canWrite || busy}
          onChange={(value) => setDraft((current) => ({ ...current, nameEn: value }))}
        />
        <InputField
          label="الجوال"
          value={draft.phone}
          dir="ltr"
          inputMode="tel"
          disabled={!canWrite || busy}
          onChange={(value) => setDraft((current) => ({ ...current, phone: value }))}
        />
        <InputField
          label="البريد الإلكتروني"
          value={draft.email}
          dir="ltr"
          inputMode="email"
          disabled={!canWrite || busy}
          onChange={(value) => setDraft((current) => ({ ...current, email: value }))}
        />
        <InputField
          label="الرقم الضريبي"
          value={draft.vatNumber}
          dir="ltr"
          inputMode="numeric"
          disabled={!canWrite || busy}
          onChange={(value) => setDraft((current) => ({ ...current, vatNumber: value }))}
        />
        <label className="flex items-center gap-2 self-end pb-3 text-sm">
          <input
            type="checkbox"
            checked={active}
            disabled={!canWrite || busy}
            onChange={(event) => setActive(event.target.checked)}
          />
          العميل نشط
        </label>

        {canWrite ? (
          <div className="flex flex-wrap items-center justify-end gap-2 sm:col-span-2">
            <Button type="submit" disabled={busy || draft.nameAr.trim() === ''}>
              {busy ? 'جارٍ الحفظ…' : retryOperationId === undefined ? 'حفظ التعديلات' : 'تأكيد النتيجة'}
            </Button>
          </div>
        ) : null}
      </form>

      {command.kind === 'failed' ? (
        <StatusNote tone={command.ambiguous ? 'warning' : 'danger'} live>
          {command.failure.message}
        </StatusNote>
      ) : command.kind === 'succeeded' ? (
        <StatusNote tone="success" live>
          {command.replayed ? 'تم تأكيد النتيجة السابقة بأمان.' : 'تم حفظ العميل.'}
        </StatusNote>
      ) : null}

      <section>
        <h3 className="mb-2 font-semibold">آخر المبيعات</h3>
        {state.detail.recentSales.length === 0 ? (
          <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">
            لا توجد مبيعات مرتبطة بهذا العميل حتى الآن.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[580px] text-sm">
              <thead className="bg-muted/60 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-start font-medium">الفاتورة</th>
                  <th className="px-3 py-2 text-start font-medium">التاريخ</th>
                  <th className="px-3 py-2 text-start font-medium">الحالة</th>
                  <th className="px-3 py-2 text-end font-medium">الإجمالي</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {state.detail.recentSales.map((sale) => (
                  <tr key={sale.id}>
                    <td className="px-3 py-3 font-mono text-xs" dir="ltr">
                      {sale.invoiceNumber}
                    </td>
                    <td className="px-3 py-3">{formatTimestamp(sale.issuedAt)}</td>
                    <td className="px-3 py-3">{sale.status}</td>
                    <td className="px-3 py-3 text-end">
                      <span className="inline-flex items-baseline gap-1" dir="ltr">
                        <Numeric value={formatMinor(sale.totalMinor)} />
                        <span className="text-[11px] text-muted-foreground">{sale.currency}</span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </CardSurface>
  );
}

export function CustomersPanel({
  api: injected,
  canWrite,
  onCommandLockChange,
}: {
  readonly api?: CustomersApi;
  readonly canWrite: boolean;
  readonly onCommandLockChange: (locked: boolean) => void;
}): JSX.Element {
  const api = useMemo(() => injected ?? createCustomersApi(), [injected]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [applied, setApplied] = useState<{ search?: string; status?: 'active' | 'inactive' }>({});
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ kind: 'closed' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [createDraft, setCreateDraft] = useState<CustomerDraft>(EMPTY_DRAFT);
  const [createCommand, setCreateCommand] = useState<CommandState>({ kind: 'idle' });
  const [updateCommand, setUpdateCommand] = useState<CommandState>({ kind: 'idle' });

  const locked =
    createCommand.kind === 'running' ||
    updateCommand.kind === 'running' ||
    (createCommand.kind === 'failed' && createCommand.ambiguous) ||
    (updateCommand.kind === 'failed' && updateCommand.ambiguous);

  useEffect(() => onCommandLockChange(locked), [locked, onCommandLockChange]);
  useEffect(() => () => onCommandLockChange(false), [onCommandLockChange]);

  const loadList = useCallback(
    async (signal?: AbortSignal) => {
      const page = await api.list(
        {
          limit: 50,
          ...(applied.search === undefined ? {} : { search: applied.search }),
          ...(applied.status === undefined ? {} : { status: applied.status }),
        },
        signal === undefined ? undefined : { signal },
      );
      setList({ kind: 'ready', page });
    },
    [api, applied],
  );

  useEffect(() => {
    const controller = new AbortController();
    setList({ kind: 'loading' });
    void loadList(controller.signal).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setList({ kind: 'failed', failure: describeFailure(error) });
    });
    return () => controller.abort();
  }, [loadList]);

  const loadDetail = useCallback(
    async (customerId: string, signal?: AbortSignal) => {
      setSelectedId(customerId);
      setDetail({ kind: 'loading', customerId });
      try {
        const value = await api.detail(
          customerId,
          signal === undefined ? undefined : { signal },
        );
        setDetail({ kind: 'ready', detail: value });
        setUpdateCommand({ kind: 'idle' });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setDetail({ kind: 'failed', customerId, failure: describeFailure(error) });
      }
    },
    [api],
  );

  const refreshAfterWrite = useCallback(
    async (customerId: string) => {
      await Promise.all([loadList(), loadDetail(customerId)]);
    },
    [loadDetail, loadList],
  );

  const submitCreate = useCallback(
    async (event?: FormEvent, retryOperationId?: string) => {
      event?.preventDefault();
      if (!canWrite || createDraft.nameAr.trim() === '') return;
      const operationId = retryOperationId ?? newId();
      setCreateCommand({ kind: 'running', operationId });
      try {
        const result = await api.create({
          operationId,
          nameAr: createDraft.nameAr.trim(),
          nameEn: nullable(createDraft.nameEn),
          phone: nullable(createDraft.phone),
          email: nullable(createDraft.email),
          vatNumber: nullable(createDraft.vatNumber),
        });
        setCreateCommand({ kind: 'succeeded', replayed: result.replayed });
        setCreateDraft(EMPTY_DRAFT);
        await refreshAfterWrite(result.customer.id);
      } catch (error) {
        const failure = describeFailure(error);
        const ambiguous = ambiguousFailure(failure);
        setCreateCommand({
          kind: 'failed',
          operationId: ambiguous ? operationId : null,
          failure,
          ambiguous,
        });
      }
    },
    [api, canWrite, createDraft, refreshAfterWrite],
  );

  const submitUpdate = useCallback(
    async (
      customer: CustomerSummary,
      draft: CustomerDraft,
      nextActive: boolean,
      retryOperationId?: string,
    ) => {
      if (!canWrite || draft.nameAr.trim() === '') return;
      const operationId = retryOperationId ?? newId();
      setUpdateCommand({ kind: 'running', operationId });
      try {
        const result = await api.update(customer.id, {
          operationId,
          nameAr: draft.nameAr.trim(),
          nameEn: nullable(draft.nameEn),
          phone: nullable(draft.phone),
          email: nullable(draft.email),
          vatNumber: nullable(draft.vatNumber),
          isActive: nextActive,
        });
        setUpdateCommand({ kind: 'succeeded', replayed: result.replayed });
        await refreshAfterWrite(customer.id);
      } catch (error) {
        const failure = describeFailure(error);
        const ambiguous = ambiguousFailure(failure);
        setUpdateCommand({
          kind: 'failed',
          operationId: ambiguous ? operationId : null,
          failure,
          ambiguous,
        });
      }
    },
    [api, canWrite, refreshAfterWrite],
  );

  const loadMore = useCallback(async () => {
    if (list.kind !== 'ready' || list.page.nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api.list({
        limit: 50,
        cursor: list.page.nextCursor,
        ...(applied.search === undefined ? {} : { search: applied.search }),
        ...(applied.status === undefined ? {} : { status: applied.status }),
      });
      setList({
        kind: 'ready',
        page: { items: [...list.page.items, ...next.items], nextCursor: next.nextCursor },
      });
    } catch (error) {
      setList({ kind: 'failed', failure: describeFailure(error) });
    } finally {
      setLoadingMore(false);
    }
  }, [api, applied, list, loadingMore]);

  const createRetryId =
    createCommand.kind === 'failed' && createCommand.ambiguous
      ? createCommand.operationId ?? undefined
      : undefined;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(320px,0.9fr)_minmax(520px,1.6fr)]">
      <div className="flex flex-col gap-4">
        <CardSurface className="p-4">
          <form
            className="grid gap-3 sm:grid-cols-[1fr_160px_auto] xl:grid-cols-1"
            onSubmit={(event) => {
              event.preventDefault();
              setSelectedId(null);
              setDetail({ kind: 'closed' });
              setApplied({
                ...(search.trim() === '' ? {} : { search: search.trim() }),
                ...(status === 'all' ? {} : { status }),
              });
            }}
          >
            <input
              aria-label="بحث العملاء"
              placeholder="الاسم، الجوال، البريد، الرقم الضريبي"
              className="h-touch rounded-md border border-input bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select
              aria-label="حالة العميل"
              className="h-touch rounded-md border border-input bg-background px-3"
              value={status}
              onChange={(event) => setStatus(event.target.value as typeof status)}
            >
              <option value="all">كل الحالات</option>
              <option value="active">النشطون</option>
              <option value="inactive">غير النشطين</option>
            </select>
            <Button type="submit">بحث</Button>
          </form>
        </CardSurface>

        <CustomerList
          state={list}
          selectedId={selectedId}
          loadingMore={loadingMore}
          onSelect={(customerId) => void loadDetail(customerId)}
          onRetry={() => void loadList()}
          onLoadMore={() => void loadMore()}
        />
      </div>

      <div className="flex flex-col gap-4">
        {canWrite ? (
          <CardSurface className="p-4">
            <div className="mb-4">
              <h2 className="font-semibold">إضافة عميل</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                يُستخدم معرّف عملية ثابت عند أي نتيجة شبكية ملتبسة لمنع التكرار.
              </p>
            </div>
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(event) => void submitCreate(event, createRetryId)}
            >
              <InputField
                label="الاسم العربي"
                value={createDraft.nameAr}
                disabled={createCommand.kind === 'running'}
                onChange={(value) => {
                  setCreateDraft((current) => ({ ...current, nameAr: value }));
                  if (createRetryId === undefined) setCreateCommand({ kind: 'idle' });
                }}
              />
              <InputField
                label="الاسم الإنجليزي"
                value={createDraft.nameEn}
                dir="ltr"
                disabled={createCommand.kind === 'running'}
                onChange={(value) => setCreateDraft((current) => ({ ...current, nameEn: value }))}
              />
              <InputField
                label="الجوال"
                value={createDraft.phone}
                dir="ltr"
                inputMode="tel"
                disabled={createCommand.kind === 'running'}
                onChange={(value) => setCreateDraft((current) => ({ ...current, phone: value }))}
              />
              <InputField
                label="البريد الإلكتروني"
                value={createDraft.email}
                dir="ltr"
                inputMode="email"
                disabled={createCommand.kind === 'running'}
                onChange={(value) => setCreateDraft((current) => ({ ...current, email: value }))}
              />
              <InputField
                label="الرقم الضريبي"
                value={createDraft.vatNumber}
                dir="ltr"
                inputMode="numeric"
                disabled={createCommand.kind === 'running'}
                onChange={(value) => setCreateDraft((current) => ({ ...current, vatNumber: value }))}
              />
              <div className="flex items-end justify-end">
                <Button
                  type="submit"
                  disabled={createCommand.kind === 'running' || createDraft.nameAr.trim() === ''}
                >
                  {createCommand.kind === 'running'
                    ? 'جارٍ الحفظ…'
                    : createRetryId === undefined
                      ? 'إضافة العميل'
                      : 'تأكيد النتيجة'}
                </Button>
              </div>
            </form>
            {createCommand.kind === 'failed' ? (
              <div className="mt-3">
                <StatusNote tone={createCommand.ambiguous ? 'warning' : 'danger'} live>
                  {createCommand.failure.message}
                </StatusNote>
              </div>
            ) : createCommand.kind === 'succeeded' ? (
              <div className="mt-3">
                <StatusNote tone="success" live>
                  {createCommand.replayed ? 'تم تأكيد الإضافة السابقة.' : 'تمت إضافة العميل.'}
                </StatusNote>
              </div>
            ) : null}
          </CardSurface>
        ) : null}

        <CustomerDetailCard
          state={detail}
          canWrite={canWrite}
          command={updateCommand}
          onRetry={(customerId) => void loadDetail(customerId)}
          onUpdate={submitUpdate}
        />
      </div>
    </div>
  );
}
