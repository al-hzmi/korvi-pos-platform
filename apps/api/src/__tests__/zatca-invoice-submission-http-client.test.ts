import { describe, expect, it, vi } from 'vitest';
import { tenantId, type SubmitZatcaInvoiceInput } from '@korvi/domain';
import type { ZatcaFatooraCredentialResolver } from '../zatca/encrypted-fatoora-credential-store.js';
import {
  ZATCA_INVOICE_SUBMISSION_ENDPOINTS,
  createZatcaInvoiceSubmissionHttpClient,
} from '../zatca/invoice-submission-http-client.js';

const TOKEN = 'production-csid-token';
const SECRET = 'production-csid-secret';
const INVOICE_HASH = Buffer.alloc(32, 7).toString('base64');
const XML =
  '<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><ID>1</ID></Invoice>';
const INVOICE_BASE64 = Buffer.from(XML, 'utf8').toString('base64');

function input(
  mode: SubmitZatcaInvoiceInput['mode'] = 'reporting',
  environment: SubmitZatcaInvoiceInput['environment'] = 'production',
): SubmitZatcaInvoiceInput {
  return {
    scope: { tenantId: tenantId('tenant-1') },
    terminalId: 'terminal-1',
    environment,
    mode,
    invoiceUuid: '018f47f0-7583-7a54-8a3d-11b54a5dc001',
    invoiceHashBase64: INVOICE_HASH,
    invoiceBase64: INVOICE_BASE64,
    productionSecret: { provider: 'test-vault', secretId: 'sha256:' + 'a'.repeat(64) },
  };
}

function resolver() {
  const resolve = vi.fn<ZatcaFatooraCredentialResolver['resolve']>(async () => ({
    binarySecurityToken: TOKEN,
    secret: SECRET,
  }));
  return { resolve };
}

function fetchMock(response: Response) {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

function reported(): Response {
  return new Response(
    JSON.stringify({
      reportingStatus: 'REPORTED',
      validationResults: {
        status: 'PASS',
        infoMessages: [],
        warningMessages: [],
        errorMessages: [],
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function cleared(): Response {
  return new Response(
    JSON.stringify({
      clearanceStatus: 'CLEARED',
      clearedInvoice: INVOICE_BASE64,
      validationResults: {
        status: 'PASS',
        infoMessages: [],
        warningMessages: [],
        errorMessages: [],
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('ZATCA invoice reporting/clearance HTTPS client', () => {
  it.each(['sandbox', 'simulation', 'production'] as const)(
    'posts reporting to the fixed %s endpoint with V2 headers, immutable identity and Basic auth',
    async (environment) => {
      const credentialResolver = resolver();
      const fetchImpl = fetchMock(reported());
      const client = createZatcaInvoiceSubmissionHttpClient({ credentialResolver, fetchImpl });

      await expect(client.submit(input('reporting', environment))).resolves.toEqual({
        kind: 'accepted',
        httpStatus: 200,
        authorityStatus: 'REPORTED',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
      expect(url).toBe(ZATCA_INVOICE_SUBMISSION_ENDPOINTS[environment].reporting);
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toEqual({
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Accept-Language': 'en',
        'Accept-Version': 'V2',
        'Clearance-Status': '0',
        Authorization: `Basic ${Buffer.from(`${TOKEN}:${SECRET}`, 'utf8').toString('base64')}`,
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        invoiceHash: INVOICE_HASH,
        uuid: input().invoiceUuid,
        invoice: INVOICE_BASE64,
      });
    },
  );

  it('uses clearance endpoint/status and requires a canonical cleared invoice before accepting', async () => {
    const credentialResolver = resolver();
    const fetchImpl = fetchMock(cleared());
    const client = createZatcaInvoiceSubmissionHttpClient({ credentialResolver, fetchImpl });

    await expect(client.submit(input('clearance'))).resolves.toEqual({
      kind: 'accepted',
      httpStatus: 200,
      authorityStatus: 'CLEARED',
      clearedInvoiceBase64: INVOICE_BASE64,
    });
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(url).toBe(ZATCA_INVOICE_SUBMISSION_ENDPOINTS.production.clearance);
    expect(init?.headers).toMatchObject({ 'Clearance-Status': '1' });
  });

  it.each([408, 425, 429, 500, 503])(
    'classifies HTTP %s as ambiguous and never retries',
    async (status) => {
      const credentialResolver = resolver();
      const fetchImpl = fetchMock(new Response('ignored', { status }));
      const client = createZatcaInvoiceSubmissionHttpClient({ credentialResolver, fetchImpl });

      await expect(client.submit(input())).resolves.toEqual({
        kind: 'uncertain',
        reason: 'transport',
        httpStatus: status,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each([400, 401, 403, 404, 409, 422])(
    'maps definite HTTP %s refusal without body leakage',
    async (status) => {
      const credentialResolver = resolver();
      const client = createZatcaInvoiceSubmissionHttpClient({
        credentialResolver,
        fetchImpl: fetchMock(new Response('sensitive-authority-diagnostic', { status })),
      });

      const result = await client.submit(input());
      expect(result).toEqual({
        kind: 'rejected',
        httpStatus: status,
        rejectionCode: `HTTP_${status}`,
      });
      expect(JSON.stringify(result)).not.toContain('sensitive-authority-diagnostic');
    },
  );

  it('treats semantic ZATCA validation errors as terminal refusal without reflecting messages', async () => {
    const credentialResolver = resolver();
    const client = createZatcaInvoiceSubmissionHttpClient({
      credentialResolver,
      fetchImpl: fetchMock(
        new Response(
          JSON.stringify({
            reportingStatus: 'NOT_REPORTED',
            validationResults: {
              status: 'ERROR',
              errorMessages: [{ code: 'BR-KSA-TEST', message: 'sensitive merchant detail' }],
            },
          }),
          { status: 200 },
        ),
      ),
    });

    const result = await client.submit(input());
    expect(result).toEqual({
      kind: 'rejected',
      httpStatus: 200,
      rejectionCode: 'ZATCA_VALIDATION_ERROR',
    });
    expect(JSON.stringify(result)).not.toContain('sensitive merchant detail');
  });

  it('fails closed on malformed or unknown 2xx authority responses', async () => {
    const credentialResolver = resolver();
    const client = createZatcaInvoiceSubmissionHttpClient({
      credentialResolver,
      fetchImpl: fetchMock(
        new Response(JSON.stringify({ reportingStatus: 'UNKNOWN' }), { status: 200 }),
      ),
    });
    await expect(client.submit(input())).resolves.toEqual({
      kind: 'uncertain',
      reason: 'response-invalid',
      httpStatus: 200,
    });
  });

  it('fails before network when Production CSID resolution fails', async () => {
    const credentialResolver = resolver();
    credentialResolver.resolve.mockRejectedValueOnce(new Error('vault unavailable'));
    const fetchImpl = fetchMock(reported());
    const client = createZatcaInvoiceSubmissionHttpClient({ credentialResolver, fetchImpl });

    await expect(client.submit(input())).resolves.toEqual({
      kind: 'uncertain',
      reason: 'credential-store',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects malformed UUID/hash/XML before touching credentials or network', async () => {
    const credentialResolver = resolver();
    const fetchImpl = fetchMock(reported());
    const client = createZatcaInvoiceSubmissionHttpClient({ credentialResolver, fetchImpl });

    await expect(client.submit({ ...input(), invoiceUuid: 'bad' })).rejects.toThrow();
    await expect(
      client.submit({ ...input(), invoiceHashBase64: Buffer.alloc(31).toString('base64') }),
    ).rejects.toThrow();
    await expect(
      client.submit({ ...input(), invoiceBase64: Buffer.from('not xml').toString('base64') }),
    ).rejects.toThrow();
    expect(credentialResolver.resolve).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never exposes plaintext Production CSID material in a result', async () => {
    const credentialResolver = resolver();
    const client = createZatcaInvoiceSubmissionHttpClient({
      credentialResolver,
      fetchImpl: fetchMock(reported()),
    });
    const serialized = JSON.stringify(await client.submit(input()));
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(SECRET);
  });
});
