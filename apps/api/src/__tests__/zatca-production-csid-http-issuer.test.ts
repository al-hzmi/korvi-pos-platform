import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  extractZatcaSigningCertificateMaterial,
  tenantId,
  type IssueZatcaProductionCsidInput,
} from '@korvi/domain';
import type { ZatcaFatooraCredentialStore } from '../zatca/compliance-csid-http-issuer.js';
import type { ZatcaFatooraCredentialResolver } from '../zatca/encrypted-fatoora-credential-store.js';
import {
  ZATCA_PRODUCTION_CSID_ENDPOINTS,
  createZatcaProductionCsidHttpIssuer,
} from '../zatca/production-csid-http-issuer.js';

const LEAF_DER = Buffer.from(
  'MIIB3jCCAYSgAwIBAgIUTuCx/ib7wmZ0haQVB52pc8xrCIIwCgYIKoZIzj0EAwIwRDEgMB4GA1UEAwwXS29ydmkgVGVzdCBJbnRlcm1lZGlhdGUxEzARBgNVBAoMCktvcnZpIFRlc3QxCzAJBgNVBAYTAlNBMB4XDTI2MDkwOTIzNDIyMloXDTI5MDYwNTIzNDIyMlowOzEXMBUGA1UEAwwOS29ydmkgVGVzdCBFR1MxEzARBgNVBAoMCktvcnZpIFRlc3QxCzAJBgNVBAYTAlNBMFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAExtCZqdiCZU4A196YvvvzGJzrvV2PJ2AY9o08pZ9U1EeV25ETytPUidGTON+nwDdqYe+SSZrBGcXKfBuhLXV75KNgMF4wDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwHQYDVR0OBBYEFOeAiOZIOml+yYwvdiVAs9AvCmVWMB8GA1UdIwQYMBaAFIhLbjfz+A+FvmWK+9XdmDDDo9acMAoGCCqGSM49BAMCA0gAMEUCIE/dVTQxbO29P920Wu43gGA3MxYiL7wATgr+QSd2+PtQAiEA+7IUo+nZmZr5lS4/BSyNyO+ekWI/H6ksVp0KgFBlHY4=',
  'base64',
);
const expectedPublicKeySpkiDer =
  extractZatcaSigningCertificateMaterial(LEAF_DER).signingPublicKeySpkiDer;
const currentToken = 'current-compliance-csid-token';
const currentSecret = 'current-compliance-secret';
const issuedSecret = 'new-production-secret';

function request(environment: IssueZatcaProductionCsidInput['environment'] = 'production') {
  return {
    scope: { tenantId: tenantId('tenant-1') },
    terminalId: 'terminal-1',
    operationId: 'pcsid-operation-1',
    environment,
    complianceRequestId: '1234567890123',
    currentComplianceSecret: { provider: 'test-vault', secretId: 'sha256:' + 'a'.repeat(64) },
    expectedPublicKeySpkiDer: Uint8Array.from(expectedPublicKeySpkiDer),
  } satisfies IssueZatcaProductionCsidInput;
}

function dependencies() {
  const resolve = vi.fn<ZatcaFatooraCredentialResolver['resolve']>(async () => ({
    binarySecurityToken: currentToken,
    secret: currentSecret,
  }));
  const put = vi.fn<ZatcaFatooraCredentialStore['put']>(async () => ({
    provider: 'test-vault',
    secretId: 'sha256:' + 'b'.repeat(64),
  }));
  return { resolver: { resolve }, store: { put } };
}

function successResponse(): Response {
  return new Response(
    JSON.stringify({
      requestID: 98765,
      binarySecurityToken: LEAF_DER.toString('base64'),
      secret: issuedSecret,
      dispositionMessage: 'ISSUED',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function fetchMock(response: Response) {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

describe('ZATCA Production CSID HTTPS issuer', () => {
  it.each(['sandbox', 'simulation', 'production'] as const)(
    'uses fixed %s endpoint, V2 Basic auth, exact request id and one non-following POST',
    async (environment) => {
      const deps = dependencies();
      const fetchImpl = fetchMock(successResponse());
      const issuer = createZatcaProductionCsidHttpIssuer({
        credentialResolver: deps.resolver,
        credentialStore: deps.store,
        fetchImpl,
      });

      const result = await issuer.issue(request(environment));

      expect(result.kind).toBe('issued');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
      expect(url).toBe(ZATCA_PRODUCTION_CSID_ENDPOINTS[environment]);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toEqual({
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Accept-Version': 'V2',
        Authorization: `Basic ${Buffer.from(`${currentToken}:${currentSecret}`, 'utf8').toString('base64')}`,
      });
      expect(JSON.parse(String(init?.body))).toEqual({ compliance_request_id: '1234567890123' });
    },
  );

  it('stores only the newly issued Production credential and exposes no plaintext credential', async () => {
    const deps = dependencies();
    const issuer = createZatcaProductionCsidHttpIssuer({
      credentialResolver: deps.resolver,
      credentialStore: deps.store,
      fetchImpl: fetchMock(successResponse()),
    });

    const result = await issuer.issue(request());

    expect(deps.resolver.resolve).toHaveBeenCalledTimes(1);
    expect(deps.store.put).toHaveBeenCalledTimes(1);
    expect(deps.store.put.mock.calls[0]?.[0]).toMatchObject({
      credentialId: `sha256:${createHash('sha256').update(LEAF_DER).digest('hex')}`,
      binarySecurityToken: LEAF_DER.toString('base64'),
      secret: issuedSecret,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(currentSecret);
    expect(serialized).not.toContain(issuedSecret);
    expect(serialized).not.toContain(currentToken);
  });

  it.each([408, 425, 429, 500, 503])(
    'classifies HTTP %s as ambiguous and never retries',
    async (status) => {
      const deps = dependencies();
      const fetchImpl = fetchMock(new Response('ignored', { status }));
      const issuer = createZatcaProductionCsidHttpIssuer({
        credentialResolver: deps.resolver,
        credentialStore: deps.store,
        fetchImpl,
      });

      await expect(issuer.issue(request())).resolves.toEqual({
        kind: 'uncertain',
        reason: 'transport',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(deps.store.put).not.toHaveBeenCalled();
    },
  );

  it.each([400, 401, 403, 404, 422])(
    'maps definite HTTP %s refusal without response-body leakage',
    async (status) => {
      const deps = dependencies();
      const issuer = createZatcaProductionCsidHttpIssuer({
        credentialResolver: deps.resolver,
        credentialStore: deps.store,
        fetchImpl: fetchMock(new Response('sensitive-provider-diagnostic', { status })),
      });

      const result = await issuer.issue(request());
      expect(result).toEqual({ kind: 'rejected', rejectionCode: `HTTP_${status}` });
      expect(JSON.stringify(result)).not.toContain('sensitive-provider-diagnostic');
      expect(deps.store.put).not.toHaveBeenCalled();
    },
  );

  it('fails before networking when the current CCSID credential cannot be resolved', async () => {
    const deps = dependencies();
    deps.resolver.resolve.mockRejectedValueOnce(new Error('vault unavailable'));
    const fetchImpl = fetchMock(successResponse());
    const issuer = createZatcaProductionCsidHttpIssuer({
      credentialResolver: deps.resolver,
      credentialStore: deps.store,
      fetchImpl,
    });

    await expect(issuer.issue(request())).resolves.toEqual({
      kind: 'uncertain',
      reason: 'credential-store',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(deps.store.put).not.toHaveBeenCalled();
  });

  it('rejects malformed success responses before storing the new credential', async () => {
    const deps = dependencies();
    const issuer = createZatcaProductionCsidHttpIssuer({
      credentialResolver: deps.resolver,
      credentialStore: deps.store,
      fetchImpl: fetchMock(new Response('{not-json', { status: 200 })),
    });

    await expect(issuer.issue(request())).resolves.toEqual({
      kind: 'uncertain',
      reason: 'response-invalid',
    });
    expect(deps.store.put).not.toHaveBeenCalled();
  });

  it('rejects malformed compliance request identity before touching secrets or network', async () => {
    const deps = dependencies();
    const fetchImpl = fetchMock(successResponse());
    const issuer = createZatcaProductionCsidHttpIssuer({
      credentialResolver: deps.resolver,
      credentialStore: deps.store,
      fetchImpl,
    });

    await expect(issuer.issue({ ...request(), complianceRequestId: ' bad id ' })).rejects.toThrow();
    expect(deps.resolver.resolve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
