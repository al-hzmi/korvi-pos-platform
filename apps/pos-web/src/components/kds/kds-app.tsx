'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { newId } from '@korvi/domain';
import { Button, CardSurface, KorviMark } from '@korvi/ui';
import { LoginScreen } from '../login-screen';
import { Screen } from '../screen';
import { StatusNote } from '../status-note';
import { createApiClient } from '../../lib/api';
import { describeFailure } from '../../lib/failures';
import { nextPreparationTaskStatus, preparationTaskActionLabel } from '../../lib/kds';
import { hasPermission, LOGOUT_UNCONFIRMED } from '../../lib/session';
import { useSession } from '../../hooks/use-session';
import type { JSX } from 'react';
import type { ApiClient } from '../../lib/api';
import type {
  Principal,
  RestaurantPreparationStation,
  RestaurantPreparationTask,
  RestaurantPreparationTaskUpdateRequest,
} from '../../lib/api-types';

interface PendingTaskCommand {
  readonly taskId: string;
  readonly request: RestaurantPreparationTaskUpdateRequest;
}

function Waiting({ label }: { readonly label: string }): JSX.Element {
  return (
    <Screen title="شاشة المطبخ" subtitle="Korvi KDS">
      <CardSurface className="p-6">
        <p className="text-center text-sm text-muted-foreground" role="status" aria-live="polite">
          {label}
        </p>
      </CardSurface>
    </Screen>
  );
}

function statusLabel(status: RestaurantPreparationTask['status']): string {
  switch (status) {
    case 'queued':
      return 'بانتظار التحضير';
    case 'preparing':
      return 'قيد التحضير';
    case 'ready':
      return 'جاهز';
    case 'served':
      return 'تم التقديم';
  }
}

function TaskCard({
  task,
  busy,
  onAdvance,
}: {
  readonly task: RestaurantPreparationTask;
  readonly busy: boolean;
  readonly onAdvance: (task: RestaurantPreparationTask) => void;
}): JSX.Element {
  const action = preparationTaskActionLabel(task.status);
  return (
    <CardSurface className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-lg font-semibold text-foreground">{task.nameAr}</p>
          <p className="mt-1 font-mono text-sm text-muted-foreground">
            {task.sku} · {task.quantityScaled}
          </p>
        </div>
        <span className="rounded-md bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground">
          {statusLabel(task.status)}
        </span>
      </div>
      {task.preparationNote === null ? null : (
        <p className="rounded-md bg-warning/10 px-3 py-2 text-sm font-medium text-foreground">
          {task.preparationNote}
        </p>
      )}
      {task.preparationOptions === null ? null : (
        <p className="text-sm text-muted-foreground">{task.preparationOptions}</p>
      )}
      <p className="text-xs text-muted-foreground">
        الطلب {task.orderId.slice(-8)} · السطر {task.lineNumber} · نسخة الطلب {task.orderRevision}
      </p>
      {action === null ? null : (
        <Button size="lg" disabled={busy} onClick={() => onAdvance(task)}>
          {action}
        </Button>
      )}
    </CardSurface>
  );
}

function KdsWorkspace({
  api,
  principal,
  onExpire,
  onSignOut,
}: {
  readonly api: ApiClient;
  readonly principal: Principal;
  readonly onExpire: () => void;
  readonly onSignOut: () => void;
}): JSX.Element {
  const [stations, setStations] = useState<readonly RestaurantPreparationStation[]>([]);
  const [stationId, setStationId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<readonly RestaurantPreparationTask[]>([]);
  const [loadingStations, setLoadingStations] = useState(true);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingTaskCommand | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);

  const loadStations = useCallback(async () => {
    setLoadingStations(true);
    try {
      const value = await api.restaurantPreparationStations();
      setStations(value);
      setStationId((current) =>
        current !== null && value.some((station) => station.id === current)
          ? current
          : (value[0]?.id ?? null),
      );
    } catch (error) {
      const failure = describeFailure(error);
      if (failure.action === 'reauthenticate') onExpire();
      setNotice(failure.message);
    } finally {
      setLoadingStations(false);
    }
  }, [api, onExpire]);

  const loadTasks = useCallback(async () => {
    if (stationId === null) {
      setTasks([]);
      return;
    }
    setLoadingTasks(true);
    try {
      setTasks(await api.restaurantPreparationTasks(stationId));
    } catch (error) {
      const failure = describeFailure(error);
      if (failure.action === 'reauthenticate') onExpire();
      setNotice(failure.message);
    } finally {
      setLoadingTasks(false);
    }
  }, [api, onExpire, stationId]);

  useEffect(() => {
    void loadStations();
  }, [loadStations]);

  useEffect(() => {
    void loadTasks();
    if (stationId === null) return undefined;
    const timer = globalThis.setInterval(() => {
      if (pending === null) void loadTasks();
    }, 5000);
    return () => globalThis.clearInterval(timer);
  }, [loadTasks, pending, stationId]);

  const execute = useCallback(
    async (command: PendingTaskCommand) => {
      setPending(command);
      setAmbiguous(false);
      setNotice(null);
      try {
        await api.updateRestaurantPreparationTask(command.taskId, command.request);
        setPending(null);
        await loadTasks();
      } catch (error) {
        const failure = describeFailure(error);
        if (failure.action === 'reauthenticate') onExpire();
        if (failure.action === 'retry-same') {
          setAmbiguous(true);
          setNotice(failure.message);
          return;
        }
        setPending(null);
        setAmbiguous(false);
        setNotice(failure.message);
        await loadTasks();
      }
    },
    [api, loadTasks, onExpire],
  );

  const advance = useCallback(
    (task: RestaurantPreparationTask) => {
      const status = nextPreparationTaskStatus(task.status);
      if (status === null || pending !== null) return;
      void execute({
        taskId: task.id,
        request: {
          operationId: newId(),
          expectedRevision: task.revision,
          status,
        },
      });
    },
    [execute, pending],
  );

  const retry = useCallback(() => {
    if (pending === null || !ambiguous) return;
    void execute(pending);
  }, [ambiguous, execute, pending]);

  const groups = useMemo(
    () => ({
      queued: tasks.filter((task) => task.status === 'queued'),
      preparing: tasks.filter((task) => task.status === 'preparing'),
      ready: tasks.filter((task) => task.status === 'ready'),
    }),
    [tasks],
  );

  return (
    <div className="min-h-screen bg-muted/40">
      <header className="flex min-h-16 items-center justify-between gap-4 border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-3">
          <KorviMark size="sm" suffix="KDS" />
          <div>
            <p className="text-sm font-semibold text-foreground">شاشة المطبخ</p>
            <p className="text-xs text-muted-foreground">{principal.user.displayName}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/cashier"
            className="inline-flex h-touch items-center rounded-md border border-input px-3 text-sm font-medium"
          >
            نقطة البيع
          </a>
          <Button variant="ghost" disabled={pending !== null} onClick={onSignOut}>
            خروج
          </Button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-4">
        <CardSurface className="flex flex-wrap items-center gap-3 p-3">
          <label htmlFor="kds-station" className="text-sm font-semibold">
            محطة التحضير
          </label>
          <select
            id="kds-station"
            value={stationId ?? ''}
            disabled={loadingStations || pending !== null}
            onChange={(event) => setStationId(event.target.value || null)}
            className="h-touch min-w-56 rounded-md border border-input bg-background px-3 text-sm"
          >
            {stations.length === 0 ? <option value="">لا توجد محطات نشطة</option> : null}
            {stations.map((station) => (
              <option key={station.id} value={station.id}>
                {station.nameAr} · {station.code}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            disabled={loadingTasks || pending !== null}
            onClick={() => void loadTasks()}
          >
            تحديث
          </Button>
          {loadingTasks ? <span className="text-xs text-muted-foreground">جارٍ التحديث…</span> : null}
        </CardSurface>

        {notice === null ? null : (
          <StatusNote tone={ambiguous ? 'warning' : 'danger'} live>
            {notice}
            {ambiguous && pending !== null ? (
              <Button className="ms-3" size="sm" variant="outline" onClick={retry}>
                إعادة نفس العملية
              </Button>
            ) : null}
          </StatusNote>
        )}

        <div className="grid min-h-[60vh] gap-4 lg:grid-cols-3">
          {([
            ['queued', 'بانتظار التحضير'],
            ['preparing', 'قيد التحضير'],
            ['ready', 'جاهز للتقديم'],
          ] as const).map(([status, title]) => (
            <section
              key={status}
              className="flex min-h-64 flex-col gap-3 rounded-xl border border-border bg-background/60 p-3"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold">{title}</h2>
                <span className="rounded-full bg-muted px-2 py-1 text-xs font-semibold">
                  {groups[status].length}
                </span>
              </div>
              {groups[status].length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                  لا توجد مهام في هذه الحالة.
                </p>
              ) : (
                groups[status].map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    busy={pending !== null}
                    onAdvance={advance}
                  />
                ))
              )}
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}

export function KdsApp({ api: injected }: { readonly api?: ApiClient } = {}): JSX.Element {
  const api = useMemo(() => injected ?? createApiClient(), [injected]);
  const session = useSession(api);

  if (session.state.kind === 'loading') return <Waiting label="جارٍ التحقق من الجلسة…" />;
  if (session.state.kind === 'signing-out') return <Waiting label="جارٍ تسجيل الخروج…" />;

  if (session.state.kind === 'logout-failed') {
    return (
      <Screen title="لم يتم تأكيد الخروج" subtitle="Korvi KDS">
        <CardSurface className="flex flex-col gap-4 p-6">
          <StatusNote tone="danger" live>
            {LOGOUT_UNCONFIRMED.message}
          </StatusNote>
          <Button onClick={session.signOut}>إعادة محاولة تسجيل الخروج</Button>
        </CardSurface>
      </Screen>
    );
  }

  if (session.state.kind === 'unavailable') {
    return (
      <Screen title="شاشة المطبخ غير متاحة" subtitle="Korvi KDS">
        <CardSurface className="flex flex-col gap-4 p-6">
          <StatusNote tone="warning" live>
            {session.state.failure.message}
          </StatusNote>
          <Button onClick={session.retry}>إعادة المحاولة</Button>
        </CardSurface>
      </Screen>
    );
  }

  if (session.state.kind === 'anonymous') {
    return <LoginScreen api={api} onAuthenticated={session.signedIn} notice={session.state.notice} />;
  }

  if (!hasPermission(session.state.principal, 'sale.create')) {
    return (
      <Screen title="شاشة المطبخ" subtitle="Korvi KDS">
        <CardSurface className="flex flex-col gap-4 p-6">
          <StatusNote tone="warning">لا تملك جلستك صلاحية تشغيل شاشة المطبخ.</StatusNote>
          <a href="/" className="text-center text-sm font-semibold text-primary">
            العودة
          </a>
        </CardSurface>
      </Screen>
    );
  }

  return (
    <KdsWorkspace
      api={api}
      principal={session.state.principal}
      onExpire={session.expire}
      onSignOut={session.signOut}
    />
  );
}
