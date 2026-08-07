/**
 * Join class names, dropping anything falsy.
 *
 * Deliberately not clsx: this is the whole of what the codebase uses, and a
 * dependency that exists to concatenate strings is a dependency to audit.
 */
export function cn(...values: readonly (string | false | null | undefined)[]): string {
  return values
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' ');
}
