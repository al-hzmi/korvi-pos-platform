import { ApiError, CHECKOUT_TIMEOUT_MS, type ApiClient } from '../../pos-web/src/lib/api';
import type {
  CheckoutRequest,
  CheckoutResponse,
  Principal,
  ProductSummary,
  ShiftSummary,
  TerminalsResponse,
} from '../../pos-web/src/lib/api-types';

export type CashierApiClient = Pick<
  ApiClient,
  'me' | 'login' | 'logout' | 'terminals' | 'products' | 'currentShift' | 'openShift' | 'checkout'
>;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function errorDetails(body: unknown, status: number): { code: string; message: string | null } {
  if (body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    return {
      code: typeof record['error'] === 'string' ? record['error'] : `http_${String(status)}`,
      message: typeof record['message'] === 'string' ? record['message'] : null,
    };
  }
  return { code: `http_${String(status)}`, message: null };
}

export function createCashierApiClient(fetchImpl: Fetch): CashierApiClient {
  const call = async (path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(path, {
        ...init,
        headers: { accept: 'application/json', ...(init.headers ?? {}) },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError(0, 'network', null);
    }

    if (response.status === 204) return null;
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const details = errorDetails(body, response.status);
      throw new ApiError(response.status, details.code, details.message);
    }
    return body;
  };

  const json = (payload: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  return {
    async me(options) {
      return (await call('/v1/auth/me', { method: 'GET' }, options?.signal)) as Principal;
    },

    async login(input) {
      return (await call(
        '/v1/auth/login',
        json({ tenantSlug: input.tenantSlug, email: input.email, password: input.password }),
      )) as Principal;
    },

    async logout() {
      await call('/v1/auth/logout', { method: 'POST' });
    },

    async terminals(options) {
      return (await call('/v1/terminals', { method: 'GET' }, options?.signal)) as TerminalsResponse;
    },

    async products(query, options) {
      const search = new URLSearchParams();
      if (query.q !== undefined && query.q !== '') search.set('q', query.q);
      if (query.limit !== undefined) search.set('limit', String(query.limit));
      const suffix = search.toString();
      const body = (await call(
        `/v1/products${suffix === '' ? '' : `?${suffix}`}`,
        { method: 'GET' },
        options?.signal,
      )) as { readonly products: readonly ProductSummary[] };
      return body.products;
    },

    async currentShift(terminalId, options) {
      const body = (await call(
        `/v1/shifts/current?terminalId=${encodeURIComponent(terminalId)}`,
        { method: 'GET' },
        options?.signal,
      )) as { readonly shift: ShiftSummary | null };
      return body.shift;
    },

    async openShift(input) {
      const body = (await call(
        '/v1/shifts/open',
        json({ terminalId: input.terminalId, openingFloatMinor: input.openingFloatMinor }),
      )) as { readonly shift: ShiftSummary };
      return body.shift;
    },

    async checkout(request: CheckoutRequest) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = globalThis.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, CHECKOUT_TIMEOUT_MS);

      try {
        return (await call(
          '/v1/sales',
          json({
            operationId: request.operationId,
            terminalId: request.terminalId,
            ...(request.expectedShiftId === undefined
              ? {}
              : { expectedShiftId: request.expectedShiftId }),
            cashReceivedMinor: request.cashReceivedMinor,
            lines: request.lines.map((line) => ({
              productId: line.productId,
              quantityScaled: line.quantityScaled,
            })),
          }),
          controller.signal,
        )) as CheckoutResponse;
      } catch (error) {
        if (timedOut) throw new ApiError(0, 'timeout', null);
        throw error;
      } finally {
        globalThis.clearTimeout(timer);
      }
    },
  };
}
