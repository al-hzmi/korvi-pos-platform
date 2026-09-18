'use client';

import { Button } from '@korvi/ui';
import { restaurantOrderTypeLabelAr } from '../lib/quick-service';
import type { RestaurantOrderType } from '@korvi/domain';
import type { JSX } from 'react';

const ORDER_TYPES: readonly RestaurantOrderType[] = ['dine-in', 'takeaway', 'delivery'];

export interface RestaurantOrderTypeControlProps {
  readonly value: RestaurantOrderType;
  readonly disabled: boolean;
  readonly onChange: (value: RestaurantOrderType) => void;
}

/** Operational only: never pricing, VAT, settlement or fiscal authority. */
export function RestaurantOrderTypeControl({
  value,
  disabled,
  onChange,
}: RestaurantOrderTypeControlProps): JSX.Element {
  return (
    <fieldset className="mb-3 rounded-lg border border-border bg-muted/30 p-3">
      <legend className="px-1 text-xs font-semibold text-muted-foreground">نوع الطلب</legend>
      <div className="grid grid-cols-3 gap-2">
        {ORDER_TYPES.map((orderType) => (
          <Button
            key={orderType}
            type="button"
            variant={value === orderType ? 'secondary' : 'outline'}
            size="md"
            aria-pressed={value === orderType}
            disabled={disabled}
            onClick={() => onChange(orderType)}
          >
            {restaurantOrderTypeLabelAr(orderType)}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}
