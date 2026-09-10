import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  extractZatcaSigningCertificateMaterial,
  type TenantScope,
  type ZatcaComplianceCsidIssuerPort,
  type ZatcaCsidEnvironment,
  type ZatcaFatooraSecretHandle,
} from '@korvi/domain';

export const ZATCA_COMPLIANCE_CSID_ENDPOINTS: Readonly<Record<ZatcaCsidEnvironment, string>> = {
  sandbox: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/compliance',
  simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation/compliance',
  production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core/compliance',
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

const successResponseSchema = z
  .object({
    requestID: z.union([z.string().min(1).max(500), z.number().int().nonnegative()]),
    binarySecurityToken: z.string().min(1).max(32_768),
    secret: z.string().min(1).max(8_192),
  })
  .passthrough();

export interface ZatcaFatooraCredentialStoreInput {
  readonly scope: TenantScope;
  readonly terminalId: string;
  /** SHA-256 identity of the public X.509 certificate. */
  readonly credentialId: string;
  /** Exact ZATCA-issued Basic Authentication username. */
  readonly binarySecurityToken: string;
  /** Exact ZATCA-issued Basic Authentication password. Never persist in PostgreSQL. */
  readonly secret: string;
}

/**
 * Server-only authority for raw Fatoora authentication material.
 *
 * Implementations MUST encrypt at rest and make `put` idempotent for the same
 * tenant + terminal + credentialId. A store ambiguity after ZATCA has issued a
 * CSID must never cause the HTTP issuer to repeat the issuance POST.
 */
export interface ZatcaFatooraCredentialStore {
  put(input: ZatcaFatooraCredentialStoreInput): Promise<ZatcaFatooraSecretHandle>;
}

export interface CreateZatcaComplianceCsidHttpIssuerOptions {
  readonly credentialStore: ZatcaFatooraCredentialStore;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/**
 * HTTPS adapter for ZATCA Compliance CSID issuance.
 *
 * Security properties are deliberate:
 * - the request origin comes only from the closed environment map above;
 * - redirects are rejected so OTP/CSR bytes cannot be forwarded to a new host;
 * - there is exactly one POST attempt; retry/reconciliation belongs to durable
 *   provisioning state, never to the HTTP client;
 * - response bytes are bounded before JSON parsing;
 * - raw Fatoora credentials are committed to the server-only store before this
 *   adapter returns, and only the opaque handle crosses the domain boundary.
 */
export function createZatcaComplianceCsidHttpIssuer(
  options: CreateZatcaComplianceCsidHttpIssuerOptions,
): ZatcaComplianceCsidIssuerPort {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    1,
    MAX_TIMEOUT_MS,
    'ZATCA Compliance CSID timeout',
  );
  const maxResponseBytes = boundedInteger(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    1,
    MAX_RESPONSE_BYTES,
    'ZATCA Compliance CSID response limit',
  );

  return {
    async issue(input) {
      const endpoint = ZATCA_COMPLIANCE_CSID_ENDPOINTS[input.environment];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'Accept-Version': 'V2',
            OTP: input.otp,
          },
          body: JSON.stringify({ csr: encodeCsrForZatca(input.csrDer) }),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        return { kind: 'uncertain', reason: 'transport' };
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        if (isDefiniteClientRejection(response.status)) {
          return { kind: 'rejected', rejectionCode: `HTTP_${response.status}` };
        }
        return { kind: 'uncertain', reason: 'transport' };
      }

      let payload: z.infer<typeof successResponseSchema>;
      try {
        const bytes = await readBoundedResponse(response, maxResponseBytes);
        const parsed = successResponseSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
        if (!parsed.success) {
          return { kind: 'uncertain', reason: 'response-invalid' };
        }
        payload = parsed.data;
      } catch {
        return { kind: 'uncertain', reason: 'response-invalid' };
      }

      let certificateDer: Uint8Array;
      try {
        certificateDer = decodeBinarySecurityTokenCertificate(payload.binarySecurityToken);
        const certificate = extractZatcaSigningCertificateMaterial(certificateDer);
        assertSameBytes(
          certificate.signingPublicKeySpkiDer,
          input.expectedPublicKeySpkiDer,
          'issued certificate key mismatch',
        );
      } catch {
        return { kind: 'uncertain', reason: 'response-invalid' };
      }

      const credentialId = `sha256:${createHash('sha256').update(certificateDer).digest('hex')}`;
      let fatooraSecret: ZatcaFatooraSecretHandle;
      try {
        fatooraSecret = await options.credentialStore.put({
          scope: input.scope,
          terminalId: input.terminalId,
          credentialId,
          binarySecurityToken: payload.binarySecurityToken,
          secret: payload.secret,
        });
        assertSecretHandle(fatooraSecret);
      } catch {
        return { kind: 'uncertain', reason: 'credential-store' };
      }

      return {
        kind: 'issued',
        remoteRequestId: String(payload.requestID),
        credentialId,
        certificateDer: Uint8Array.from(certificateDer),
        fatooraSecret: { ...fatooraSecret },
      };
    },
  };
}

function encodeCsrForZatca(csrDer: Uint8Array): string {
  if (csrDer.length === 0 || csrDer.length > 64 * 1024) {
    throw new Error('invalid CSR size');
  }
  const base64 = Buffer.from(csrDer).toString('base64');
  const lines = base64.match(/.{1,64}/g);
  if (lines === null) throw new Error('invalid CSR');
  const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${lines.join('\n')}\n-----END CERTIFICATE REQUEST-----\n`;
  return Buffer.from(pem, 'utf8').toString('base64');
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      throw new Error('response too large');
    }
  }
  if (response.body === null) throw new Error('missing response body');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('response too large');
      }
      chunks.push(Uint8Array.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function decodeBinarySecurityTokenCertificate(token: string): Uint8Array {
  const trimmed = token.trim();
  if (trimmed.startsWith('-----BEGIN CERTIFICATE-----')) {
    return decodeCertificatePem(trimmed);
  }

  const first = decodeBase64Strict(trimmed);
  if (first.byteLength > 0 && first[0] === 0x30) return first;

  const text = new TextDecoder('utf-8', { fatal: true }).decode(first).trim();
  if (text.startsWith('-----BEGIN CERTIFICATE-----')) return decodeCertificatePem(text);

  const second = decodeBase64Strict(text);
  if (second.byteLength === 0 || second[0] !== 0x30) throw new Error('invalid certificate token');
  return second;
}

function decodeCertificatePem(pem: string): Uint8Array {
  const match =
    /^-----BEGIN CERTIFICATE-----\s+([A-Za-z0-9+/=\r\n]+)\s+-----END CERTIFICATE-----$/.exec(
      pem.trim(),
    );
  if (match?.[1] === undefined) throw new Error('invalid certificate PEM');
  return decodeBase64Strict(match[1].replace(/\s+/g, ''));
}

function decodeBase64Strict(value: string): Uint8Array {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('invalid base64');
  }
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

function isDefiniteClientRejection(status: number): boolean {
  return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

function assertSameBytes(left: Uint8Array, right: Uint8Array, _message: string): void {
  if (left.length !== right.length || !timingSafeEqual(Buffer.from(left), Buffer.from(right))) {
    throw new Error('certificate key mismatch');
  }
}

function assertSecretHandle(handle: ZatcaFatooraSecretHandle): void {
  if (
    handle.provider.trim() !== handle.provider ||
    handle.provider.length < 1 ||
    handle.provider.length > 100 ||
    handle.secretId.trim() !== handle.secretId ||
    handle.secretId.length < 1 ||
    handle.secretId.length > 1_000
  ) {
    throw new Error('invalid credential store handle');
  }
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
