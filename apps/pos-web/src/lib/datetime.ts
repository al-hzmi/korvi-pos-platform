/**
 * A timestamp a cashier can read.
 *
 * The server sends ISO 8601, which is the right thing to send and the wrong
 * thing to show: `2026-08-12T07:00:00.000Z` on a receipt is an implementation
 * detail printed at a customer.
 *
 * Fixed locale and fixed time zone, deliberately. A till in Riyadh shows
 * Riyadh time whatever the machine's clock is set to, and the same string is
 * produced on the server and in the browser — a value that formatted
 * differently in the two would be a hydration mismatch on every receipt.
 * Gregorian with Latin digits, matching the rest of the numeric typography.
 */
const FORMAT = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
  timeZone: 'Asia/Riyadh',
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatTimestamp(iso: string): string {
  const at = new Date(iso);
  // An unparseable date is not worth throwing over on a receipt; showing what
  // arrived is more useful than an empty line.
  return Number.isNaN(at.getTime()) ? iso : FORMAT.format(at);
}
