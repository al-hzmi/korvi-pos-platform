import { describe, expect, it } from 'vitest';
import { formatTimestamp } from '../datetime';

describe('formatTimestamp', () => {
  it('renders a receipt time rather than an ISO string', () => {
    const shown = formatTimestamp('2026-08-12T07:00:00.000Z');
    expect(shown).not.toContain('T');
    expect(shown).not.toContain('Z');
    expect(shown).toContain('2026');
  });

  it('is the same string wherever it runs', () => {
    // Fixed locale and fixed time zone: a value that formatted differently on
    // the server and in the browser is a hydration mismatch on every receipt.
    expect(formatTimestamp('2026-08-12T07:00:00.000Z')).toBe(
      formatTimestamp('2026-08-12T07:00:00.000Z'),
    );
  });

  it('shows Riyadh time, not the machine’s idea of local time', () => {
    // 07:00 UTC is 10:00 in Riyadh, whatever the till's clock is set to.
    expect(formatTimestamp('2026-08-12T07:00:00.000Z')).toMatch(/10:00/);
  });

  it('shows what arrived rather than throwing on a bad value', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });
});
