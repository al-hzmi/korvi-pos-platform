import { ApiError } from './api';

export type MerchantSaleStatus = 'finalized' | 'voided';

export interface MerchantSalesQuery {
  readonly search?: string;
  readonly status?: MerchantSaleStatus;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface MerchantSaleSummary {
  readonly id: string;
  readonly invoiceNumber: string | null;
  readonly status: MerchantSaleStatus;
  readonly sequence: number;
  readonly branch: { readonly id: string; readonly code: string; readonly nameAr: string };
  readonly terminal: { readonly id: string; readonly code: string; readonly label: string };
  readonly cashier: { readonly id: string; readonly displayName: string };
  readonly customer: { readonly id: string; readonly nameAr: string } | null;
  readonly currency: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly tenderKinds: readonly string[];
  readonly issuedAt: string;
}

export interface MerchantSalesPage {
  readonly items: readonly MerchantSaleSummary[];
  readonly nextCursor: string | null;
}

export interface MerchantSaleDetail {
  readonly id: string;
  readonly operationId: string;
  readonly invoiceNumber: string | null;
  readonly invoiceType: string | null;
  readonly status: MerchantSaleStatus;
  readonly sequence: number;
  readonly priceMode: string;
  readonly branch: { readonly id: string; readonly code: string; readonly nameAr: string };
  readonly terminal: { readonly id: string; readonly code: string; readonly label: string };
  readonly cashier: { readonly id: string; readonly displayName: string; readonly email: string };
  readonly customer: {
    readonly id: string;
    readonly nameAr: string;
    readonly phone: string | null;
    readonly vatNumber: string | null;
  } | null;
  readonly currency: string;
  readonly grossMinor: string;
  readonly lineDiscountMinor: string;
  readonly basketDiscountMinor: string;
  readonly tenderedMinor: string;
  readonly changeMinor: string;
  readonly lines: readonly {
    readonly id: string;
    readonly lineNumber: number;
    readonly productId: string | null;
    readonly sku: string;
    readonly nameAr: string;
    readonly nameEn: string | null;
    readonly productType: string | null;
    readonly unitPriceMinor: string;
    readonly vatBasisPoints: number;
    readonly quantityScaled: string;
    readonly grossMinor: string;
    readonly lineDiscountMinor: string;
    readonly basketDiscountMinor: string;
    readonly netMinor: string;
    readonly vatMinor: string;
    readonly totalMinor: string;
  }[];
  readonly tenders: readonly {
    readonly id: string;
    readonly kind: string;
    readonly scheme: string | null;
    readonly amountMinor: string;
    readonly changeMinor: string;
    readonly reference: string | null;
  }[];
  readonly invoice: {
    readonly id: string;
    readonly invoiceNumber: string;
    readonly invoiceType: string;
    readonly sellerName: string;
    readonly sellerVatNumber: string;
    readonly buyerName: string | null;
    readonly buyerVatNumber: string | null;
    readonly netMinor: string;
    readonly vatMinor: string;
    readonly totalMinor: string;
    readonly currency: string;
    readonly issuedAt: string;
    readonly taxBreakdown: readonly {
      readonly vatBasisPoints: number;
      readonly netMinor: string;
      readonly vatMinor: string;
    }[];
  } | null;
  readonly returns: readonly {
    readonly id: string;
    readonly returnNumber: string | null;
    readonly status: string;
    readonly reason: string | null;
    readonly totalMinor: string;
    readonly vatMinor: string;
    readonly issuedAt: string;
  }[];
}

export interface MerchantSalesApi {
  list(
    query?: MerchantSalesQuery,
    options?: { readonly signal?: AbortSignal },
  ): Promise<MerchantSalesPage>;
  detail(saleId: string, options?: { readonly signal?: AbortSignal }): Promise<MerchantSaleDetail>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function queryString(query: MerchantSalesQuery): string {
  const params = new URLSearchParams();
  if (query.search !== undefined && query.search !== '') params.set('search', query.search);
  if (query.status !== undefined) params.set('status', query.status);
  if (query.from !== undefined) params.set('from', query.from);
  if (query.to !== undefined) params.set('to', query.to);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const value = params.toString();
  return value === '' ? '' : `?${value}`;
}

function readError(body: unknown, status: number): ApiError {
  if (body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const code = typeof record['error'] === 'string' ? record['error'] : `http_${String(status)}`;
    const message = typeof record['message'] === 'string' ? record['message'] : null;
    return new ApiError(status, code, message);
  }
  return new ApiError(status, `http_${String(status)}`, null);
}

export function createMerchantSalesApi(fetchImpl?: Fetch): MerchantSalesApi {
  const call = async <T>(path: string, signal?: AbortSignal): Promise<T> => {
    const doFetch: Fetch =
      fetchImpl ?? ((input, requestInit) => globalThis.fetch(input, requestInit));
    let response: Response;
    try {
      response = await doFetch(path, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError(0, 'network', null);
    }

    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw readError(body, response.status);
    return body as T;
  };

  return {
    list(query = {}, options) {
      return call(`/v1/admin/sales${queryString(query)}`, options?.signal);
    },
    detail(saleId, options) {
      return call(`/v1/admin/sales/${encodeURIComponent(saleId)}`, options?.signal);
    },
  };
}
