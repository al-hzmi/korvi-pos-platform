import { ApiError } from './api';

export type ZatcaEnvironment = 'sandbox' | 'simulation' | 'production';
export type ZatcaProvisioningState = 'prepared' | 'in-flight' | 'issued' | 'rejected' | 'uncertain';
export type ZatcaSubmissionMode = 'reporting' | 'clearance';
export type ZatcaSubmissionState = 'pending' | 'in-flight' | 'accepted' | 'rejected' | 'uncertain';
export type ZatcaUncertaintyReason = 'credential-store' | 'transport' | 'response-invalid';

export interface ZatcaProvisioningStatus {
  readonly attemptId: string;
  readonly environment: ZatcaEnvironment;
  readonly state: ZatcaProvisioningState;
  readonly preparedAt: string;
  readonly requestStartedAt: string | null;
  readonly resolvedAt: string | null;
  readonly remoteRequestId: string | null;
  readonly credentialId: string | null;
  readonly rejectionCode: string | null;
  readonly uncertaintyReason: ZatcaUncertaintyReason | null;
}

export interface ZatcaTerminalStatus {
  readonly terminalId: string;
  readonly branchId: string;
  readonly code: string;
  readonly label: string;
  readonly isActive: boolean;
  readonly lastSeenAt: string | null;
  readonly latestProvisioning: ZatcaProvisioningStatus | null;
  readonly complianceAcceptedAt: string | null;
}

export interface ZatcaSubmissionStatus {
  readonly submissionId: string;
  readonly invoiceId: string;
  readonly terminalId: string;
  readonly environment: ZatcaEnvironment;
  readonly mode: ZatcaSubmissionMode;
  readonly state: ZatcaSubmissionState;
  readonly attemptCount: number;
  readonly queuedAt: string;
  readonly requestStartedAt: string | null;
  readonly resolvedAt: string | null;
  readonly httpStatus: number | null;
  readonly authorityStatus: 'REPORTED' | 'CLEARED' | null;
  readonly rejectionCode: string | null;
  readonly uncertaintyReason: ZatcaUncertaintyReason | null;
}

export interface ZatcaStatus {
  readonly summary: {
    readonly terminalCount: string;
    readonly complianceReadyTerminalCount: string;
    readonly acceptedSubmissionCount: string;
    readonly rejectedSubmissionCount: string;
    readonly unresolvedSubmissionCount: string;
  };
  readonly terminals: readonly ZatcaTerminalStatus[];
  readonly terminalHasMore: boolean;
  readonly recentSubmissions: readonly ZatcaSubmissionStatus[];
}

export interface ZatcaApi {
  status(options?: { readonly signal?: AbortSignal }): Promise<ZatcaStatus>;
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

export function createZatcaApi(fetchImpl?: Fetch): ZatcaApi {
  return {
    async status(options) {
      const call: Fetch =
        fetchImpl ?? ((input, requestInit) => globalThis.fetch(input, requestInit));
      let response: Response;
      try {
        response = await call('/v1/admin/zatca/status?terminalLimit=100&submissionLimit=25', {
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
      return body as ZatcaStatus;
    },
  };
}
