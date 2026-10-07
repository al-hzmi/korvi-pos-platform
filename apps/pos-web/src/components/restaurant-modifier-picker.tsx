'use client';

import { useMemo, useState } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { formatMinor } from '../lib/money';
import type { JSX } from 'react';
import type { ProductSummary, RestaurantModifierMenuGroup } from '../lib/api-types';

export interface RestaurantModifierPickerProps {
  readonly product: ProductSummary;
  readonly groups: readonly RestaurantModifierMenuGroup[];
  readonly disabled?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (selection: {
    readonly optionIds: readonly string[];
    readonly summary: string;
  }) => void;
}

export function RestaurantModifierPicker({
  product,
  groups,
  disabled = false,
  onCancel,
  onConfirm,
}: RestaurantModifierPickerProps): JSX.Element {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const optionById = useMemo(() => {
    const map = new Map<
      string,
      { readonly group: RestaurantModifierMenuGroup; readonly nameAr: string; readonly sort: number }
    >();
    for (const group of groups) {
      for (const option of group.options) {
        map.set(option.optionId, {
          group,
          nameAr: option.nameAr,
          sort: group.sortOrder * 1_000_000 + option.sortOrder,
        });
      }
    }
    return map;
  }, [groups]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const optionId of selected) {
      const entry = optionById.get(optionId);
      if (entry === undefined) continue;
      map.set(entry.group.groupId, (map.get(entry.group.groupId) ?? 0) + 1);
    }
    return map;
  }, [optionById, selected]);

  const valid = groups.every((group) => {
    const count = counts.get(group.groupId) ?? 0;
    return count >= group.minSelections && count <= group.maxSelections;
  });

  const toggle = (group: RestaurantModifierMenuGroup, optionId: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(optionId)) {
        next.delete(optionId);
        return next;
      }

      const groupIds = group.options.map((option) => option.optionId);
      const currentCount = groupIds.reduce((count, id) => count + (next.has(id) ? 1 : 0), 0);
      if (group.maxSelections === 1) {
        for (const id of groupIds) next.delete(id);
      } else if (currentCount >= group.maxSelections) {
        return current;
      }
      next.add(optionId);
      return next;
    });
  };

  const confirm = (): void => {
    if (!valid || disabled) return;
    const ordered = [...selected]
      .map((id) => ({ id, entry: optionById.get(id) }))
      .filter(
        (
          value,
        ): value is {
          readonly id: string;
          readonly entry: {
            readonly group: RestaurantModifierMenuGroup;
            readonly nameAr: string;
            readonly sort: number;
          };
        } => value.entry !== undefined,
      )
      .sort((left, right) => left.entry.sort - right.entry.sort);

    onConfirm({
      optionIds: ordered.map((value) => value.id),
      summary: ordered.map((value) => value.entry.nameAr).join(' · '),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`خيارات ${product.nameAr}`}
    >
      <CardSurface className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden border-border bg-card shadow-xl">
        <header className="border-b border-border px-5 py-4">
          <p className="text-xs font-medium text-muted-foreground">تخصيص الصنف</p>
          <h2 className="mt-1 text-lg font-bold text-foreground">{product.nameAr}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            السعر النهائي والضريبة يعيدان الحساب على الخادم عند التسعير والدفع.
          </p>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {groups.map((group) => {
            const count = counts.get(group.groupId) ?? 0;
            const groupValid = count >= group.minSelections && count <= group.maxSelections;
            return (
              <section key={group.groupId} className="rounded-lg border border-border p-3">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">{group.nameAr}</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {group.minSelections === group.maxSelections
                        ? `اختر ${String(group.minSelections)}`
                        : `اختر من ${String(group.minSelections)} إلى ${String(group.maxSelections)}`}
                    </p>
                  </div>
                  <span
                    className={
                      groupValid
                        ? 'rounded-md bg-primary/10 px-2 py-1 text-xs font-semibold text-primary'
                        : 'rounded-md bg-destructive/10 px-2 py-1 text-xs font-semibold text-destructive'
                    }
                  >
                    {count}/{group.maxSelections}
                  </span>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  {group.options.map((option) => {
                    const checked = selected.has(option.optionId);
                    return (
                      <button
                        key={option.optionId}
                        type="button"
                        disabled={disabled}
                        aria-pressed={checked}
                        onClick={() => toggle(group, option.optionId)}
                        className={
                          checked
                            ? 'flex min-h-12 items-center justify-between gap-3 rounded-lg border border-primary bg-primary/10 px-3 py-2 text-start'
                            : 'flex min-h-12 items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2 text-start hover:border-primary/50'
                        }
                      >
                        <span className="text-sm font-medium text-foreground">{option.nameAr}</span>
                        <span className="text-xs font-semibold text-muted-foreground" dir="ltr">
                          {BigInt(option.priceDeltaMinor) === 0n
                            ? 'بدون زيادة'
                            : `+${formatMinor(option.priceDeltaMinor)} ر.س`}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
          <Button variant="outline" disabled={disabled} onClick={onCancel}>
            إلغاء
          </Button>
          <Button disabled={!valid || disabled} onClick={confirm}>
            إضافة للسلة
          </Button>
        </footer>
      </CardSurface>
    </div>
  );
}
