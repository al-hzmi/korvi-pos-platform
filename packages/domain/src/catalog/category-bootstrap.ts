import { DomainError } from '../errors.js';

export const MAX_CATEGORY_NAME = 200;
export const MAX_CATEGORY_SORT_ORDER = 1_000_000;

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

export class CategoryBootstrapError extends DomainError {
  public override readonly name = 'CategoryBootstrapError';
}

export interface CategoryBootstrapDraft {
  readonly nameAr: string;
  readonly nameEn?: string | null | undefined;
  readonly sortOrder?: number | undefined;
}

export interface NormalizedCategoryBootstrap {
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly sortOrder: number;
}

export function normalizeCategoryName(value: string): string {
  const candidate = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (
    candidate === '' ||
    candidate.length > MAX_CATEGORY_NAME ||
    hasAsciiControlCharacter(candidate)
  ) {
    throw new CategoryBootstrapError('Invalid category name.');
  }
  return candidate;
}

export function normalizeOptionalCategoryName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const candidate = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (candidate === '') return null;
  return normalizeCategoryName(candidate);
}

export function normalizeCategoryBootstrap(
  draft: CategoryBootstrapDraft,
): NormalizedCategoryBootstrap {
  const sortOrder = draft.sortOrder ?? 0;
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > MAX_CATEGORY_SORT_ORDER) {
    throw new CategoryBootstrapError('Invalid category sort order.');
  }
  return {
    nameAr: normalizeCategoryName(draft.nameAr),
    nameEn: normalizeOptionalCategoryName(draft.nameEn),
    sortOrder,
  };
}
