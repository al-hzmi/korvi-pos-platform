import { ApiError } from './api';

export interface LoyaltyPolicy {
  readonly id: string;
  readonly nameAr: string;
  readonly status: 'draft' | 'active' | 'paused';
  readonly revision: string;
  readonly earnNumerator: string;
  readonly earnDenominator: string;
  readonly redeemValueMinorPerPoint: string;
}
export type LoyaltyPolicyDraft = Pick<
  LoyaltyPolicy,
  'nameAr' | 'earnNumerator' | 'earnDenominator' | 'redeemValueMinorPerPoint'
>;
export interface LoyaltyLedger {
  readonly customerId: string;
  readonly enrolled: boolean;
  readonly balancePoints: string;
  readonly entries: readonly {
    readonly id: string;
    readonly kind: string;
    readonly pointsDelta: string;
    readonly saleId: string | null;
    readonly returnId: string | null;
    readonly occurredAt: string;
  }[];
}
type Transport = (path: string, init?: RequestInit) => Promise<Response>;
const TIMEOUT_MS = 15_000;

export function createLoyaltyApi(transport: Transport = globalThis.fetch.bind(globalThis)) {
  const call = async <T>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    body?: unknown,
  ): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await transport(path, {
        method,
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const failure = payload as { error?: unknown; message?: unknown } | null;
        throw new ApiError(
          response.status,
          typeof failure?.error === 'string' ? failure.error : 'loyalty_request_failed',
          typeof failure?.message === 'string' ? failure.message : null,
        );
      }
      return payload as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        0,
        error instanceof DOMException && error.name === 'AbortError' ? 'timeout' : 'network',
        null,
      );
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    policy: () => call<LoyaltyPolicy | null>('/v1/admin/loyalty/policy', 'GET'),
    create: (input: LoyaltyPolicyDraft) =>
      call<LoyaltyPolicy>('/v1/admin/loyalty/policy', 'POST', input),
    revise: (
      revision: string,
      input: Partial<LoyaltyPolicyDraft> & { status?: LoyaltyPolicy['status'] },
    ) =>
      call<LoyaltyPolicy>('/v1/admin/loyalty/policy', 'PATCH', {
        expectedRevision: revision,
        ...input,
      }),
    enroll: (customerId: string) =>
      call<{ enrollmentId: string }>('/v1/admin/loyalty/enrollments', 'POST', {
        customerId,
        consentConfirmed: true,
      }),
    ledger: (customerId: string) =>
      call<LoyaltyLedger>(`/v1/admin/loyalty/customers/${encodeURIComponent(customerId)}`, 'GET'),
  };
}
