'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { ApiError } from '../../lib/api';
import { createCustomersApi } from '../../lib/customers-api';
import { createLoyaltyApi } from '../../lib/loyalty-api';
import type { FormEvent, JSX } from 'react';
import type { CustomerSummary } from '../../lib/customers-api';
import type { LoyaltyLedger, LoyaltyPolicy, LoyaltyPolicyDraft } from '../../lib/loyalty-api';

const DEFAULT_POLICY: LoyaltyPolicyDraft = {
  nameAr: 'نقاط مكافآت العملاء',
  earnNumerator: '1',
  earnDenominator: '100',
  redeemValueMinorPerPoint: '10',
};

function message(error: unknown): string {
  if (error instanceof ApiError) {
    const messages: Readonly<Record<string, string>> = {
      'stale-revision': 'تغيرت السياسة من جهاز آخر. حدّث البيانات قبل إعادة الحفظ.',
      'program-exists': 'يوجد برنامج ولاء بالفعل. حدّث السياسة.',
      'program-inactive': 'فعّل برنامج الولاء قبل تسجيل العميل.',
      'not-consented': 'يلزم توثيق موافقة العميل على الاشتراك.',
      'already-enrolled': 'العميل مشترك بالفعل.',
      'customer-unavailable': 'العميل غير موجود أو غير نشط.',
      'policy-locked': 'لا يمكن تغيير معدلات السياسة أثناء تفعيلها أو بعد إنشاء سجلات مالية.',
      forbidden: 'ليس لديك الصلاحية المطلوبة لهذه العملية.',
      invalid_body: 'البيانات غير صالحة. استخدم أرقامًا صحيحة موجبة فقط.',
      timeout: 'انتهت المهلة. تحقق من الحالة الحالية قبل إعادة المحاولة.',
      network: 'تعذر تأكيد النتيجة. أعد تحميل الحالة قبل أي محاولة أخرى.',
    };
    return messages[error.code] ?? error.serverMessage ?? 'تعذر تأكيد العملية. راجع سجل الخادم.';
  }
  return 'حدث خطأ غير متوقع. لم يتم تأكيد العملية.';
}

const fieldClass =
  'h-touch w-full rounded-md border border-input bg-background px-3 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

export function LoyaltyPanel({
  onCommandLockChange = () => undefined,
}: {
  readonly onCommandLockChange?: (locked: boolean) => void;
}): JSX.Element {
  const [policy, setPolicy] = useState<LoyaltyPolicy | null>(null);
  const [draft, setDraft] = useState<LoyaltyPolicyDraft>(DEFAULT_POLICY);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [term, setTerm] = useState('');
  const [customers, setCustomers] = useState<readonly CustomerSummary[]>([]);
  const [selected, setSelected] = useState<CustomerSummary | null>(null);
  const [consent, setConsent] = useState(false);
  const [ledger, setLedger] = useState<LoyaltyLedger | null>(null);
  const [searching, setSearching] = useState(false);

  const loadPolicy = useCallback(async () => {
    try {
      const value = await createLoyaltyApi().policy();
      setPolicy(value);
      setDraft(
        value === null
          ? DEFAULT_POLICY
          : {
              nameAr: value.nameAr,
              earnNumerator: value.earnNumerator,
              earnDenominator: value.earnDenominator,
              redeemValueMinorPerPoint: value.redeemValueMinorPerPoint,
            },
      );
    } catch (error) {
      setErrorText(message(error));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadPolicy();
  }, [loadPolicy]);

  async function mutate(work: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setErrorText(null);
    setSuccess(null);
    onCommandLockChange(true);
    try {
      await work();
    } catch (error) {
      setErrorText(message(error));
      // An ambiguous timeout is not a license to mint a second enrollment.
      await loadPolicy();
    } finally {
      setBusy(false);
      onCommandLockChange(false);
    }
  }

  async function savePolicy(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await mutate(async () => {
      const client = createLoyaltyApi();
      const value =
        policy === null ? await client.create(draft) : await client.revise(policy.revision, draft);
      setPolicy(value);
      setDraft({
        nameAr: value.nameAr,
        earnNumerator: value.earnNumerator,
        earnDenominator: value.earnDenominator,
        redeemValueMinorPerPoint: value.redeemValueMinorPerPoint,
      });
      setSuccess('تم حفظ السياسة بواسطة الخادم.');
    });
  }

  async function setStatus(status: 'active' | 'paused'): Promise<void> {
    if (policy === null) return;
    await mutate(async () => {
      const value = await createLoyaltyApi().revise(policy.revision, { status });
      setPolicy(value);
      setSuccess(status === 'active' ? 'تم تفعيل البرنامج.' : 'تم إيقاف اكتساب واستبدال النقاط.');
    });
  }

  async function searchCustomers(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSearching(true);
    setErrorText(null);
    try {
      const result = await createCustomersApi().list({ search: term, limit: 20 });
      setCustomers(result.items);
    } catch (error) {
      setErrorText(message(error));
    } finally {
      setSearching(false);
    }
  }

  async function selectCustomer(customer: CustomerSummary): Promise<void> {
    setSelected(customer);
    setConsent(false);
    setLedger(null);
    try {
      setLedger(await createLoyaltyApi().ledger(customer.id));
    } catch (error) {
      setErrorText(message(error));
    }
  }

  async function enroll(): Promise<void> {
    if (selected === null || !consent) return;
    const customer = selected;
    await mutate(async () => {
      await createLoyaltyApi().enroll(customer.id);
      setLedger(await createLoyaltyApi().ledger(customer.id));
      setConsent(false);
      setSuccess('تم توثيق موافقة العميل وإنشاء عضويته.');
    });
  }

  return (
    <div className="space-y-5" dir="rtl">
      <CardSurface className="space-y-4 p-5">
        <header>
          <h2 className="text-lg font-semibold">برنامج الولاء</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            إعداد اكتساب النقاط وتسجيل الاشتراكات. الاستبدال عبر الكاشير غير متاح قبل اكتمال ربط
            التسوية المالية.
          </p>
        </header>
        {errorText && (
          <p role="alert" className="text-sm text-destructive">
            {errorText}
          </p>
        )}
        {success && (
          <p role="status" className="text-sm text-foreground">
            {success}
          </p>
        )}
        {!loaded ? (
          <p role="status" className="text-sm">
            جارٍ تحميل السياسة…
          </p>
        ) : (
          <>
            {policy !== null && (
              <p className="text-xs text-muted-foreground">
                الحالة:{' '}
                {policy.status === 'active'
                  ? 'نشط'
                  : policy.status === 'paused'
                    ? 'متوقف'
                    : 'مسودة'}{' '}
                · المراجعة: <bdi>{policy.revision}</bdi>
              </p>
            )}
            <form
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={(event) => void savePolicy(event)}
            >
              <label className="space-y-1 text-sm sm:col-span-2">
                <span>اسم البرنامج</span>
                <input
                  aria-label="اسم برنامج الولاء"
                  className={fieldClass}
                  value={draft.nameAr}
                  disabled={busy}
                  maxLength={120}
                  onChange={(event) => setDraft((p) => ({ ...p, nameAr: event.target.value }))}
                  required
                />
              </label>
              {(
                [
                  ['earnNumerator', 'بسط نقاط الاكتساب'],
                  ['earnDenominator', 'عدد الهللات لكل وحدة احتساب'],
                  ['redeemValueMinorPerPoint', 'قيمة النقطة عند الاستبدال (هللة)'],
                ] as const
              ).map(([key, label]) => (
                <label className="space-y-1 text-sm" key={key}>
                  <span>{label}</span>
                  <input
                    aria-label={label}
                    className={fieldClass}
                    inputMode="numeric"
                    dir="ltr"
                    value={draft[key]}
                    disabled={busy || policy?.status === 'active'}
                    pattern="[1-9][0-9]*"
                    required
                    onChange={(event) => setDraft((p) => ({ ...p, [key]: event.target.value }))}
                  />
                </label>
              ))}
              <div className="flex flex-wrap items-end gap-2">
                <Button type="submit" disabled={busy}>
                  {policy === null ? 'إنشاء المسودة' : 'حفظ السياسة'}
                </Button>
                {policy !== null && policy.status !== 'active' && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void setStatus('active')}
                  >
                    تفعيل
                  </Button>
                )}
                {policy?.status === 'active' && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void setStatus('paused')}
                  >
                    إيقاف مؤقت
                  </Button>
                )}
              </div>
            </form>
          </>
        )}
      </CardSurface>

      <CardSurface className="space-y-4 p-5">
        <h2 className="text-lg font-semibold">اشتراكات العملاء وسجل النقاط</h2>
        <form className="flex flex-wrap gap-2" onSubmit={(event) => void searchCustomers(event)}>
          <input
            aria-label="البحث عن عميل"
            className={`${fieldClass} min-w-52 flex-1`}
            placeholder="الاسم أو رقم الجوال"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
          />
          <Button type="submit" disabled={searching}>
            {searching ? 'جارٍ البحث…' : 'بحث'}
          </Button>
        </form>
        <div className="flex flex-wrap gap-2">
          {customers.map((customer) => (
            <button
              type="button"
              key={customer.id}
              onClick={() => void selectCustomer(customer)}
              className="rounded-md border border-input px-3 py-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              aria-pressed={selected?.id === customer.id}
            >
              {customer.nameAr} {customer.phone === null ? '' : `· ${customer.phone}`}
            </button>
          ))}
        </div>
        {selected !== null && (
          <section className="space-y-3 rounded-lg border border-border p-4">
            <h3 className="font-medium">{selected.nameAr}</h3>
            {ledger === null ? (
              <p role="status" className="text-sm">
                جارٍ تحميل السجل…
              </p>
            ) : (
              <>
                <p>
                  الرصيد المسجل: <strong dir="ltr">{ledger.balancePoints}</strong> نقطة
                </p>
                {!ledger.enrolled && (
                  <div className="space-y-3">
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={consent}
                        onChange={(event) => setConsent(event.target.checked)}
                      />
                      <span>أؤكد أن العميل وافق صراحة على الانضمام لبرنامج الولاء.</span>
                    </label>
                    <Button
                      disabled={!consent || busy || policy?.status !== 'active'}
                      onClick={() => void enroll()}
                    >
                      تسجيل الاشتراك
                    </Button>
                  </div>
                )}
                {ledger.entries.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    لا توجد حركات نقاط مسجلة لهذا العميل.
                  </p>
                ) : (
                  <ul className="space-y-2 text-sm">
                    {ledger.entries.map((entry) => (
                      <li
                        key={entry.id}
                        className="flex justify-between gap-3 border-b border-border py-2"
                      >
                        <span>
                          {entry.kind} · {new Date(entry.occurredAt).toLocaleString('ar-SA')}
                        </span>
                        <bdi dir="ltr">{entry.pointsDelta}</bdi>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        )}
      </CardSurface>
    </div>
  );
}
