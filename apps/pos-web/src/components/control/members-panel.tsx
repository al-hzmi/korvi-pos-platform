'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { Field } from '../field';
import { StatusNote } from '../status-note';
import { ApiError } from '../../lib/api';
import type { JSX } from 'react';
import type { ApiClient } from '../../lib/api';
import type { AdminBranch, AdminMember, AdminRole } from '../../lib/api-types';

const PAGE_SIZE = 50;

interface MemberEdit {
  readonly userId: string;
  readonly displayName: string;
  readonly defaultBranchId: string;
}

type PendingAccess = {
  readonly kind: 'user' | 'membership';
  readonly userId: string;
  readonly label: string;
  readonly next: boolean;
} | null;

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.serverMessage !== null) return error.serverMessage;
  return fallback;
}

function statusBadge(active: boolean, activeLabel = 'مفعّل', inactiveLabel = 'معطّل'): JSX.Element {
  return (
    <span
      className={
        active
          ? 'rounded-full bg-success/10 px-2 py-1 text-xs font-semibold text-success'
          : 'rounded-full bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground'
      }
    >
      {active ? activeLabel : inactiveLabel}
    </span>
  );
}

async function loadAllBranches(api: ApiClient): Promise<readonly AdminBranch[]> {
  const rows: AdminBranch[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const page = await api.adminBranches({
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    rows.push(...page.items);
    if (!page.hasMore || page.nextCursor === null) return rows;
    if (seen.has(page.nextCursor)) throw new Error('branch pagination repeated a cursor');
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export function MembersPanel({
  api,
  canManageSettings,
}: {
  readonly api: ApiClient;
  readonly canManageSettings: boolean;
}): JSX.Element {
  const [members, setMembers] = useState<AdminMember[]>([]);
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [branches, setBranches] = useState<AdminBranch[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [edit, setEdit] = useState<MemberEdit | null>(null);
  const [pending, setPending] = useState<PendingAccess>(null);

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [defaultBranchId, setDefaultBranchId] = useState('');

  const roleById = useMemo(() => new Map(roles.map((role) => [role.id, role] as const)), [roles]);
  const branchById = useMemo(
    () => new Map(branches.map((branch) => [branch.id, branch] as const)),
    [branches],
  );

  const replaceMember = (member: AdminMember): void => {
    setMembers((current) => current.map((row) => (row.userId === member.userId ? member : row)));
  };

  const load = async (): Promise<void> => {
    setLoading(true);
    setFailure(null);
    setSuccess(null);
    try {
      const [memberPage, roleRows, branchRows] = await Promise.all([
        api.adminMembers({ limit: PAGE_SIZE }),
        api.adminRoles(),
        canManageSettings ? loadAllBranches(api) : Promise.resolve([] as readonly AdminBranch[]),
      ]);
      setMembers([...memberPage.items]);
      setCursor(memberPage.nextCursor);
      setHasMore(memberPage.hasMore);
      setRoles([...roleRows]);
      setBranches([...branchRows]);
      const firstActive = branchRows.find((branch) => branch.isActive);
      setDefaultBranchId((current) => current || firstActive?.id || '');
    } catch (error) {
      setFailure(errorMessage(error, 'تعذر تحميل الموظفين والصلاحيات.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [api, canManageSettings]);

  const loadMore = async (): Promise<void> => {
    if (!hasMore || cursor === null) return;
    setLoadingMore(true);
    setFailure(null);
    try {
      const page = await api.adminMembers({ limit: PAGE_SIZE, cursor });
      setMembers((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (error) {
      setFailure(errorMessage(error, 'تعذر تحميل بقية الموظفين.'));
    } finally {
      setLoadingMore(false);
    }
  };

  const createMember = async (): Promise<void> => {
    const normalizedEmail = email.trim();
    const name = displayName.trim();
    if (normalizedEmail === '' || name === '') {
      setFailure('أدخل البريد الإلكتروني واسم الموظف.');
      return;
    }

    setBusy('create');
    setFailure(null);
    setSuccess(null);
    try {
      const created = await api.createAdminMember({
        email: normalizedEmail,
        displayName: name,
        ...(canManageSettings && defaultBranchId !== '' ? { defaultBranchId } : {}),
      });
      setMembers((current) => [...current, created].sort((a, b) => a.email.localeCompare(b.email)));
      setEmail('');
      setDisplayName('');
      setSuccess(
        created.hasCredential
          ? `أُضيف الموظف «${created.displayName}».`
          : `أُضيف الموظف «${created.displayName}». لم تُنشأ له بيانات دخول بعد.`,
      );
    } catch (error) {
      setFailure(errorMessage(error, 'تعذر إضافة الموظف.'));
    } finally {
      setBusy(null);
    }
  };

  const saveMember = async (): Promise<void> => {
    if (edit === null || edit.displayName.trim() === '') return;
    setBusy(`edit:${edit.userId}`);
    setFailure(null);
    setSuccess(null);
    try {
      const updated = await api.updateAdminMember(edit.userId, {
        displayName: edit.displayName.trim(),
        ...(canManageSettings
          ? { defaultBranchId: edit.defaultBranchId === '' ? null : edit.defaultBranchId }
          : {}),
      });
      replaceMember(updated);
      setEdit(null);
      setSuccess(`حُدّث الموظف «${updated.displayName}».`);
    } catch (error) {
      setFailure(errorMessage(error, 'تعذر تحديث الموظف.'));
    } finally {
      setBusy(null);
    }
  };

  const applyPending = async (): Promise<void> => {
    if (pending === null) return;
    const request = pending;
    setPending(null);
    setBusy(`${request.kind}:${request.userId}`);
    setFailure(null);
    setSuccess(null);
    try {
      const result =
        request.kind === 'user'
          ? await api.setAdminMemberUserActive(request.userId, request.next)
          : await api.setAdminMemberMembershipActive(request.userId, request.next);
      replaceMember(result.member);
      const sessions = result.revokedSessions;
      setSuccess(
        `${request.label}: ${request.next ? 'تم التفعيل' : 'تم التعطيل'}` +
          (sessions > 0 ? `، وأُوقفت ${String(sessions)} جلسة نشطة.` : '.'),
      );
    } catch (error) {
      setFailure(errorMessage(error, 'تعذر تغيير حالة الموظف.'));
    } finally {
      setBusy(null);
    }
  };

  const changeRole = async (
    member: AdminMember,
    role: AdminRole,
    assign: boolean,
  ): Promise<void> => {
    const key = `role:${member.userId}:${role.id}`;
    setBusy(key);
    setFailure(null);
    setSuccess(null);
    try {
      const result = assign
        ? await api.assignAdminRole(member.userId, role.id)
        : await api.removeAdminRole(member.userId, role.id);
      replaceMember(result.member);
      setSuccess(
        result.changed
          ? `${assign ? 'مُنح' : 'أُزيل'} دور «${role.nameAr}» للموظف «${member.displayName}».`
          : 'لم يتغير شيء؛ كانت الصلاحية بالفعل في الحالة المطلوبة.',
      );
    } catch (error) {
      setFailure(errorMessage(error, 'تعذر تعديل الدور.'));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <CardSurface className="p-6">
        <p className="text-center text-sm text-muted-foreground" role="status">
          جارٍ تحميل الموظفين والصلاحيات…
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

      <CardSurface className="p-5">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-foreground">إضافة موظف</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            إنشاء الموظف لا ينشئ كلمة مرور أو دعوة. بيانات الدخول لها مسار مستقل لاحقاً.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Field
            id="admin-member-email"
            label="البريد الإلكتروني"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Field
            id="admin-member-name"
            label="اسم الموظف"
            autoComplete="off"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          {canManageSettings ? (
            <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
              الفرع الافتراضي
              <select
                value={defaultBranchId}
                onChange={(event) => setDefaultBranchId(event.target.value)}
                className="h-touch rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">بدون فرع افتراضي</option>
                {branches
                  .filter((branch) => branch.isActive)
                  .map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.nameAr} · {branch.code}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
        </div>
        <div className="mt-4 flex justify-end">
          <Button loading={busy === 'create'} onClick={() => void createMember()}>
            إضافة الموظف
          </Button>
        </div>
      </CardSurface>

      {members.length === 0 ? (
        <CardSurface className="p-8 text-center text-sm text-muted-foreground">
          لا يوجد موظفون في المنشأة حتى الآن.
        </CardSurface>
      ) : (
        <div className="flex flex-col gap-3">
          {members.map((member) => {
            const membershipActive = member.membershipStatus === 'active';
            const editing = edit?.userId === member.userId;
            return (
              <CardSurface key={member.userId} className="p-5">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold text-foreground">
                        {member.displayName}
                      </h3>
                      {statusBadge(member.userActive, 'الحساب مفعّل', 'الحساب معطّل')}
                      {statusBadge(membershipActive, 'العضوية مفعّلة', 'العضوية معطّلة')}
                      {member.hasCredential ? (
                        <span className="rounded-full bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
                          لديه بيانات دخول
                        </span>
                      ) : (
                        <span className="rounded-full bg-warning/10 px-2 py-1 text-xs font-semibold text-warning">
                          بلا بيانات دخول
                        </span>
                      )}
                    </div>
                    <p className="mt-1 break-all text-sm text-muted-foreground" dir="ltr">
                      {member.email}
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      الفرع الافتراضي:{' '}
                      {member.defaultBranchId === null
                        ? 'غير محدد'
                        : (branchById.get(member.defaultBranchId)?.nameAr ??
                          member.defaultBranchId)}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setEdit({
                          userId: member.userId,
                          displayName: member.displayName,
                          defaultBranchId: member.defaultBranchId ?? '',
                        })
                      }
                    >
                      تعديل البيانات
                    </Button>
                    <Button
                      variant={member.userActive ? 'destructive' : 'outline'}
                      size="sm"
                      disabled={busy !== null}
                      onClick={() =>
                        setPending({
                          kind: 'user',
                          userId: member.userId,
                          label: `حساب ${member.displayName}`,
                          next: !member.userActive,
                        })
                      }
                    >
                      {member.userActive ? 'تعطيل الحساب' : 'تفعيل الحساب'}
                    </Button>
                    <Button
                      variant={membershipActive ? 'destructive' : 'outline'}
                      size="sm"
                      disabled={busy !== null}
                      onClick={() =>
                        setPending({
                          kind: 'membership',
                          userId: member.userId,
                          label: `عضوية ${member.displayName}`,
                          next: !membershipActive,
                        })
                      }
                    >
                      {membershipActive ? 'تعطيل العضوية' : 'تفعيل العضوية'}
                    </Button>
                  </div>
                </div>

                {editing && edit !== null ? (
                  <div className="mt-4 grid gap-4 rounded-lg border border-border bg-muted/30 p-4 md:grid-cols-2">
                    <Field
                      id={`member-name-${member.userId}`}
                      label="اسم الموظف"
                      value={edit.displayName}
                      onChange={(event) => setEdit({ ...edit, displayName: event.target.value })}
                    />
                    {canManageSettings ? (
                      <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
                        الفرع الافتراضي
                        <select
                          value={edit.defaultBranchId}
                          onChange={(event) =>
                            setEdit({ ...edit, defaultBranchId: event.target.value })
                          }
                          className="h-touch rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <option value="">بدون فرع افتراضي</option>
                          {branches.map((branch) => (
                            <option key={branch.id} value={branch.id}>
                              {branch.nameAr} · {branch.code} {branch.isActive ? '' : '· معطّل'}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <div className="flex items-end gap-2 md:col-span-2">
                      <Button
                        loading={busy === `edit:${member.userId}`}
                        onClick={() => void saveMember()}
                      >
                        حفظ التعديل
                      </Button>
                      <Button variant="ghost" onClick={() => setEdit(null)}>
                        إلغاء
                      </Button>
                    </div>
                  </div>
                ) : null}

                <div className="mt-5 border-t border-border pt-4">
                  <h4 className="text-sm font-semibold text-foreground">الأدوار والصلاحيات</h4>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {roles.map((role) => {
                      const assigned = member.roleIds.includes(role.id);
                      const roleBusy = busy === `role:${member.userId}:${role.id}`;
                      return (
                        <Button
                          key={role.id}
                          variant={assigned ? 'secondary' : 'outline'}
                          size="sm"
                          loading={roleBusy}
                          disabled={busy !== null && !roleBusy}
                          title={role.permissions.join(' · ')}
                          onClick={() => void changeRole(member, role, !assigned)}
                        >
                          {assigned ? '✓ ' : '+ '}
                          {role.nameAr}
                        </Button>
                      );
                    })}
                  </div>
                  {member.roleIds.some((roleId) => !roleById.has(roleId)) ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      توجد أدوار مرتبطة بهذا الموظف لا تظهر ضمن قائمة الأدوار القابلة للإسناد
                      الحالية.
                    </p>
                  ) : null}
                </div>
              </CardSurface>
            );
          })}
        </div>
      )}

      {hasMore ? (
        <div className="flex justify-center">
          <Button variant="outline" loading={loadingMore} onClick={() => void loadMore()}>
            تحميل المزيد من الموظفين
          </Button>
        </div>
      ) : null}

      {pending === null ? null : (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/20 p-4"
          role="presentation"
        >
          <CardSurface
            className="w-full max-w-md p-5 shadow-lg"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="member-access-title"
          >
            <h2 id="member-access-title" className="text-lg font-semibold text-foreground">
              تأكيد تغيير الوصول
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {pending.next
                ? `سيتم تفعيل ${pending.label}. الجلسات القديمة التي أُلغيت سابقاً لن تعود تلقائياً.`
                : `سيتم تعطيل ${pending.label}. قد يؤدي ذلك إلى إنهاء جلساته النشطة، ولن يسمح الخادم بتعطيل آخر مدير صالح للمنشأة.`}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPending(null)}>
                إلغاء
              </Button>
              <Button
                variant={pending.next ? 'primary' : 'destructive'}
                onClick={() => void applyPending()}
              >
                تأكيد
              </Button>
            </div>
          </CardSurface>
        </div>
      )}
    </div>
  );
}
