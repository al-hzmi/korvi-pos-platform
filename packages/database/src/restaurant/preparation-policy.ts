export interface PreparationLockedLine {
  readonly id: string;
  readonly quantityScaled: string;
  readonly preparationNote: string | null;
  readonly preparationOptions: string | null;
}

export type PreparationReplacementLine =
  | {
      readonly lineId: string;
      readonly quantityScaled: string;
      readonly preparationNote: string | null;
      readonly preparationOptions: string | null;
    }
  | {
      readonly productId: string;
      readonly quantityScaled: string;
      readonly preparationNote: string | null;
      readonly preparationOptions: string | null;
    };

export interface PreparationRoutingPolicyLine {
  readonly lineId: string;
}

export interface PreparationRoutingPolicyGroup<TLine extends PreparationRoutingPolicyLine> {
  readonly lines: readonly TLine[];
}

/**
 * Once a line has been fired to preparation it is historical operational truth.
 * The line must remain at the same position with the same quantity/options.
 * Unfired lines remain editable/removable and new lines may be appended after
 * the immutable fired prefix.
 */
export function preparationReplacementPreservesFiredLines(
  existingLines: readonly PreparationLockedLine[],
  firedLineIds: ReadonlySet<string>,
  requestedLines: readonly PreparationReplacementLine[],
): boolean {
  if (firedLineIds.size === 0) return true;

  for (let index = 0; index < existingLines.length; index += 1) {
    const existing = existingLines[index]!;
    if (!firedLineIds.has(existing.id)) continue;

    const requested = requestedLines[index];
    if (requested === undefined || !('lineId' in requested) || requested.lineId !== existing.id) {
      return false;
    }
    if (
      requested.quantityScaled !== existing.quantityScaled ||
      requested.preparationNote !== existing.preparationNote ||
      requested.preparationOptions !== existing.preparationOptions
    ) {
      return false;
    }
  }

  return true;
}

export function pendingPreparationLines<TLine extends PreparationRoutingPolicyLine>(
  groups: readonly PreparationRoutingPolicyGroup<TLine>[],
  firedLineIds: ReadonlySet<string>,
): readonly TLine[] {
  return groups.flatMap((group) => group.lines.filter((line) => !firedLineIds.has(line.lineId)));
}

export function pendingUnroutedPreparationLines<TLine extends PreparationRoutingPolicyLine>(
  lines: readonly TLine[],
  firedLineIds: ReadonlySet<string>,
): readonly TLine[] {
  return lines.filter((line) => !firedLineIds.has(line.lineId));
}
