import type {
  CheckoutRequest,
  DashboardSummary,
  CheckoutResponse,
  Principal,
  ProductSummary,
  ShiftSummary,
  TerminalsResponse,
} from './api-types';

/**
 * The browser's only door to the server.
 *
 * One place that knows about JSON, cookies, aborts and what an HTTP failure
 * means, so no component ever writes fetch('/v1/...') and no component ever
 * has to remember `credentials`.
 *
 * Requests go to this app's own origin and Next forwards them (ADR-0014).
 * There is no base URL to configure and no token to attach: the session is an
 * HttpOnly cookie the browser manages and JavaScript cannot read. If you find
 * yourself wanting a token here, the design has gone wrong.
 */

/**
 * How long a checkout may go unanswered before the till stops waiting.
 *
 * The server holds a branch row lock for the length of the sale transaction,
 * so a checkout behind a queue of tills legitimately takes longer than a
 * search. Twenty seconds is well past any healthy checkout and well short of a
 * cashier deciding the machine is broken.
 *
 * What matters more than the number: a timeout here is NOT a cancellation. The
 * request may have committed. It is reported as ambiguous, keeps its operation
 * id, and is retried unchanged (ADR-0013).
 */
export const CHECKOUT_TIMEOUT_MS = 20_000;

export type ApiFailureKind = 'network' | 'http';

export class ApiError extends Error {
  public override readonly name = 'ApiError';
  /** 0 when the request never got an answer — a timeout, a dropped link, a stopped server. */
  public readonly status: number;
  /** The server's own `error` code where there is one; otherwise a local label. */
  public readonly code: string;
  public readonly serverMessage: string | null;

  public constructor(status: number, code: string, serverMessage: string | null) {
    super(`${code} (${String(status)})`);
    this.status = status;
    this.code = code;
    this.serverMessage = serverMessage;
  }

  /** True when the request may or may not have been carried out. */
  public get ambiguous(): boolean {
    return this.status === 0;
  }

  public get unauthenticated(): boolean {
    return this.status === 401;
  }

  public get forbidden(): boolean {
    return this.status === 403;
  }
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
}

export interface ApiClient {
  me(options?: RequestOptions): Promise<Principal>;
  login(input: {
    readonly tenantSlug: string;
    readonly email: string;
    readonly password: string;
  }): Promise<Principal>;
  logout(): Promise<void>;
  terminals(options?: RequestOptions): Promise<TerminalsResponse>;
  dashboardSummary(options?: RequestOptions): Promise<DashboardSummary>;
  products(
    query: { readonly q?: string; readonly limit?: number },
    options?: RequestOptions,
  ): Promise<readonly ProductSummary[]>;
  currentShift(terminalId: string, options?: RequestOptions): Promise<ShiftSummary | null>;
  openShift(input: {
    readonly terminalId: string;
    readonly openingFloatMinor: string;
  }): Promise<ShiftSummary>;
  checkout(request: CheckoutRequest): Promise<CheckoutResponse>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function readErrorCode(body: unknown, status: number): { code: string; message: string | null } {
  if (body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const code = typeof record['error'] === 'string' ? record['error'] : `http_${String(status)}`;
    const message = typeof record['message'] === 'string' ? record['message'] : null;
    return { code, message };
  }
  return { code: `http_${String(status)}`, message: null };
}

export function createApiClient(fetchImpl?: Fetch): ApiClient {
  const call = async (
    path: string,
    init: RequestInit,
    options?: RequestOptions,
  ): Promise<unknown> => {
    const doFetch: Fetch =
      fetchImpl ?? ((input, requestInit) => globalThis.fetch(input, requestInit));

    let response: Response;
    try {
      response = await doFetch(path, {
        ...init,
        // Same-origin, so the session cookie rides along without any of the
        // cross-origin machinery that would otherwise be needed.
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(init.headers ?? {}) },
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      // An abort is the caller changing their mind, not a failure. It is
      // rethrown untouched so a stale search does not surface as an outage.
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError(0, 'network', null);
    }

    if (response.status === 204) return null;

    // A body that is not JSON is not a reason to lose the status code: a proxy
    // error page still has to surface as the HTTP failure it is.
    const body: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const { code, message } = readErrorCode(body, response.status);
      throw new ApiError(response.status, code, message);
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
      return (await call('/v1/auth/me', { method: 'GET' }, options)) as Principal;
    },

    async login(input) {
      // Field by field. A spread would send whatever the form state happens to
      // hold, and form state grows fields.
      return (await call(
        '/v1/auth/login',
        json({ tenantSlug: input.tenantSlug, email: input.email, password: input.password }),
      )) as Principal;
    },

    async logout() {
      await call('/v1/auth/logout', { method: 'POST' });
    },

    async terminals(options) {
      return (await call('/v1/terminals', { method: 'GET' }, options)) as TerminalsResponse;
    },

    async dashboardSummary(options) {
      return (await call('/v1/dashboard/summary', { method: 'GET' }, options)) as DashboardSummary;
    },

    async products(query, options) {
      const search = new URLSearchParams();
      if (query.q !== undefined && query.q !== '') search.set('q', query.q);
      if (query.limit !== undefined) search.set('limit', String(query.limit));
      const suffix = search.toString();
      const body = (await call(
        `/v1/products${suffix === '' ? '' : `?${suffix}`}`,
        { method: 'GET' },
        options,
      )) as { products: readonly ProductSummary[] };
      return body.products;
    },

    async currentShift(terminalId, options) {
      const body = (await call(
        `/v1/shifts/current?terminalId=${encodeURIComponent(terminalId)}`,
        { method: 'GET' },
        options,
      )) as { shift: ShiftSummary | null };
      return body.shift;
    },

    async openShift(input) {
      const body = (await call(
        '/v1/shifts/open',
        json({ terminalId: input.terminalId, openingFloatMinor: input.openingFloatMinor }),
      )) as { shift: ShiftSummary };
      return body.shift;
    },

    async checkout(request) {
      // A hung request must not leave the till in "submitting" forever, and
      // must not be mistaken for a cancellation: the sale may already exist.
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, CHECKOUT_TIMEOUT_MS);

      try {
        // The whitelist is the security control, not a convenience. Building
        // the body from named fields is what makes it impossible for a price,
        // a tenant or a role to reach the server because something upstream
        // put it on an object.
        return (await call(
          '/v1/sales',
          json({
            operationId: request.operationId,
            terminalId: request.terminalId,
            cashReceivedMinor: request.cashReceivedMinor,
            lines: request.lines.map((line) => ({
              productId: line.productId,
              quantityScaled: line.quantityScaled,
            })),
          }),
          { signal: controller.signal },
        )) as CheckoutResponse;
      } catch (error) {
        // Our own abort, translated. Left as an AbortError it would look like
        // a cancelled search and the basket would be cleared.
        if (timedOut) throw new ApiError(0, 'timeout', null);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
