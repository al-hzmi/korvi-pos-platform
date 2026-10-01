import { DomainError, InvalidAmountError } from '../errors.js';

const MAX_SELECTIONS_PER_GROUP = 32;
const MAX_MONEY_MINOR = 9_223_372_036_854_775_807n;

export interface RestaurantModifierOptionPolicy {
  readonly optionId: string;
  readonly revision: bigint;
  readonly code: string;
  readonly nameAr: string;
  readonly priceDeltaMinor: bigint;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface RestaurantModifierGroupPolicy {
  readonly groupId: string;
  readonly revision: bigint;
  readonly code: string;
  readonly nameAr: string;
  readonly minSelections: number;
  readonly maxSelections: number;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly options: readonly RestaurantModifierOptionPolicy[];
}

export interface RestaurantModifierSelectionSnapshot {
  readonly groupId: string;
  readonly groupRevision: bigint;
  readonly groupCode: string;
  readonly groupNameAr: string;
  readonly groupSortOrder: number;
  readonly optionId: string;
  readonly optionRevision: bigint;
  readonly optionCode: string;
  readonly optionNameAr: string;
  readonly optionSortOrder: number;
  readonly priceDeltaMinor: bigint;
}

export interface RestaurantModifierResolution {
  readonly baseUnitPriceMinor: bigint;
  readonly modifierTotalMinor: bigint;
  readonly unitPriceMinor: bigint;
  readonly selections: readonly RestaurantModifierSelectionSnapshot[];
}

export class InvalidRestaurantModifierDefinitionError extends DomainError {
  public override readonly name = 'InvalidRestaurantModifierDefinitionError';
}

export class InvalidRestaurantModifierSelectionError extends DomainError {
  public override readonly name = 'InvalidRestaurantModifierSelectionError';
}

function assertSafeOrder(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidRestaurantModifierDefinitionError(
      `${label} must be a non-negative safe integer.`,
    );
  }
}

function validatePolicy(groups: readonly RestaurantModifierGroupPolicy[]): void {
  const groupIds = new Set<string>();
  const optionIds = new Set<string>();

  for (const group of groups) {
    if (groupIds.has(group.groupId)) {
      throw new InvalidRestaurantModifierDefinitionError('Modifier group ids must be unique.');
    }
    groupIds.add(group.groupId);

    if (group.revision <= 0n) {
      throw new InvalidRestaurantModifierDefinitionError(
        'Modifier group revision must be positive.',
      );
    }
    if (
      !Number.isSafeInteger(group.minSelections) ||
      !Number.isSafeInteger(group.maxSelections) ||
      group.minSelections < 0 ||
      group.maxSelections < 1 ||
      group.maxSelections > MAX_SELECTIONS_PER_GROUP ||
      group.minSelections > group.maxSelections
    ) {
      throw new InvalidRestaurantModifierDefinitionError(
        'Modifier group selection bounds are invalid.',
      );
    }
    assertSafeOrder(group.sortOrder, 'Modifier group sort order');

    for (const option of group.options) {
      if (optionIds.has(option.optionId)) {
        throw new InvalidRestaurantModifierDefinitionError(
          'Modifier option ids must be globally unique.',
        );
      }
      optionIds.add(option.optionId);
      if (option.revision <= 0n) {
        throw new InvalidRestaurantModifierDefinitionError(
          'Modifier option revision must be positive.',
        );
      }
      if (option.priceDeltaMinor < 0n || option.priceDeltaMinor > MAX_MONEY_MINOR) {
        throw new InvalidRestaurantModifierDefinitionError(
          'Modifier option price delta must be a non-negative BIGINT minor amount.',
        );
      }
      assertSafeOrder(option.sortOrder, 'Modifier option sort order');
    }
  }
}

function selectionOrder(
  left: RestaurantModifierSelectionSnapshot,
  right: RestaurantModifierSelectionSnapshot,
): number {
  if (left.groupSortOrder !== right.groupSortOrder) {
    return left.groupSortOrder - right.groupSortOrder;
  }
  const groupId = left.groupId.localeCompare(right.groupId);
  if (groupId !== 0) return groupId;
  if (left.optionSortOrder !== right.optionSortOrder) {
    return left.optionSortOrder - right.optionSortOrder;
  }
  return left.optionId.localeCompare(right.optionId);
}

/**
 * Resolve already-loaded restaurant modifier policy into one immutable line snapshot.
 *
 * Persistence owns which groups are attached to the product. This pure function owns
 * deterministic validation and arithmetic only; the caller persists its returned snapshots.
 */
export function resolveRestaurantModifiers(input: {
  readonly baseUnitPriceMinor: bigint;
  readonly groups: readonly RestaurantModifierGroupPolicy[];
  readonly selectedOptionIds: readonly string[];
}): RestaurantModifierResolution {
  if (input.baseUnitPriceMinor < 0n || input.baseUnitPriceMinor > MAX_MONEY_MINOR) {
    throw new InvalidAmountError('Restaurant base unit price is outside BIGINT money bounds.');
  }
  validatePolicy(input.groups);

  if (new Set(input.selectedOptionIds).size !== input.selectedOptionIds.length) {
    throw new InvalidRestaurantModifierSelectionError('Modifier option selections must be unique.');
  }

  const selected = new Set(input.selectedOptionIds);
  const known = new Set<string>();
  const snapshots: RestaurantModifierSelectionSnapshot[] = [];

  for (const group of input.groups) {
    if (!group.isActive) continue;

    const activeOptions = group.options.filter((option) => option.isActive);
    const chosen = activeOptions.filter((option) => selected.has(option.optionId));
    for (const option of chosen) known.add(option.optionId);

    if (chosen.length < group.minSelections || chosen.length > group.maxSelections) {
      throw new InvalidRestaurantModifierSelectionError(
        `Modifier group ${group.groupId} requires between ${String(group.minSelections)} and ${String(group.maxSelections)} selections.`,
      );
    }

    for (const option of chosen) {
      snapshots.push({
        groupId: group.groupId,
        groupRevision: group.revision,
        groupCode: group.code,
        groupNameAr: group.nameAr,
        groupSortOrder: group.sortOrder,
        optionId: option.optionId,
        optionRevision: option.revision,
        optionCode: option.code,
        optionNameAr: option.nameAr,
        optionSortOrder: option.sortOrder,
        priceDeltaMinor: option.priceDeltaMinor,
      });
    }
  }

  if (known.size !== selected.size) {
    throw new InvalidRestaurantModifierSelectionError(
      'A selected modifier option is unknown, inactive or not attached to this product.',
    );
  }

  snapshots.sort(selectionOrder);
  const modifierTotalMinor = snapshots.reduce((sum, selection) => {
    const next = sum + selection.priceDeltaMinor;
    if (next > MAX_MONEY_MINOR) {
      throw new InvalidAmountError('Restaurant modifier total exceeds BIGINT money bounds.');
    }
    return next;
  }, 0n);
  const unitPriceMinor = input.baseUnitPriceMinor + modifierTotalMinor;
  if (unitPriceMinor > MAX_MONEY_MINOR) {
    throw new InvalidAmountError('Restaurant modified unit price exceeds BIGINT money bounds.');
  }

  return {
    baseUnitPriceMinor: input.baseUnitPriceMinor,
    modifierTotalMinor,
    unitPriceMinor,
    selections: snapshots,
  };
}
