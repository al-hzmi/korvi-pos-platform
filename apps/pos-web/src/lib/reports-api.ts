import { ApiError } from './api';

export interface ReportTotals {
  readonly documentCount: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
}

export interface ReportBranch {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly isActive: boolean;
}

export interface ReportBranchBreakdown extends ReportBranch {
  readonly sales: ReportTotals;
  readonly returns: ReportTotals;
  readonly netAfterReturns: Omit<ReportTotals, 'documentCount'>;
}

export interface ReportVatBucket {
  readonly vatBasisPoints: number;
  readonly salesNetMinor: string;
  readonly salesVatMinor: string;
  readonly returnsNetMinor: string;
  readonly returnsVatMinor: string;
  readonly netTaxableMinor: string;
  readonly netVatMinor: string;
}

export interface PeriodReport {
  readonly fromInclusive: string;
  readonly toExclusive: string;
  readonly branchId: string | null;
  readonly currency: string;
  readonly sales: ReportTotals;
  readonly returns: ReportTotals;
  readonly netAfterReturns: Omit<ReportTotals, 'documentCount'>;
  readonly vatBreakdown: readonly ReportVatBucket[];
  readonly availableBranches: readonly ReportBranch[];
  readonly branchBreakdown: readonly ReportBranchBreakdown[];
}

export interface ReportsApi {
  period(
    query: { readonly from: string; readonly to: string; readonly branchId?: string },
    options?: { readonly signal?: AbortSignal },
  ): Promise<PeriodReport>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function errorFrom(body: unknown, status: number): ApiError {
  if (body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const code = typeof record['error'] === 'string' ? record['error'] : `http_${String(status)}`;
    const message = typeof record['message'] === 'string' ? record['message'] : null;
    return new ApiError(status, code, message);
  }
  return new ApiError(status, `http_${String(status)}`, null);
}

export function createReportsApi(fetchImpl?: Fetch): ReportsApi {
  return {
    async period(query, options) {
      const params = new URLSearchParams({ from: query.from, to: query.to });
      if (query.branchId !== undefined && query.branchId !== '') {
        params.set('branchId', query.branchId);
      }
      const call: Fetch =
        fetchImpl ?? ((input, requestInit) => globalThis.fetch(input, requestInit));
      let response: Response;
      try {
        response = await call(`/v1/admin/reports/period?${params.toString()}`, {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        throw new ApiError(0, 'network', null);
      }

      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw errorFrom(body, response.status);
      return body as PeriodReport;
    },
  };
}

/** Saudi Arabia has no DST; financial date inputs therefore map to fixed +03:00 boundaries. */
export function saudiDayStart(date: string): string {
  return `${date}T00:00:00+03:00`;
}

export function nextCivilDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return date;
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

export function saudiToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function saudiMonthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function basisPointsLabel(value: number): string {
  const whole = Math.trunc(value / 100);
  const fraction = Math.abs(value % 100);
  return fraction === 0
    ? `${String(whole)}%`
    : `${String(whole)}.${String(fraction).padStart(2, '0')}%`;
}
