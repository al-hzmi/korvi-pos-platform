'use client';

import { useEffect, useState } from 'react';
import { Button } from '@korvi/ui';
import { createCustomersApi } from '../lib/customers-api';
import { createLoyaltyApi } from '../lib/loyalty-api';
import type { FormEvent, JSX } from 'react';
import type { CustomerSummary } from '../lib/customers-api';
import type { LoyaltyLedger } from '../lib/loyalty-api';

/** One selected existing customer identity, not a cashier-authored points amount. */
export function CustomerPicker({
  customerId,
  disabled,
  onChange,
}: {
  readonly customerId: string | null;
  readonly disabled: boolean;
  readonly onChange: (customerId: string | null) => void;
}): JSX.Element {
  const [term, setTerm] = useState('');
  const [items, setItems] = useState<readonly CustomerSummary[]>([]);
  const [selected, setSelected] = useState<CustomerSummary | null>(null);
  const [ledger, setLedger] = useState<LoyaltyLedger | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (customerId === null) {
      setSelected(null);
      setLedger(null);
      return;
    }
    let active = true;
    setLedger(null);
    void Promise.all([
      createCustomersApi().detail(customerId),
      createLoyaltyApi().ledger(customerId),
    ])
      .then(([customer, state]) => {
        if (!active) return;
        setSelected(customer);
        setLedger(state);
        setNotice(null);
      })
      .catch(() => {
        if (!active) return;
        setSelected(null);
        setNotice('تعذّر التحقق من العميل. أزل الاختيار أو أعد الاتصال قبل الدفع.');
      });
    return () => {
      active = false;
    };
  }, [customerId]);

  async function search(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoading(true);
    setNotice(null);
    try {
      const results = await createCustomersApi().list({ search: term.trim(), limit: 12 });
      setItems(results.items);
    } catch {
      setNotice('تعذّر البحث عن العملاء. يلزم اتصال بالخادم.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mb-3 space-y-3 rounded-lg border border-border bg-background p-3" dir="rtl">
      <div>
        <h3 className="text-sm font-semibold">العميل · نقاط الولاء</h3>
        <p className="text-xs text-muted-foreground">
          اختيار العميل يربط الفاتورة به. اكتساب النقاط يتم بعد اعتماد البيع، للمشتركين فقط.
        </p>
      </div>
      {notice !== null && (
        <p className="text-xs text-destructive" role="alert">
          {notice}
        </p>
      )}
      {customerId !== null ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 text-sm">
            <p className="font-semibold">{selected?.nameAr ?? 'جارٍ التحقق من العميل…'}</p>
            {ledger === null ? (
              <p className="text-xs text-muted-foreground">حالة النقاط غير مؤكدة</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {ledger.enrolled
                  ? `مشترك · الرصيد ${ledger.balancePoints} نقطة`
                  : 'غير مشترك ببرنامج الولاء'}
              </p>
            )}
          </div>
          <Button variant="secondary" disabled={disabled} onClick={() => onChange(null)}>
            إزالة العميل
          </Button>
        </div>
      ) : (
        <>
          <form className="flex gap-2" onSubmit={(event) => void search(event)}>
            <input
              aria-label="بحث العملاء في الكاشير"
              className="h-touch min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm text-foreground"
              placeholder="اسم العميل أو الجوال"
              value={term}
              disabled={disabled}
              onChange={(event) => setTerm(event.target.value)}
            />
            <Button type="submit" disabled={disabled || loading}>
              {loading ? 'بحث…' : 'بحث'}
            </Button>
          </form>
          {items.length > 0 && (
            <div className="max-h-36 space-y-1 overflow-y-auto">
              {items.map((customer) => (
                <button
                  type="button"
                  key={customer.id}
                  disabled={disabled || !customer.isActive}
                  className="block w-full rounded-md border border-input px-3 py-2 text-end text-sm hover:bg-accent disabled:opacity-50"
                  onClick={() => {
                    onChange(customer.id);
                    setItems([]);
                  }}
                >
                  {customer.nameAr} {customer.phone === null ? '' : `· ${customer.phone}`}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
