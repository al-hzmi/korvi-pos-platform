'use client';

import { useEffect, useState } from 'react';
import { Button } from '@korvi/ui';
import { StatusNote } from './status-note';
import type { ActiveRestaurantOrder } from '../lib/restaurant-orders';
import type {
  RestaurantFloorTable,
  RestaurantOrderDetail,
  RestaurantOrderSummary,
} from '../lib/api-types';
import type { JSX } from 'react';

export interface RestaurantOpenOrdersControlProps {
  readonly orders: readonly RestaurantOrderSummary[];
  readonly listStatus: 'loading' | 'ready' | 'failed';
  readonly activeIdentity: ActiveRestaurantOrder | null;
  readonly activeOrder: RestaurantOrderDetail | null;
  readonly dirty: boolean;
  readonly cartHasLines: boolean;
  readonly locked: boolean;
  readonly commandStatus: 'idle' | 'running' | 'ambiguous';
  readonly notice: string | null;
  readonly holdBlocker: string | null;
  readonly tables: readonly RestaurantFloorTable[];
  readonly canCancel: boolean;
  readonly onRefresh: () => void;
  readonly onResume: (orderId: string) => void;
  readonly onHold: () => void;
  readonly onSave: () => void;
  readonly onRelease: () => void;
  readonly onTransferTable: (tableId: string) => void;
  readonly onCancel: (reason: string) => void;
  readonly onRetry: () => void;
}

function orderLabel(order: RestaurantOrderSummary): string {
  if (order.tableNameAr !== null) return order.tableNameAr;
  if (order.orderType === 'delivery') return 'توصيل';
  if (order.orderType === 'takeaway') return 'سفري';
  return 'طلب محلي';
}

export function RestaurantOpenOrdersControl({
  orders,
  listStatus,
  activeIdentity,
  activeOrder,
  dirty,
  cartHasLines,
  locked,
  commandStatus,
  notice,
  holdBlocker,
  tables,
  canCancel,
  onRefresh,
  onResume,
  onHold,
  onSave,
  onRelease,
  onTransferTable,
  onCancel,
  onRetry,
}: RestaurantOpenOrdersControlProps): JSX.Element {
  const active = activeIdentity !== null;
  const ambiguous = commandStatus === 'ambiguous';
  const [transferTableId, setTransferTableId] = useState('');
  const [cancelReason, setCancelReason] = useState('');

  useEffect(() => {
    setTransferTableId('');
    setCancelReason('');
  }, [activeIdentity?.id, activeIdentity?.revision]);

  return (
    <section
      className="mb-3 rounded-lg border border-border bg-muted/25 p-3"
      aria-label="الطلبات المفتوحة"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-foreground">الطلبات المفتوحة</p>
          <p className="text-xs text-muted-foreground">
            {active
              ? 'الطلب المستأنف يبقى غير مالي حتى إتمام البيع.'
              : `${orders.length} طلب مفتوح`}
          </p>
        </div>
        <Button variant="ghost" size="sm" disabled={locked} onClick={onRefresh}>
          تحديث
        </Button>
      </div>

      {notice === null ? null : (
        <StatusNote tone={ambiguous ? 'warning' : 'info'} className="mt-3" live>
          {notice}
        </StatusNote>
      )}

      {ambiguous ? (
        <Button className="mt-3 w-full" variant="outline" onClick={onRetry}>
          إعادة نفس عملية الحفظ
        </Button>
      ) : null}

      {activeIdentity !== null ? (
        <div className="mt-3 rounded-md border border-border bg-background p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold">
                {activeOrder === null ? 'جاري التحقق من الطلب…' : orderLabel(activeOrder)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                النسخة {activeIdentity.revision}
                {dirty ? ' · تعديلات غير محفوظة' : ' · محفوظ'}
              </p>
            </div>
            <span className="rounded-md bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
              مستأنف
            </span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button
              variant="secondary"
              disabled={locked || activeOrder === null || !dirty || !cartHasLines}
              onClick={onSave}
            >
              حفظ التعديلات
            </Button>
            <Button
              variant="outline"
              disabled={locked || activeOrder === null || dirty}
              onClick={onRelease}
            >
              ترك الطلب مفتوحاً
            </Button>
          </div>

          {activeOrder?.orderType === 'dine-in' ? (
            <div className="mt-3 rounded-md border border-border bg-muted/30 p-3">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="transfer-table">
                نقل الطلب إلى طاولة
              </label>
              <div className="mt-2 flex gap-2">
                <select
                  id="transfer-table"
                  value={transferTableId}
                  disabled={locked || dirty}
                  onChange={(event) => {
                    setTransferTableId(event.target.value);
                  }}
                  className="h-touch min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                >
                  <option value="">اختر الطاولة الجديدة</option>
                  {tables
                    .filter((table) => table.id !== activeOrder.tableId)
                    .map((table) => (
                      <option key={table.id} value={table.id}>
                        {table.nameAr} · {table.code}
                      </option>
                    ))}
                </select>
                <Button
                  variant="outline"
                  disabled={locked || dirty || transferTableId === ''}
                  onClick={() => {
                    onTransferTable(transferTableId);
                  }}
                >
                  نقل
                </Button>
              </div>
              {dirty ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  احفظ تعديلات الأصناف قبل نقل الطاولة.
                </p>
              ) : null}
            </div>
          ) : null}

          {canCancel ? (
            <div className="mt-3 rounded-md border border-destructive/25 bg-destructive/5 p-3">
              <label
                className="text-xs font-medium text-muted-foreground"
                htmlFor="cancel-order-reason"
              >
                سبب إلغاء الطلب
              </label>
              <div className="mt-2 flex gap-2">
                <input
                  id="cancel-order-reason"
                  value={cancelReason}
                  maxLength={200}
                  disabled={locked || dirty}
                  placeholder="مثال: طلب العميل الإلغاء"
                  onChange={(event) => {
                    setCancelReason(event.target.value);
                  }}
                  className="h-touch min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
                />
                <Button
                  variant="destructive"
                  disabled={locked || dirty || cancelReason.trim() === ''}
                  onClick={() => {
                    onCancel(cancelReason.trim());
                  }}
                >
                  إلغاء الطلب
                </Button>
              </div>
              {dirty ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  احفظ التعديلات أو تراجع عنها قبل الإلغاء.
                </p>
              ) : null}
            </div>
          ) : null}

          {!cartHasLines ? (
            <p className="mt-2 text-xs text-destructive">
              لا يمكن حفظ طلب مفتوح بلا أصناف. أعد صنفاً أو استخدم إجراء الإلغاء المصرح.
            </p>
          ) : null}
        </div>
      ) : (
        <>
          {cartHasLines ? (
            <div className="mt-3">
              <Button
                className="w-full"
                variant="secondary"
                disabled={locked || holdBlocker !== null}
                onClick={onHold}
              >
                حفظ كطلب مفتوح
              </Button>
              {holdBlocker === null ? null : (
                <p className="mt-2 text-xs text-muted-foreground">{holdBlocker}</p>
              )}
            </div>
          ) : null}

          <div className="mt-3 max-h-40 space-y-2 overflow-y-auto">
            {listStatus === 'loading' ? (
              <p className="text-xs text-muted-foreground">جاري تحميل الطلبات…</p>
            ) : listStatus === 'failed' ? (
              <StatusNote tone="warning">تعذّر تحميل الطلبات المفتوحة.</StatusNote>
            ) : orders.length === 0 ? (
              <p className="text-xs text-muted-foreground">لا توجد طلبات مفتوحة في هذا الفرع.</p>
            ) : (
              orders.slice(0, 20).map((order) => (
                <Button
                  key={order.id}
                  variant="outline"
                  size="sm"
                  className="flex w-full justify-between"
                  disabled={locked || cartHasLines}
                  onClick={() => {
                    onResume(order.id);
                  }}
                >
                  <span>{orderLabel(order)}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {order.lineCount} {order.lineCount === 1 ? 'صنف' : 'أصناف'} · نسخة{' '}
                    {order.revision}
                  </span>
                </Button>
              ))
            )}
          </div>
          {cartHasLines && orders.length > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              احفظ السلة الحالية أو أفرغها قبل استئناف طلب آخر.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
