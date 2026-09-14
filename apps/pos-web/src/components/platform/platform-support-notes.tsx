'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { ApiError } from '../../lib/api';
import {
  createPlatformApi,
  type PlatformSession,
  type PlatformSupportNotePage,
} from '../../lib/platform-api';
import { PLATFORM_INPUT, PLATFORM_LABEL, PlatformNotice } from './platform-ui';
import type { FormEvent, JSX } from 'react';

const api = createPlatformApi();
const EMPTY_PAGE: PlatformSupportNotePage = { items: [], nextCursor: null };

type SupportState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'hidden' }
  | { readonly kind: 'ready'; readonly session: PlatformSession; readonly page: PlatformSupportNotePage }
  | { readonly kind: 'failed'; readonly session: PlatformSession; readonly message: string };

function supportMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0)
      return 'لم يصل تأكيد من الخادم. يمكن إعادة المحاولة بنفس العملية دون إنشاء ملاحظة مكررة.';
    if (error.status === 401) return 'انتهت جلسة إدارة المنصة.';
    if (error.status === 403) return 'لا تملك الجلسة صلاحية سجل الدعم.';
    if (error.status === 404) return 'المنشأة غير موجودة أو لم تعد متاحة.';
    if (error.status === 409) return 'رقم العملية مستخدم لمحتوى مختلف. حدّث السجل ثم أعد المحاولة.';
    return error.serverMessage ?? 'تعذّر تنفيذ عملية سجل الدعم.';
  }
  return 'حدث خطأ غير متوقع أثناء تنفيذ عملية سجل الدعم.';
}

export function PlatformSupportNotes({ tenantId }: { readonly tenantId: string }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SupportState>({ kind: 'checking' });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [pendingOperationId, setPendingOperationId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;

    void api
      .session({ signal: controller.signal })
      .then(async (session) => {
        if (!live) return;
        if (!session.permissions.includes('platform.support.read')) {
          setState({ kind: 'hidden' });
          return;
        }
        const page = await api.supportNotes(tenantId, { limit: 50 }, { signal: controller.signal });
        if (live) setState({ kind: 'ready', session, page });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (!live) return;
        if (error instanceof ApiError && (error.unauthenticated || error.status === 403)) {
          setState({ kind: 'hidden' });
          return;
        }
        const session = state.kind === 'ready' || state.kind === 'failed' ? state.session : null;
        if (session === null) {
          setState({ kind: 'hidden' });
          return;
        }
        setState({ kind: 'failed', session, message: supportMessage(error) });
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [refreshKey, tenantId]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = draft.trim();
    if (busy || body === '') return;

    const operationId = pendingOperationId ?? crypto.randomUUID();
    setPendingOperationId(operationId);
    setBusy(true);
    setCommandError(null);
    try {
      await api.createSupportNote(tenantId, { operationId, body });
      setPendingOperationId(null);
      setDraft('');
      refresh();
    } catch (error) {
      setCommandError(supportMessage(error));
      if (!(error instanceof ApiError) || !error.ambiguous) setPendingOperationId(null);
    } finally {
      setBusy(false);
    }
  };

  if (state.kind === 'checking' || state.kind === 'hidden') return null;

  const session = state.session;
  const page = state.kind === 'ready' ? state.page : EMPTY_PAGE;
  const canManage = session.permissions.includes('platform.support.manage');

  return (
    <>
      <Button
        className="fixed bottom-4 left-4 z-40 shadow-lg"
        variant="outline"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="platform-support-notes-panel"
      >
        ملاحظات الدعم
      </Button>

      {open ? (
        <CardSurface
          id="platform-support-notes-panel"
          role="region"
          aria-label="ملاحظات الدعم الداخلي"
          className="fixed inset-x-4 bottom-20 z-40 max-h-[70vh] overflow-hidden shadow-xl sm:right-auto sm:w-[430px]"
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <p className="text-sm font-semibold text-card-foreground">ملاحظات الدعم</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                سجل داخلي متسلسل؛ الملاحظات المضافة لا تُعدّل ولا تُحذف.
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              إغلاق
            </Button>
          </div>

          <div className="max-h-[calc(70vh-73px)] overflow-y-auto p-5">
            {canManage ? (
              <form className="space-y-3" onSubmit={submit}>
                <div>
                  <label className={PLATFORM_LABEL} htmlFor="platform-support-note-body">
                    ملاحظة جديدة
                  </label>
                  <textarea
                    id="platform-support-note-body"
                    className={`${PLATFORM_INPUT} min-h-28 resize-y py-3`}
                    value={draft}
                    maxLength={4000}
                    disabled={busy}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="سجّل سياق الدعم أو المتابعة دون أسرار أو بيانات اعتماد"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {draft.length.toLocaleString('ar-SA')} / ٤٬٠٠٠
                  </p>
                </div>
                {commandError === null ? null : (
                  <PlatformNotice tone="danger">{commandError}</PlatformNotice>
                )}
                <div className="flex justify-end">
                  <Button type="submit" loading={busy} disabled={draft.trim() === ''}>
                    إضافة للمسار
                  </Button>
                </div>
              </form>
            ) : null}

            {state.kind === 'failed' ? (
              <div className={canManage ? 'mt-5' : ''}>
                <PlatformNotice tone="danger">{state.message}</PlatformNotice>
                <div className="mt-3">
                  <Button variant="outline" size="sm" onClick={refresh}>
                    إعادة التحميل
                  </Button>
                </div>
              </div>
            ) : (
              <div className={canManage ? 'mt-5 border-t border-border pt-5' : ''}>
                {page.items.length === 0 ? (
                  <p className="text-sm text-muted-foreground">لا توجد ملاحظات دعم مسجلة.</p>
                ) : (
                  <ol className="space-y-3">
                    {page.items.map((note) => (
                      <li key={note.id} className="rounded-lg border border-border p-3">
                        <p className="whitespace-pre-wrap text-sm leading-6 text-card-foreground">
                          {note.body}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span className="max-w-[220px] truncate font-mono" dir="ltr">
                            {note.actorRef}
                          </span>
                          <time dateTime={note.createdAt}>
                            {new Intl.DateTimeFormat('ar-SA', {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            }).format(new Date(note.createdAt))}
                          </time>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}
          </div>
        </CardSurface>
      ) : null}
    </>
  );
}
