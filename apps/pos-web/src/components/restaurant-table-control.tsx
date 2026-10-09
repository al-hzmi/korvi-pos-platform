'use client';

import { Button } from '@korvi/ui';
import { StatusNote } from './status-note';
import type { RestaurantFloorResponse } from '../lib/api-types';
import type { JSX } from 'react';

export interface RestaurantTableControlProps {
  readonly floor: RestaurantFloorResponse | null;
  readonly status: 'loading' | 'ready' | 'failed';
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onChange: (tableId: string) => void;
}

/**
 * Operational floor selector. The server still proves tenant, branch, active
 * state and dine-in applicability at checkout; these buttons only choose the
 * table id that becomes part of the immutable intent.
 */
export function RestaurantTableControl({
  floor,
  status,
  value,
  disabled,
  onChange,
}: RestaurantTableControlProps): JSX.Element {
  if (status === 'loading' && floor === null) {
    return (
      <StatusNote tone="info" className="mb-3" live>
        جاري تحميل مخطط الطاولات…
      </StatusNote>
    );
  }

  if (status === 'failed' && floor === null) {
    return (
      <StatusNote tone={value === null ? 'warning' : 'info'} className="mb-3" live>
        {value === null
          ? 'تعذّر تحميل مخطط الطاولات. أعد الاتصال قبل بدء طلب محلي جديد.'
          : 'تعذّر تحديث مخطط الطاولات. ستبقى الطاولة المحفوظة مرتبطة بهذه العملية.'}
      </StatusNote>
    );
  }

  if (floor === null || floor.tables.length === 0) {
    return (
      <StatusNote tone="warning" className="mb-3">
        لا توجد طاولات فعّالة في هذا الفرع.
      </StatusNote>
    );
  }

  return (
    <fieldset className="mb-3 rounded-lg border border-border bg-muted/30 p-3">
      <legend className="px-1 text-xs font-semibold text-muted-foreground">الطاولة</legend>
      <div className="flex max-h-56 flex-col gap-3 overflow-y-auto">
        {floor.zones.map((zone) => {
          const tables = floor.tables.filter((table) => table.zoneId === zone.id);
          if (tables.length === 0) return null;
          return (
            <div key={zone.id}>
              <p className="mb-2 text-xs font-semibold text-muted-foreground">{zone.nameAr}</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {tables.map((table) => (
                  <Button
                    key={table.id}
                    type="button"
                    variant={value === table.id ? 'secondary' : 'outline'}
                    size="md"
                    className="min-h-touch flex-col gap-0.5"
                    aria-pressed={value === table.id}
                    disabled={disabled}
                    onClick={() => onChange(table.id)}
                  >
                    <span>{table.nameAr}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {table.capacity === null ? table.code : `${table.code} · ${table.capacity}`}
                    </span>
                  </Button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
