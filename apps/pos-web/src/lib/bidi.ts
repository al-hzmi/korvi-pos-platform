/**
 * Isolate machine-readable LTR text when it must live inside an Arabic string.
 *
 * Native `<option>` elements and accessible names cannot contain Korvi's
 * `BidiIsolate` component. Unicode LRI/PDI provides the same visual and spoken
 * boundary while the option value and every request field remain untouched.
 */
export function isolateLtrText(value: string): string {
  return `\u2066${value}\u2069`;
}
