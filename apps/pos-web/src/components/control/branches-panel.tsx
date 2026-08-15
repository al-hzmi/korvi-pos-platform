'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { StatusNote } from '../status-note';
import { ApiError } from '../../lib/api';
import type { JSX } from 'react';
import type { ApiClient } from '../../lib/api';
import type { AdminBranch, AdminTerminal } from '../../lib/api-types';

const PAGE_SIZE = 50;

type PendingActivation =
  | { readonly kind: 'branch'; readonly id: string; readonly label: string; readonly next: boolean }
  | {
      readonly kind: 'terminal';
      readonly id: string;
      readonly label: string;
      readonly next: boolean;
    };

interface BranchEdit {
  readonly id: string;
  readonly nameAr: string;
  readonly nameEn: string;
}

interface TerminalEdit {
  readonly id: string;
  readonly label: string;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.serverMessage !== null) return error.serverMessage;
  return fallback;
}

function stateBadge(active: boolean): JSX.Element {
  return (
    <span
      className={
        active
          ? 'rounded-full bg-success/10 px-2 py-1 text-xs font-semibold text-success'
          : 'rounded-full bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground'
      }
    >
      {active ? 'مفعّل' : 'معطّل'}
    </span>
  );
}

function lastSeenLabel(value: string | null): string {
  if (value === null) return 'لم يتصل بعد';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ar-SA', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function BranchesPanel({ api }: { readonly api: ApiClient }): JSX.Element {
  const [branches, setBranches] = useState<AdminBranch[]>([]);
  const [terminals, setTerminals] = useState<AdminTerminal[]>([]);
  const [branchCursor, setBranchCursor] = useState<string | null>(null);
  const [terminalCursor, setTerminalCursor] = useState<string | null>(null);
  const [branchesHaveMore, setBranchesHaveMore] = useState(false);
  const [terminalsHaveMore, setTerminalsHaveMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState<'branches' | 'terminals' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingActivation | null>(null);
  const [branchEdit, setBranchEdit] = useState<BranchEdit | null>(null);
  const [terminalEdit, setTerminalEdit] = useState<TerminalEdit | null>(null);

  const [branchCode, setBranchCode] = useState('');
  const [branchNameAr, setBranchNameAr] = useState('');
  const [branchNameEn, setBranchNameEn] = useState('');
  const [terminalBranchId, setTerminalBranchId] = useState('');
  const [terminalCode, setTerminalCode] = useState('');
  const [terminalLabel, setTerminalLabel] = useState('');

  const activeBranches = useMemo(() => branches.filter((branch) => branch.isActive), [branches]);
  const branchName = useMemo(
    () => new Map(branches.map((branch) => [branch.id, branch.nameAr] as const)),
    [branches],
  );

  const load = async (): Promise<void> => {
    setLoading(true);
    setFailure(null);
    setSuccess(null);
    try {
      const [branchPage, terminalPage] = await Promise.all([
        api.adminBranches({ limit: PAGE_SIZE }),
        api.adminTerminals({ limit: PAGE_SIZE }),
      ]);
      setBranches([...branchPage.items]);
      setBranchCursor(branchPage.nextCursor);
      setBranchesHaveMore(branchPage.hasMore);
      setTerminals([...terminalPage.items]);
      setTerminalCursor(terminalPage.nextCursor);
      setTerminalsHaveMore(terminalPage.hasMore);
      const firstActive = branchPage.items.find((branch) => branch.isActive);
      setTerminalBranchId((current) => current || firstActive?.id || '');
    } catch (error) {
      setFailure(errorMessage(error, 'تعذر تحميل الفروع والصناديق.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [api]);

  const loadMoreBranches = async (): Promise<void> => {
    if (!branchesHaveMore || branchCursor === null) return;
    setLoadingMore('branches');
    setFailure(null);
    try {
      const page = await api.adminBranches({ limit: PAGE_SIZE, cursor: branchCursor });
      setBranches((current) => [...current, ...page.items]);
      setBranchCursor(page.nextCursor);
      setBranchesHaveMore(page.hasMore);
    } catch (error) {
      setFailure(errorMessage(error, 'تعذر تحميل بقية الفروع.'));
    } finally {
      setLoadingMore(null);
    }
  };

  const loadMoreTerminals = async (): Promise<void> => {
    if (!terminalsHaveMore || terminalCursor === null) return;
    setLoadingMore('terminals');
    setFailure(null);
    try {
      const page = await api.adminTerminals({ limit: PAGE_SIZE, cursor: terminalCursor });
      setTerminals((current) => [...current, ...page.items]);
      setTerminalCursor(page.nextCursor);
      setTerminalsHaveMore(page.hasMore);
    } catch (error) {
      setFailure(errorMessage(error, 'تعذر تحميل بقية الصناديق.'));
    } finally {
      setLoadingMore(null);
    }
  };

  const createBranch = async (): Promise<void> => {
    const code = branchCode.trim();
    const nameAr = branchNameAr.trim();
    if (code === '' || nameAr === '') {
      setFailure('أدخل رمز الفرع واسمه العربي.');
      return;
    }
    setBusy('create-branch');
    setFailure(null);
    setSuccess(null);
    try {
      const created = await api.createAdminBranch({
        code,
        nameAr,
        ...(branchNameEn.trim() === '' ? {} : { nameEn: branchNameEn.trim() }),
      });
      setBranches((current) => [...current, created].sort((a, b) => a.code.localeCompare(b.code)));
      setBranchCode('');
      setBranchNameAr('');
      setBranchNameEn('');
      setTerminalBranchId((current) => current || created.id);
      setSuccess(`أُنشئ الفرع «${created.nameAr}».`);
    } catch (error) {
      setFailure(errorMessage(error, 'تعذر إنشاء الفرع.'));
    } finally {
      setBusy(null);
    }
  };

  const createTerminal = async (): Promise<void> => {
    const code = terminalCode.trim();
    const label = terminalLabel.trim();
    if (terminalBranchId === '' || code === '' || label === '') {
      setFailure('اختر الفرع وأدخل رمز الصندوق واسمه.');
      return;
    }
    setBusy('create-terminal');
    setFailure(null);
    setSuccess(null);
    try {
      const created = await api.createAdminTerminal({
        branchId: terminalBranchId,
        code,
        label,
      });
      setTerminals((current) => [...current, created].sort((a, b) => a.code.localeCompare(b.code)));
      setTerminalCode('');
      setTerminalLabel('');
      setSuccess(`أُنشئ الصندوق «${created.label}».`);
    } catch (error) {
      setFailure(errorMessage(error, 'تعذر إنشاء الصندوق.'));
    } finally {
      setBusy(null);
    }
  };

  const saveBranch = async (): Promise<void> => {
    if (branchEdit === null || branchEdit.nameAr.trim() === '') return;
    setBusy(`branch:${branchEdit.id}`);
    setFailure(null);
    setSuccess(null);
    try {
      const updated = await api.updateAdminBranch(branchEdit.id, {
        nameAr: branchEdit.nameAr.trim(),
        nameEn: branchEdit.nameEn.trim() === '' ? null : branchEdit.nameEn.trim(),
      });
      setBranches((current) =>
        current.map((branch) => (branch.id === updated.id ? updated : branch)),
      );
      setBranchEdit(null);
      setSuccess(`حُدّث الفرع «${updated.nameAr}».`);
    } catch (error) {
      setFailure(errorMessage(error, 'تعذر تحديث الفرع.'));
    } finally {
      setBusy(null);
    }
  };

  const saveTerminal = async (): Promise<void> => {
    if (terminalEdit === null || terminalEdit.label.trim() === '') return;
    setBusy(`terminal:${terminalEdit.id}`);
    setFailure(null);
    setSuccess(null);
    try {
      const updated = await api.updateAdminTerminal(terminalEdit.id, terminalEdit.label.trim());
      setTerminals((current) =>
        current.map((terminal) => (terminal.id === updated.id ? updated : terminal)),
      );
      setTerminalEdit(null);
      setSuccess(`حُدّث الصندوق «${updated.label}».`);
    } catch (error) {
      setFailure(errorMessage(error, 'تعذر تحديث الصندوق.'));
    } finally {
      setBusy(null);
    }
  };

  const confirmActivation = async (): Promise<void> => {
    if (pending === null) return;
    const key = `${pending.kind}:${pending.id}`;
    setBusy(key);
    setFailure(null);
    setSuccess(null);
    try {
      if (pending.kind === 'branch') {
        const updated = await api.setAdminBranchActive(pending.id, pending.next);
        setBranches((current) =>
          current.map((branch) => (branch.id === updated.id ? updated : branch)),
        );
        if (!updated.isActive && terminalBranchId === updated.id) {
          const next = branches.find((branch) => branch.id !== updated.id && branch.isActive);
          setTerminalBranchId(next?.id ?? '');
        }
        setSuccess(`${updated.isActive ? 'فُعّل' : 'عُطّل'} الفرع «${updated.nameAr}».`);
      } else {
        const updated = await api.setAdminTerminalActive(pending.id, pending.next);
        setTerminals((current) =>
          current.map((terminal) => (terminal.id === updated.id ? updated : terminal)),
        );
        setSuccess(`${updated.isActive ? 'فُعّل' : 'عُطّل'} الصندوق «${updated.label}».`);
      }
      setPending(null);
    } catch (error) {
      setFailure(errorMessage(error, 'تعذر تأكيد تغيير حالة التشغيل.'));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <CardSurface className="p-6">
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          جارٍ تحميل الفروع والصناديق…
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
      {success === null ? null : (
        <StatusNote tone="success" live>
          {success}
        </StatusNote>
      )}
      {pending === null ? null : (
        <CardSurface className="flex flex-col gap-3 border-warning/40 p-4">
          <StatusNote tone="warning">
            {pending.next
              ? `سيتم تفعيل «${pending.label}» وإتاحته للتشغيل وفق صلاحياته الحالية.`
              : `سيتم تعطيل «${pending.label}». الخادم سيرفض العملية إذا كانت تخالف حالة وردية مفتوحة أو حالة الفرع.`}
          </StatusNote>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy !== null} onClick={() => setPending(null)}>
              إلغاء
            </Button>
            <Button
              variant={pending.next ? 'primary' : 'destructive'}
              loading={busy === `${pending.kind}:${pending.id}`}
              onClick={() => void confirmActivation()}
            >
              تأكيد {pending.next ? 'التفعيل' : 'التعطيل'}
            </Button>
          </div>
        </CardSurface>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <CardSurface className="p-5">
          <h2 className="text-base font-semibold text-foreground">إضافة فرع</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            رمز الفرع ثابت بعد الإنشاء؛ يمكن تعديل الاسم لاحقاً.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
              رمز الفرع
              <input
                value={branchCode}
                disabled={busy !== null}
                onChange={(event) => setBranchCode(event.target.value)}
                className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
                dir="ltr"
              />
            </label>
            <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
              الاسم العربي
              <input
                value={branchNameAr}
                disabled={busy !== null}
                onChange={(event) => setBranchNameAr(event.target.value)}
                className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label className="flex flex-col gap-2 text-sm font-medium text-foreground sm:col-span-2">
              الاسم الإنجليزي — اختياري
              <input
                value={branchNameEn}
                disabled={busy !== null}
                onChange={(event) => setBranchNameEn(event.target.value)}
                className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
                dir="ltr"
              />
            </label>
          </div>
          <div className="mt-4 flex justify-end">
            <Button loading={busy === 'create-branch'} onClick={() => void createBranch()}>
              إنشاء الفرع
            </Button>
          </div>
        </CardSurface>

        <CardSurface className="p-5">
          <h2 className="text-base font-semibold text-foreground">إضافة صندوق</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            لا يمكن إنشاء صندوق جديد تحت فرع معطّل.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-2 text-sm font-medium text-foreground sm:col-span-2">
              الفرع
              <select
                value={terminalBranchId}
                disabled={busy !== null || activeBranches.length === 0}
                onChange={(event) => setTerminalBranchId(event.target.value)}
                className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
              >
                {activeBranches.length === 0 ? <option value="">لا يوجد فرع مفعّل</option> : null}
                {activeBranches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.code} — {branch.nameAr}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
              رمز الصندوق
              <input
                value={terminalCode}
                disabled={busy !== null}
                onChange={(event) => setTerminalCode(event.target.value)}
                className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
                dir="ltr"
              />
            </label>
            <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
              اسم الصندوق
              <input
                value={terminalLabel}
                disabled={busy !== null}
                onChange={(event) => setTerminalLabel(event.target.value)}
                className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
          </div>
          <div className="mt-4 flex justify-end">
            <Button
              loading={busy === 'create-terminal'}
              disabled={activeBranches.length === 0}
              onClick={() => void createTerminal()}
            >
              إنشاء الصندوق
            </Button>
          </div>
        </CardSurface>
      </div>

      <CardSurface className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-border p-5">
          <div>
            <h2 className="text-base font-semibold text-foreground">الفروع</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {branches.length} فرعاً محمّلاً في هذه الجلسة.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={busy !== null}>
            تحديث
          </Button>
        </div>
        {branches.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">لا توجد فروع حتى الآن.</p>
        ) : (
          <div className="divide-y divide-border">
            {branches.map((branch) => {
              const editing = branchEdit?.id === branch.id;
              return (
                <div key={branch.id} className="p-4">
                  {editing && branchEdit !== null ? (
                    <div className="grid gap-3 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
                      <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
                        الاسم العربي
                        <input
                          value={branchEdit.nameAr}
                          onChange={(event) =>
                            setBranchEdit({ ...branchEdit, nameAr: event.target.value })
                          }
                          className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
                        />
                      </label>
                      <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
                        الاسم الإنجليزي
                        <input
                          value={branchEdit.nameEn}
                          onChange={(event) =>
                            setBranchEdit({ ...branchEdit, nameEn: event.target.value })
                          }
                          className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
                          dir="ltr"
                        />
                      </label>
                      <div className="flex gap-2">
                        <Button variant="ghost" onClick={() => setBranchEdit(null)}>
                          إلغاء
                        </Button>
                        <Button
                          loading={busy === `branch:${branch.id}`}
                          onClick={() => void saveBranch()}
                        >
                          حفظ
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-semibold text-foreground">
                            {branch.code}
                          </span>
                          {stateBadge(branch.isActive)}
                        </div>
                        <p className="mt-1 font-semibold text-foreground">{branch.nameAr}</p>
                        {branch.nameEn === null ? null : (
                          <p className="text-sm text-muted-foreground" dir="ltr">
                            {branch.nameEn}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() =>
                            setBranchEdit({
                              id: branch.id,
                              nameAr: branch.nameAr,
                              nameEn: branch.nameEn ?? '',
                            })
                          }
                        >
                          تعديل الاسم
                        </Button>
                        <Button
                          variant={branch.isActive ? 'destructive' : 'secondary'}
                          size="sm"
                          disabled={busy !== null}
                          onClick={() =>
                            setPending({
                              kind: 'branch',
                              id: branch.id,
                              label: branch.nameAr,
                              next: !branch.isActive,
                            })
                          }
                        >
                          {branch.isActive ? 'تعطيل' : 'تفعيل'}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {branchesHaveMore ? (
          <div className="border-t border-border p-4 text-center">
            <Button
              variant="outline"
              loading={loadingMore === 'branches'}
              onClick={() => void loadMoreBranches()}
            >
              تحميل المزيد من الفروع
            </Button>
          </div>
        ) : null}
      </CardSurface>

      <CardSurface className="overflow-hidden">
        <div className="border-b border-border p-5">
          <h2 className="text-base font-semibold text-foreground">الصناديق</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {terminals.length} صندوقاً محمّلاً في هذه الجلسة.
          </p>
        </div>
        {terminals.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">لا توجد صناديق حتى الآن.</p>
        ) : (
          <div className="divide-y divide-border">
            {terminals.map((terminal) => {
              const editing = terminalEdit?.id === terminal.id;
              return (
                <div key={terminal.id} className="p-4">
                  {editing && terminalEdit !== null ? (
                    <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
                      <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
                        اسم الصندوق
                        <input
                          value={terminalEdit.label}
                          onChange={(event) =>
                            setTerminalEdit({ ...terminalEdit, label: event.target.value })
                          }
                          className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
                        />
                      </label>
                      <div className="flex gap-2">
                        <Button variant="ghost" onClick={() => setTerminalEdit(null)}>
                          إلغاء
                        </Button>
                        <Button
                          loading={busy === `terminal:${terminal.id}`}
                          onClick={() => void saveTerminal()}
                        >
                          حفظ
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-semibold text-foreground">
                            {terminal.code}
                          </span>
                          {stateBadge(terminal.isActive)}
                        </div>
                        <p className="mt-1 font-semibold text-foreground">{terminal.label}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {branchName.get(terminal.branchId) ?? 'فرع غير محمّل'} · آخر اتصال:{' '}
                          {lastSeenLabel(terminal.lastSeenAt)}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() =>
                            setTerminalEdit({ id: terminal.id, label: terminal.label })
                          }
                        >
                          تعديل الاسم
                        </Button>
                        <Button
                          variant={terminal.isActive ? 'destructive' : 'secondary'}
                          size="sm"
                          disabled={busy !== null}
                          onClick={() =>
                            setPending({
                              kind: 'terminal',
                              id: terminal.id,
                              label: terminal.label,
                              next: !terminal.isActive,
                            })
                          }
                        >
                          {terminal.isActive ? 'تعطيل' : 'تفعيل'}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {terminalsHaveMore ? (
          <div className="border-t border-border p-4 text-center">
            <Button
              variant="outline"
              loading={loadingMore === 'terminals'}
              onClick={() => void loadMoreTerminals()}
            >
              تحميل المزيد من الصناديق
            </Button>
          </div>
        ) : null}
      </CardSurface>
    </div>
  );
}
