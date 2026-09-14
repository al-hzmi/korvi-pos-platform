import { ApiError } from './api';

export const CUSTOMER_COMMAND_TIMEOUT_MS = 15_000;

export interface CustomerSummary {
  readonly id: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly vatNumber: string | null;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CustomerPage {
  readonly items: readonly CustomerSummary[];
  readonly nextCursor: string | null;
}

export interface CustomerSaleLink {
  readonly id: string;
  readonly invoiceNumber: string;
  readonly status: string;
  readonly issuedAt: string;
  readonly currency: string;
  readonly totalMinor: string;
}

export interface CustomerDetail {
  readonly customer: CustomerSummary;
  readonly salesCount: number;
  readonly recentSales: readonly CustomerSaleLink[];
}

export interface CustomerMutationResult {
  readonly customer: CustomerSummary;
  readonly replayed: boolean;
}

export interface CustomerCreateInput {
  readonly operationId: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly vatNumber: string | null;
}

export interface CustomerUpdateInput {
  readonly operationId: string;
  readonly nameAr?: string;
  readonly nameEn?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly vatNumber?: string | null;
  readonly isActive?: boolean;
}

export interface CustomersApi {
  list(
    query?: {
      readonly search?: string;
      readonly status?: 'active' | 'inactive';
      readonly cursor?: string;
      readonly limit?: number;
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<CustomerPage>;
  detail(customerId: string, options?: { readonly signal?: AbortSignal }): Promise<CustomerDetail>;
  create(input: CustomerCreateInput): Promise<CustomerMutationResult>;
  update(customerId: string, input: CustomerUpdateInput): Promise<CustomerMutationResult>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function readError(body: unknown, status: number): ApiError {
  if (body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const code = typeof record['error'] === 'string' ? record['error'] : `http_${String(status)}`;
    const message = typeof record['message'] === 'string' ? record['message'] : null;
    return new ApiError(status, code, message);
  }
  return new ApiError(status, `http_${String(status)}`, null);
}

function queryString(input: Readonly<Record<string, string | number | undefined>>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

export function createCustomersApi(fetchImpl?: Fetch): CustomersApi {
  const call = async <T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> => {
    const doFetch: Fetch =
      fetchImpl ?? ((input, requestInit) => globalThis.fetch(input, requestInit));
    let response: Response;
    try {
      response = await doFetch(path, {
        ...init,
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(init.headers ?? {}) },
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

  const command = async <T>(path: string, method: 'POST' | 'PATCH', body: unknown): Promise<T> => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CUSTOMER_COMMAND_TIMEOUT_MS);

    try {
      return await call<T>(
        path,
        {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        controller.signal,
      );
    } catch (error) {
      if (timedOut) throw new ApiError(0, 'timeout', null);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    list(query = {}, options) {
      return call(
        `/v1/admin/customers${queryString({
          search: query.search,
          status: query.status,
          cursor: query.cursor,
          limit: query.limit,
        })}`,
        { method: 'GET' },
        options?.signal,
      );
    },
    detail(customerId, options) {
      return call(
        `/v1/admin/customers/${encodeURIComponent(customerId)}`,
        { method: 'GET' },
        options?.signal,
      );
    },
    create(input) {
      return command('/v1/admin/customers', 'POST', input);
    },
    update(customerId, input) {
      return command(`/v1/admin/customers/${encodeURIComponent(customerId)}`, 'PATCH', input);
    },
  };
}
