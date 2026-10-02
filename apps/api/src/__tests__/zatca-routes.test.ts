import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import type { AuthService } from '../auth/service.js';
import type { MerchantZatcaService } from '../zatca/merchant-service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

const TENANT_ID = '018fb000-0000-7000-8000-00000000000a';
const BRANCH_ID = '018fb000-0000-7000-8000-0000000000a1';
const TERMINAL_ID = '018fb000-0000-7000-8000-0000000000a2';
const USER_ID = '018fb000-0000-7000-8000-0000000000a4';
const INVOICE_ID = '018fb000-0000-7000-8000-0000000000b1';

let app: FastifyInstance | null = null;

function principal(permissions: AuthenticatedPrincipal['permissions']): AuthenticatedPrincipal {
  return {
    tenantId: TENANT_ID,
    tenantSlug: 'korvi-a',
    userId: USER_ID,
    sessionId: '018fb000-0000-7000-8000-0000000000a8',
    email: 'owner@korvi.test',
    displayName: 'مالك المتجر',
    roles: ['owner'],
    permissions,
    maxDiscountBasisPoints: 10_000n,
    branchId: BRANCH_ID,
  };
}

function authFor(subject: AuthenticatedPrincipal | null): AuthService {
  return {
    async login() {
      return { outcome: 'failure', reason: 'bad-password' };
    },
    async authenticate(rawToken) {
      if (rawToken !== 'zatca-test-token' || subject === null) {
        return { outcome: 'failure', reason: 'malformed-token' };
      }
      return { outcome: 'success', principal: subject };
    },
    async logout() {
      return true;
    },
    async logoutAll() {
      return 1;
    },
  };
}

function recordingZatca() {
  const calls: string[] = [];
  const service: MerchantZatcaService = {
    async status(subject, query = {}) {
      calls.push(
        `status:${subject.tenantId}:${String(query.terminalLimit ?? '')}:${String(query.submissionLimit ?? '')}`,
      );
      return {
        summary: {
          terminalCount: '1',
          complianceReadyTerminalCount: '1',
          acceptedSubmissionCount: '9',
          rejectedSubmissionCount: '1',
          unresolvedSubmissionCount: '2',
        },
        terminalHasMore: false,
        terminals: [
          {
            terminalId: TERMINAL_ID,
            branchId: BRANCH_ID,
            code: 'POS-01',
            label: 'الصندوق الرئيسي',
            isActive: true,
            lastSeenAt: '2026-09-14T17:00:00.000Z',
            complianceAcceptedAt: '2026-09-13T12:00:00.000Z',
            latestProvisioning: {
              attemptId: '018fb000-0000-7000-8000-0000000000c1',
              environment: 'production',
              state: 'issued',
              preparedAt: '2026-09-13T11:58:00.000Z',
              requestStartedAt: '2026-09-13T11:59:00.000Z',
              resolvedAt: '2026-09-13T12:00:00.000Z',
              remoteRequestId: 'fatoora-request-17',
              credentialId: 'credential-public-id-17',
              rejectionCode: null,
              uncertaintyReason: null,
            },
          },
        ],
        recentSubmissions: [
          {
            submissionId: '018fb000-0000-7000-8000-0000000000d1',
            invoiceId: INVOICE_ID,
            terminalId: TERMINAL_ID,
            environment: 'production',
            mode: 'reporting',
            state: 'accepted',
            attemptCount: 1,
            queuedAt: '2026-09-14T16:59:58.000Z',
            requestStartedAt: '2026-09-14T16:59:59.000Z',
            resolvedAt: '2026-09-14T17:00:00.000Z',
            httpStatus: 200,
            authorityStatus: 'REPORTED',
            rejectionCode: null,
            uncertaintyReason: null,
          },
        ],
      };
    },
  };
  return { service, calls };
}

function build(subject: AuthenticatedPrincipal | null) {
  const zatca = recordingZatca();
  app = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }), {
    auth: authFor(subject),
    zatca: zatca.service,
  });
  return zatca;
}

afterEach(async () => {
  if (app !== null) await app.close();
  app = null;
});

describe('merchant ZATCA status route', () => {
  it('requires an authenticated merchant session', async () => {
    const zatca = build(principal(['zatca.manage']));
    const response = await app!.inject({ method: 'GET', url: '/v1/admin/zatca/status' });

    expect(response.statusCode).toBe(401);
    expect(zatca.calls).toEqual([]);
  });

  it('requires zatca.manage independently of other administration permissions', async () => {
    const zatca = build(principal(['settings.manage', 'report.read']));
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/admin/zatca/status',
      headers: { cookie: 'korvi_session=zatca-test-token' },
    });

    expect(response.statusCode).toBe(403);
    expect(zatca.calls).toEqual([]);
  });

  it('passes only bounded status options while tenant authority stays in the principal', async () => {
    const zatca = build(principal(['zatca.manage']));
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/admin/zatca/status?terminalLimit=25&submissionLimit=10',
      headers: { cookie: 'korvi_session=zatca-test-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(zatca.calls).toEqual([`status:${TENANT_ID}:25:10`]);
    expect(response.json()).toMatchObject({
      summary: { terminalCount: '1', complianceReadyTerminalCount: '1' },
      terminals: [{ terminalId: TERMINAL_ID, code: 'POS-01' }],
      recentSubmissions: [{ invoiceId: INVOICE_ID, authorityStatus: 'REPORTED' }],
    });
  });

  it('rejects client-supplied authority and out-of-range limits before the service runs', async () => {
    const zatca = build(principal(['zatca.manage']));
    const injectedAuthority = await app!.inject({
      method: 'GET',
      url: `/v1/admin/zatca/status?tenantId=${TENANT_ID}`,
      headers: { cookie: 'korvi_session=zatca-test-token' },
    });
    const excessive = await app!.inject({
      method: 'GET',
      url: '/v1/admin/zatca/status?submissionLimit=51',
      headers: { cookie: 'korvi_session=zatca-test-token' },
    });

    expect(injectedAuthority.statusCode).toBe(400);
    expect(excessive.statusCode).toBe(400);
    expect(zatca.calls).toEqual([]);
  });

  it('does not place credential secrets, keys, certificates or invoice payloads in the merchant contract', async () => {
    build(principal(['zatca.manage']));
    const response = await app!.inject({
      method: 'GET',
      url: '/v1/admin/zatca/status',
      headers: { cookie: 'korvi_session=zatca-test-token' },
    });
    const body = response.body.toLowerCase();

    expect(response.statusCode).toBe(200);
    for (const forbidden of [
      'privatekey',
      'secretid',
      'secretprovider',
      'ciphertext',
      'authtag',
      'nonce',
      'certificateder',
      'invoicehash',
      'sealedinvoicexml',
      'clearedinvoicexml',
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });
});
