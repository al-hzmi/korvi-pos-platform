import { describe, expect, it, vi } from 'vitest';
import {
  basisPointsLabel,
  createReportsApi,
  nextCivilDate,
  saudiDayStart,
  saudiMonthStart,
  saudiToday,
} from '../reports-api';

const payload = {
  fromInclusive: '2026-08-31T21:00:00.000Z',
  toExclusive: '2026-09-30T21:00:00.000Z',
  branchId: null,
  currency: 'SAR',
  sales: { documentCount: '1', netMinor: '10000', vatMinor: '1500', totalMinor: '11500' },
  returns: { documentCount: '0', netMinor: '0', vatMinor: '0', totalMinor: '0' },
  netAfterReturns: { netMinor: '10000', vatMinor: '1500', totalMinor: '11500' },
  vatBreakdown: [],
  availableBranches: [],
  branchBreakdown: [],
};

describe('merchant reports API', () => {
  it('sends explicit offset-aware boundaries and never invents tenant authority', async () => {
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) =>
      new Response(JSON.stringify(payload), { status: 200 }),
    );
    const api = createReportsApi(fetchImpl);

    await api.period({
      from: '2026-09-01T00:00:00+03:00',
      to: '2026-10-01T00:00:00+03:00',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain('/v1/admin/reports/period?');
    expect(url).toContain('from=2026-09-01T00%3A00%3A00%2B03%3A00');
    expect(url).toContain('to=2026-10-01T00%3A00%3A00%2B03%3A00');
    expect(url).not.toContain('tenant');
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin' });
  });

  it('maps Saudi civil dates without using the browser local timezone', () => {
    expect(saudiDayStart('2026-09-14')).toBe('2026-09-14T00:00:00+03:00');
    expect(nextCivilDate('2026-09-30')).toBe('2026-10-01');
    expect(nextCivilDate('2026-12-31')).toBe('2027-01-01');
    expect(saudiMonthStart('2026-09-14')).toBe('2026-09-01');
    expect(saudiToday(new Date('2026-09-14T21:30:00.000Z'))).toBe('2026-09-15');
  });

  it('renders basis points without floating-point tax arithmetic', () => {
    expect(basisPointsLabel(1500)).toBe('15%');
    expect(basisPointsLabel(525)).toBe('5.25%');
    expect(basisPointsLabel(0)).toBe('0%');
  });
});
