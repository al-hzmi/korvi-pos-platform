import { ApiError } from './api';

export const PLATFORM_COMMAND_TIMEOUT_MS = 20_000;

export type PlatformLifecycleStatus = 'provisioning' | 'active' | 'suspended';
export type PlatformCommercialState = 'active' | 'restricted';
export type PlatformVertical = 'retail' | 'grocery' | 'restaurant' | 'pharmacy';
export type PlatformPermission =
  | 'platform.tenants.read'
  | 'platform.tenants.manage'
  | 'platform.commercial.manage'
  | 'platform.audit.read'
  | 'platform.support.read'
  | 'platform.support.manage';

export interface PlatformSession {
  readonly authenticated: true;
  readonly expiresAt: string;
  readonly permissions: readonly PlatformPermission[];
}

export interface PlatformTenantSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly vatNumber: string | null;
  readonly status: PlatformLifecycleStatus;
  readonly lifecycleProvenance: string;
  readonly activatedAt: string | null;
  readonly suspendedAt: string | null;
  readonly suspensionReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlatformTenantPage {
  readonly items: readonly PlatformTenantSummary[];
  readonly nextCursor: string | null;
}

export type PlatformEntitlement =
  | { readonly key: string; readonly kind: 'flag'; readonly enabled: boolean }
  | { readonly key: string; readonly kind: 'limit'; readonly limit: string };

export interface PlatformCommercialSnapshot {
  readonly assignmentId: string;
  readonly planKey: string;
  readonly planRevision: number;
  readonly state: PlatformCommercialState;
  readonly entitlements: readonly PlatformEntitlement[];
  readonly assignedAt: string;
}

export interface PlatformTenantDetail {
  readonly tenant: PlatformTenantSummary;
  readonly commercial: PlatformCommercialSnapshot | null;
  readonly operations: {
    readonly branches: { readonly total: number; readonly active: number };
    readonly terminals: { readonly total: number; readonly active: number };
    readonly users: { readonly total: number; readonly active: number };
    readonly owner: {
      readonly id: string;
      readonly displayName: string;
      readonly email: string;
      readonly isActive: boolean;
      readonly lastLoginAt: string | null;
    } | null;
    readonly lastActivityAt: string | null;
    readonly zatca: {
      readonly latestProvisioningState: string | null;
      readonly latestProvisioningAt: string | null;
    };
  };
}

export interface PlatformAuditEntry {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly branchId: string | null;
  readonly terminalId: string | null;
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly metadata: unknown;
  readonly occurredAt: string;
}

export interface PlatformAuditPage {
  readonly items: readonly PlatformAuditEntry[];
  readonly nextCursor: string | null;
}

export interface PlatformSupportNote {
  readonly id: string;
  readonly tenantId: string;
  readonly operationId: string;
  readonly actorRef: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface PlatformSupportNotePage {
  readonly items: readonly PlatformSupportNote[];
  readonly nextCursor: string | null;
}

export interface PlatformSupportNoteCreateResult {
  readonly note: PlatformSupportNote;
  readonly replayed: boolean;
}

export interface PlatformApi {
  session(options?: { readonly signal?: AbortSignal }): Promise<PlatformSession>;
  login(accessKey: string): Promise<PlatformSession>;
  logout(): Promise<void>;
  tenants(
    query?: {
      readonly search?: string;
      readonly status?: PlatformLifecycleStatus;
      readonly cursor?: string;
      readonly limit?: number;
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<PlatformTenantPage>;
  tenant(
    tenantId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<PlatformTenantDetail>;
  createTenant(input: {
    readonly operationId: string;
    readonly slug: string;
    readonly name: string;
    readonly vatNumber: string | null;
    readonly vertical: PlatformVertical;
  }): Promise<PlatformTenantSummary & { readonly created?: boolean }>;
  activateTenant(tenantId: string, operationId: string): Promise<unknown>;
  suspendTenant(tenantId: string, operationId: string, reason: string): Promise<unknown>;
  reactivateTenant(tenantId: string, operationId: string): Promise<unknown>;
  assignPlan(
    tenantId: string,
    input: {
      readonly operationId: string;
      readonly planKey: string;
      readonly planRevision: number;
      readonly accountState: PlatformCommercialState;
      readonly entitlements: readonly PlatformEntitlement[];
    },
  ): Promise<PlatformCommercialSnapshot>;
  audit(
    tenantId: string,
    query?: { readonly cursor?: string; readonly limit?: number },
    options?: { readonly signal?: AbortSignal },
  ): Promise<PlatformAuditPage>;
  supportNotes(
    tenantId: string,
    query?: { readonly cursor?: string; readonly limit?: number },
    options?: { readonly signal?: AbortSignal },
  ): Promise<PlatformSupportNotePage>;
  createSupportNote(
    tenantId: string,
    input: { readonly operationId: string; readonly body: string },
  ): Promise<PlatformSupportNoteCreateResult>;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function queryString(input: Readonly<Record<string, string | number | undefined>>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded === '' ? '' : `?${encoded}`;
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

export function createPlatformApi(fetchImpl?: Fetch): PlatformApi {
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

    if (response.status === 204) return undefined as T;
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw readError(body, response.status);
    return body as T;
  };

  const json = (body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const command = async <T>(path: string, body: unknown): Promise<T> => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, PLATFORM_COMMAND_TIMEOUT_MS);
    try {
      return await call<T>(path, json(body), controller.signal);
    } catch (error) {
      if (timedOut) throw new ApiError(0, 'timeout', null);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    session(options) {
      return call('/v1/platform/session', { method: 'GET' }, options?.signal);
    },
    login(accessKey) {
      return call('/v1/platform/session', json({ accessKey }));
    },
    async logout() {
      await call<void>('/v1/platform/logout', { method: 'POST' });
    },
    tenants(query = {}, options) {
      return call(
        `/v1/platform/tenants${queryString({
          search: query.search,
          status: query.status,
          cursor: query.cursor,
          limit: query.limit,
        })}`,
        { method: 'GET' },
        options?.signal,
      );
    },
    tenant(tenantId, options) {
      return call(
        `/v1/platform/tenants/${encodeURIComponent(tenantId)}`,
        { method: 'GET' },
        options?.signal,
      );
    },
    createTenant(input) {
      return command('/v1/platform/tenants', input);
    },
    activateTenant(tenantId, operationId) {
      return command(`/v1/platform/tenants/${encodeURIComponent(tenantId)}/activate`, {
        operationId,
      });
    },
    suspendTenant(tenantId, operationId, reason) {
      return command(`/v1/platform/tenants/${encodeURIComponent(tenantId)}/suspend`, {
        operationId,
        reason,
      });
    },
    reactivateTenant(tenantId, operationId) {
      return command(`/v1/platform/tenants/${encodeURIComponent(tenantId)}/reactivate`, {
        operationId,
      });
    },
    assignPlan(tenantId, input) {
      return command(`/v1/platform/tenants/${encodeURIComponent(tenantId)}/plan`, input);
    },
    audit(tenantId, query = {}, options) {
      return call(
        `/v1/platform/tenants/${encodeURIComponent(tenantId)}/audit${queryString({
          cursor: query.cursor,
          limit: query.limit,
        })}`,
        { method: 'GET' },
        options?.signal,
      );
    },
    supportNotes(tenantId, query = {}, options) {
      return call(
        `/v1/platform/tenants/${encodeURIComponent(tenantId)}/support-notes${queryString({
          cursor: query.cursor,
          limit: query.limit,
        })}`,
        { method: 'GET' },
        options?.signal,
      );
    },
    createSupportNote(tenantId, input) {
      return command(
        `/v1/platform/tenants/${encodeURIComponent(tenantId)}/support-notes`,
        input,
      );
    },
  };
}
