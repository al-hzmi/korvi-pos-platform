import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  extractZatcaSigningCertificateMaterial,
  tenantId,
  type IssueZatcaComplianceCsidInput,
} from '@korvi/domain';
import {
  ZATCA_COMPLIANCE_CSID_ENDPOINTS,
  createZatcaComplianceCsidHttpIssuer,
  type ZatcaFatooraCredentialStore,
} from '../zatca/compliance-csid-http-issuer.js';

const LEAF_DER = Buffer.from(
  'MIIB3jCCAYSgAwIBAgIUTuCx/ib7wmZ0haQVB52pc8xrCIIwCgYIKoZIzj0EAwIwRDEgMB4GA1UEAwwXS29ydmkgVGVzdCBJbnRlcm1lZGlhdGUxEzARBgNVBAoMCktvcnZpIFRlc3QxCzAJBgNVBAYTAlNBMB4XDTI2MDkwOTIzNDIyMloXDTI5MDYwNTIzNDIyMlowOzEXMBUGA1UEAwwOS29ydmkgVGVzdCBFR1MxEzARBgNVBAoMCktvcnZpIFRlc3QxCzAJBgNVBAYTAlNBMFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAExtCZqdiCZU4A196YvvvzGJzrvV2PJ2AY9o08pZ9U1EeV25ETytPUidGTON+nwDdqYe+SSZrBGcXKfBuhLXV75KNgMF4wDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwHQYDVR0OBBYEFOeAiOZIOml+yYwvdiVAs9AvCmVWMB8GA1UdIwQYMBaAFIhLbjfz+A+FvmWK+9XdmDDDo9acMAoGCCqGSM49BAMCA0gAMEUCIE/dVTQxbO29P920Wu43gGA3MxYiL7wATgr+QSd2+PtQAiEA+7IUo+nZmZr5lS4/BSyNyO+ekWI/H6ksVp0KgFBlHY4=',
  'base64',
);
const OTHER_LEAF_DER = Buffer.from(
  'MIIB2jCCAYCgAwIBAgIUZ08DJbrzr4JDFdcYMhQUeMj7DiAwCgYIKoZIzj0EAwIwPDEYMBYGA1UEAwwPS29ydmkgVGVzdCBSb290MRMwEQYDVQQKDApLb3J2aSBUZXN0MQswCQYDVQQGEwJTQTAeFw0yNjA5MDkyMzQyMjJaFw0zNjA5MDYyMzQyMjJaMDwxGDAWBgNVBAMMD0tvcnZpIFRlc3QgUm9vdDETMBEGA1UECgwKS29ydmkgVGVzdDELMAkGA1UEBhMCU0EwVjAQBgcqhkjOPQIBBgUrgQQACgNCAATv7Z3XcLGRa37gAIO9Fjl0vqk4tQvM6QAjkCMaIOQR06yDBUc6ony0Z9+lXGQ17o0V9wMjepLw3i3PKadOuFOdo2MwYTAdBgNVHQ4EFgQUjBvZOQQJRXo32vJJq/ZF4rRO+rAwHwYDVR0jBBgwFoAUjBvZOQQJRXo32vJJq/ZF4rRO+rAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwIDSAAwRQIhAJXe+r7oXInGv0pa0HWPUiNNge4FMYClo92UyQ76T17BAiAJT7kW7bDkTo6NzyZGuWegP3mpNZqFxHpj/aGr58Tyew==',
  'base64',
);

const expectedPublicKeySpkiDer = extractZatcaSigningCertificateMaterial(
  LEAF_DER,
).signingPublicKeySpkiDer;
const rawSecret = 'raw-fatoora-secret-never-return';
const token = LEAF_DER.toString('base64');

function request(environment: IssueZatcaComplianceCsidInput['environment'] = 'sandbox') {
  return {
    scope: { tenantId: tenantId('tenant-1') },
    terminalId: 'terminal-1',
    operationId: 'operation-1',
    environment,
    csrDer: Uint8Array.from([0x30, 0x03, 0x01, 0x02, 0x03]),
    expectedPublicKeySpkiDer: Uint8Array.from(expectedPublicKeySpkiDer),
    otp: '123456',
  } satisfies IssueZatcaComplianceCsidInput;
}

function successResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      requestID: 12345,
      binarySecurityToken: token,
      secret: rawSecret,
      ...overrides,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function credentialStore() {
  const put = vi.fn<ZatcaFatooraCredentialStore['put']>(async () => ({
    provider: 'test-vault',
    secretId: 'zatca/tenant-1/terminal-1/credential',
  }));
  return { put };
}

function fetchMock(response: Response | (() => Promise<Response>)) {
  return vi.fn(async () => (response instanceof Response ? response : response())) as unknown as typeof fetch;
}

describe('ZATCA Compliance CSID HTTPS issuer', () => {
  it.each(['sandbox', 'simulation', 'production'] as const)(
    'uses the fixed %s origin, V2 headers, one POST and a non-following redirect policy',
    async (environment) => {
      const store = credentialStore();
      const fetchImpl = fetchMock(successResponse());
      const issuer = createZatcaComplianceCsidHttpIssuer({ credentialStore: store, fetchImpl });

      const result = await issuer.issue(request(environment));

      expect(result.kind).toBe('issued');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
      expect(url).toBe(ZATCA_COMPLIANCE_CSID_ENDPOINTS[environment]);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toEqual({
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Accept-Version': 'V2',
        OTP: '123456',
      });
      expect(JSON.stringify(init?.headers)).not.toContain('Authorization');
    },
  );

  it('encodes DER CSR as Base64 of PEM and preserves the exact CSR bytes', async () => {
    const store = credentialStore();
    const fetchImpl = fetchMock(successResponse());
    const issuer = createZatcaComplianceCsidHttpIssuer({ credentialStore: store, fetchImpl });
    const input = request();

    await issuer.issue(input);

    const [, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    const outer = JSON.parse(String(init?.body)) as { csr: string };
    const pem = Buffer.from(outer.csr, 'base64').toString('utf8');
    expect(pem.startsWith('-----BEGIN CERTIFICATE REQUEST-----\n')).toBe(true);
    expect(pem.endsWith('-----END CERTIFICATE REQUEST-----\n')).toBe(true);
    const inner = pem
      .replace('-----BEGIN CERTIFICATE REQUEST-----', '')
      .replace('-----END CERTIFICATE REQUEST-----', '')
      .replace(/\s+/g, '');
    expect(Buffer.from(inner, 'base64')).toEqual(Buffer.from(input.csrDer));
  });

  it('stores the exact Fatoora authentication bundle once and returns only an opaque handle', async () => {
    const store = credentialStore();
    const fetchImpl = fetchMock(successResponse());
    const issuer = createZatcaComplianceCsidHttpIssuer({ credentialStore: store, fetchImpl });

    const result = await issuer.issue(request());

    expect(result.kind).toBe('issued');
    expect(store.put).toHaveBeenCalledTimes(1);
    const stored = store.put.mock.calls[0]?.[0];
    expect(stored?.binarySecurityToken).toBe(token);
    expect(stored?.secret).toBe(rawSecret);
    expect(stored?.credentialId).toBe(
      `sha256:${createHash('sha256').update(LEAF_DER).digest('hex')}`,
    );
    expect(JSON.stringify(result)).not.toContain(rawSecret);
    expect(JSON.stringify(result)).not.toContain('123456');
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it.each([408, 425, 429, 500, 503])(
    'treats HTTP %s as transport uncertainty and never retries',
    async (status) => {
      const store = credentialStore();
      const fetchImpl = fetchMock(new Response('ignored', { status }));
      const issuer = createZatcaComplianceCsidHttpIssuer({ credentialStore: store, fetchImpl });

      await expect(issuer.issue(request())).resolves.toEqual({
        kind: 'uncertain',
        reason: 'transport',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(store.put).not.toHaveBeenCalled();
    },
  );

  it('treats a thrown fetch as transport uncertainty and never retries', async () => {
    const store = credentialStore();
    const fetchImpl = fetchMock(async () => {
      throw new Error('socket detail must not escape');
    });
    const issuer = createZatcaComplianceCsidHttpIssuer({ credentialStore: store, fetchImpl });

    await expect(issuer.issue(request())).resolves.toEqual({
      kind: 'uncertain',
      reason: 'transport',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.put).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 422])(
    'maps definite HTTP %s client refusal to a bounded status code without provider body leakage',
    async (status) => {
      const store = credentialStore();
      const fetchImpl = fetchMock(new Response('sensitive-provider-diagnostic', { status }));
      const issuer = createZatcaComplianceCsidHttpIssuer({ credentialStore: store, fetchImpl });

      const result = await issuer.issue(request());
      expect(result).toEqual({ kind: 'rejected', rejectionCode: `HTTP_${status}` });
      expect(JSON.stringify(result)).not.toContain('sensitive-provider-diagnostic');
      expect(store.put).not.toHaveBeenCalled();
    },
  );

  it('rejects oversized and malformed successful responses before storing credentials', async () => {
    for (const response of [
      new Response('{}', { status: 200, headers: { 'content-length': '65537' } }),
      new Response('{not-json', { status: 200 }),
      successResponse({ secret: '' }),
    ]) {
      const store = credentialStore();
      const issuer = createZatcaComplianceCsidHttpIssuer({
        credentialStore: store,
        fetchImpl: fetchMock(response),
      });
      await expect(issuer.issue(request())).resolves.toEqual({
        kind: 'uncertain',
        reason: 'response-invalid',
      });
      expect(store.put).not.toHaveBeenCalled();
    }
  });

  it('fails closed on a certificate whose public key differs from the prepared HSM key', async () => {
    const store = credentialStore();
    const issuer = createZatcaComplianceCsidHttpIssuer({
      credentialStore: store,
      fetchImpl: fetchMock(
        successResponse({ binarySecurityToken: OTHER_LEAF_DER.toString('base64') }),
      ),
    });

    await expect(issuer.issue(request())).resolves.toEqual({
      kind: 'uncertain',
      reason: 'response-invalid',
    });
    expect(store.put).not.toHaveBeenCalled();
  });

  it('classifies credential-store ambiguity separately and does not reissue inside the adapter', async () => {
    const put = vi.fn<ZatcaFatooraCredentialStore['put']>(async () => {
      throw new Error('vault unavailable');
    });
    const fetchImpl = fetchMock(successResponse());
    const issuer = createZatcaComplianceCsidHttpIssuer({
      credentialStore: { put },
      fetchImpl,
    });

    await expect(issuer.issue(request())).resolves.toEqual({
      kind: 'uncertain',
      reason: 'credential-store',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('refuses unsafe timeout and response-limit configuration at construction', () => {
    const store = credentialStore();
    expect(() =>
      createZatcaComplianceCsidHttpIssuer({ credentialStore: store, timeoutMs: 0 }),
    ).toThrow();
    expect(() =>
      createZatcaComplianceCsidHttpIssuer({
        credentialStore: store,
        maxResponseBytes: 256 * 1024 + 1,
      }),
    ).toThrow();
  });
});
