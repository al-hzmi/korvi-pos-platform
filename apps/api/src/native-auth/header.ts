const NATIVE_AUTHORIZATION_PATTERN = /^KorviNative ([A-Za-z0-9._-]{1,200})$/;

export function readNativeAuthorization(
  value: string | readonly string[] | undefined,
): string | null {
  if (typeof value !== 'string') return null;
  const match = NATIVE_AUTHORIZATION_PATTERN.exec(value);
  return match?.[1] ?? null;
}
