import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  extractZatcaSigningCertificateMaterial,
  type ZatcaCsidEnvironment,
  type ZatcaProductionCsidIssuerPort,
  type ZatcaFatooraSecretHandle,
} from '@korvi/domain';
import type { ZatcaFatooraCredentialStore } from './compliance-csid-http-issuer.js';
import type { ZatcaFatooraCredentialResolver } from './encrypted-fatoora-credential-store.js';

export const ZATCA_PRODUCTION_CSID_ENDPOINTS: Readonly<Record<ZatcaCsidEnvironment, string>> = {
  sandbox: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/production/csids',
  simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation/production/csids',
  production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core/production/csids',
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const COMPLIANCE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,500}$/;

const requestIdSchema = z.union([
  z
    .string()
    .min(1)
    .max(500)
    .refine((value) => value === value.trim()),
  z.number().int().nonnegative().safe(),
]);
const successResponseSchema = z
  .object({
    requestID: requestIdSchema,
    binarySecurityToken: z.string().min(1).max(32_768),
    secret: z.string().min(1).max(8_192),
  })
  .passthrough();

class ResponseLimitError extends Error {}

export interface CreateZatcaProductionCsidHttpIssuerOptions {
  readonly credentialResolver: ZatcaFatooraCredentialResolver;
  readonly credentialStore: ZatcaFatooraCredentialStore;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/**
 * HTTPS adapter for Production CSID onboarding.
 *
 * The current Compliance CSID credentials are decrypted only inside this
 * server boundary and are used exclusively to construct the Basic auth header.
 * Redirects and HTTP retries are forbidden: after the first outbound byte, a
 * missing response is an ambiguous remote side effect that durable provisioning
 * must reconcile rather than replay.
 */
export function createZatcaProductionCsidHttpIssuer(
  options: CreateZatcaProductionCsidHttpIssuerOptions,
): ZatcaProductionCsidIssuerPort {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    1,
    MAX_TIMEOUT_MS,
    'ZATCA Production CSID timeout',
  );
  const maxResponseBytes = boundedInteger(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    1,
    MAX_RESPONSE_BYTES,
    'ZATCA Production CSID response limit',
  );

  return {
    async issue(input) {
      if (!COMPLIANCE_REQUEST_ID.test(input.complianceRequestId)) {
        throw new Error('ZATCA compliance request id is outside allowed bounds.');
      }
      if (input.expectedPublicKeySpkiDer.length === 0) {
        throw new Error('ZATCA expected signing public key must not be empty.');
      }

      let current;
      try {
        current = await options.credentialResolver.resolve({
          scope: input.scope,
          terminalId: input.terminalId,
          handle: input.currentComplianceSecret,
        });
      } catch {
        return { kind: 'uncertain', reason: 'credential-store' };
      }

      const endpoint = ZATCA_PRODUCTION_CSID_ENDPOINTS[input.environment];
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
            Authorization: basicAuthorization(current.binarySecurityToken, current.secret),
          },
          body: JSON.stringify({ compliance_request_id: input.complianceRequestId }),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        clearTimeout(timer);
        return { kind: 'uncertain', reason: 'transport' };
      }

      if (!response.ok) {
        clearTimeout(timer);
        return isDefiniteClientRejection(response.status)
          ? { kind: 'rejected', rejectionCode: `HTTP_${response.status}` }
          : { kind: 'uncertain', reason: 'transport' };
      }

      let bytes: Uint8Array;
      try {
        bytes = await readBoundedResponse(response, maxResponseBytes);
      } catch (error) {
        clearTimeout(timer);
        return error instanceof ResponseLimitError
          ? { kind: 'uncertain', reason: 'response-invalid' }
          : { kind: 'uncertain', reason: 'transport' };
      }
      clearTimeout(timer);

      const parsedJson = parseJson(bytes);
      if (parsedJson === null) return { kind: 'uncertain', reason: 'response-invalid' };
      const parsed = successResponseSchema.safeParse(parsedJson);
      if (!parsed.success) return { kind: 'uncertain', reason: 'response-invalid' };
      const payload = parsed.data;

      let certificateDer: Uint8Array;
      try {
        certificateDer = decodeBinarySecurityTokenCertificate(payload.binarySecurityToken);
        const certificate = extractZatcaSigningCertificateMaterial(certificateDer);
        assertSameBytes(certificate.signingPublicKeySpkiDer, input.expectedPublicKeySpkiDer);
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

function basicAuthorization(username: string, password: string): string {
  if (
    username.length < 1 ||
    username.length > 32_768 ||
    password.length < 1 ||
    password.length > 8_192
  ) {
    throw new Error('ZATCA current Compliance CSID credentials are outside allowed bounds.');
  }
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      throw new ResponseLimitError('response too large');
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
        throw new ResponseLimitError('response too large');
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

function parseJson(bytes: Uint8Array): unknown | null {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function decodeBinarySecurityTokenCertificate(token: string): Uint8Array {
  const trimmed = token.trim();
  if (trimmed.startsWith('-----BEGIN CERTIFICATE-----')) return decodeCertificatePem(trimmed);
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

function assertSameBytes(left: Uint8Array, right: Uint8Array): void {
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
