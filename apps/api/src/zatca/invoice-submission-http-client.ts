import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  SubmitZatcaInvoiceInput,
  ZatcaCsidEnvironment,
  ZatcaInvoiceSubmissionMode,
  ZatcaInvoiceSubmissionPort,
} from '@korvi/domain';
import type { ZatcaFatooraCredentialResolver } from './encrypted-fatoora-credential-store.js';

const REPORTING_PATH = 'invoices/reporting/single';
const CLEARANCE_PATH = 'invoices/clearance/single';

const BASE_URLS: Readonly<Record<ZatcaCsidEnvironment, string>> = {
  sandbox: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
  simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
  production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',
};

export const ZATCA_INVOICE_SUBMISSION_ENDPOINTS = Object.freeze(
  Object.fromEntries(
    (Object.keys(BASE_URLS) as ZatcaCsidEnvironment[]).map((environment) => [
      environment,
      Object.freeze({
        reporting: `${BASE_URLS[environment]}/${REPORTING_PATH}`,
        clearance: `${BASE_URLS[environment]}/${CLEARANCE_PATH}`,
      }),
    ]),
  ) as Readonly<Record<ZatcaCsidEnvironment, Readonly<Record<ZatcaInvoiceSubmissionMode, string>>>>,
);

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_INVOICE_BASE64_CHARACTERS = 4 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const authorityMessageSchema = z.object({
  type: z.string().max(100).optional(),
  code: z.string().max(500).optional(),
  category: z.string().max(100).optional(),
  message: z.string().max(8_192).optional(),
  status: z.string().max(100).optional(),
}).passthrough();

const validationResultsSchema = z.object({
  status: z.string().max(100).optional(),
  infoMessages: z.array(authorityMessageSchema).max(1_000).optional(),
  warningMessages: z.array(authorityMessageSchema).max(1_000).optional(),
  errorMessages: z.array(authorityMessageSchema).max(1_000).optional(),
}).passthrough();

const successResponseSchema = z.object({
  reportingStatus: z.string().max(100).optional(),
  clearanceStatus: z.string().max(100).optional(),
  clearedInvoice: z.string().min(1).max(MAX_INVOICE_BASE64_CHARACTERS).optional(),
  validationResults: validationResultsSchema.optional(),
}).passthrough();

class ResponseLimitError extends Error {}

export interface CreateZatcaInvoiceSubmissionHttpClientOptions {
  readonly credentialResolver: ZatcaFatooraCredentialResolver;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/**
 * FATOORA reporting/clearance transport adapter.
 *
 * There is deliberately no retry loop here. A timeout, connection loss, 5xx,
 * 408, 425 or 429 after bytes may have left the process is returned as
 * `uncertain`; only the durable Gate-40 state machine may decide what to do
 * next, using the exact same immutable UUID/hash/XML payload.
 */
export function createZatcaInvoiceSubmissionHttpClient(
  options: CreateZatcaInvoiceSubmissionHttpClientOptions,
): ZatcaInvoiceSubmissionPort {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    1,
    MAX_TIMEOUT_MS,
    'ZATCA invoice submission timeout',
  );
  const maxResponseBytes = boundedInteger(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    1,
    MAX_RESPONSE_BYTES,
    'ZATCA invoice submission response limit',
  );

  return {
    async submit(input) {
      validateInput(input);

      let credential;
      try {
        credential = await options.credentialResolver.resolve({
          scope: input.scope,
          terminalId: input.terminalId,
          handle: input.productionSecret,
        });
      } catch {
        return { kind: 'uncertain', reason: 'credential-store' };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(
          ZATCA_INVOICE_SUBMISSION_ENDPOINTS[input.environment][input.mode],
          {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'Accept-Language': 'en',
              'Accept-Version': 'V2',
              'Clearance-Status': input.mode === 'clearance' ? '1' : '0',
              Authorization: basicAuthorization(
                credential.binarySecurityToken,
                credential.secret,
              ),
            },
            body: JSON.stringify({
              invoiceHash: input.invoiceHashBase64,
              uuid: input.invoiceUuid,
              invoice: input.invoiceBase64,
            }),
            redirect: 'error',
            signal: controller.signal,
          },
        );
      } catch {
        clearTimeout(timer);
        return { kind: 'uncertain', reason: 'transport' };
      }

      if (!response.ok) {
        clearTimeout(timer);
        if (isDefiniteClientRejection(response.status)) {
          return {
            kind: 'rejected',
            httpStatus: response.status,
            rejectionCode: `HTTP_${response.status}`,
          };
        }
        return { kind: 'uncertain', reason: 'transport', httpStatus: response.status };
      }

      let bytes: Uint8Array;
      try {
        bytes = await readBoundedResponse(response, maxResponseBytes);
      } catch (error) {
        clearTimeout(timer);
        return error instanceof ResponseLimitError
          ? { kind: 'uncertain', reason: 'response-invalid', httpStatus: response.status }
          : { kind: 'uncertain', reason: 'transport', httpStatus: response.status };
      }
      clearTimeout(timer);

      const parsedJson = parseJson(bytes);
      if (parsedJson === null) {
        return { kind: 'uncertain', reason: 'response-invalid', httpStatus: response.status };
      }
      const parsed = successResponseSchema.safeParse(parsedJson);
      if (!parsed.success) {
        return { kind: 'uncertain', reason: 'response-invalid', httpStatus: response.status };
      }

      const payload = parsed.data;
      if (hasAuthorityErrors(payload.validationResults)) {
        return {
          kind: 'rejected',
          httpStatus: response.status,
          rejectionCode: 'ZATCA_VALIDATION_ERROR',
        };
      }

      if (input.mode === 'reporting') {
        if (payload.reportingStatus !== 'REPORTED') {
          return { kind: 'uncertain', reason: 'response-invalid', httpStatus: response.status };
        }
        return { kind: 'accepted', httpStatus: response.status, authorityStatus: 'REPORTED' };
      }

      if (payload.clearanceStatus !== 'CLEARED' || payload.clearedInvoice === undefined) {
        return { kind: 'uncertain', reason: 'response-invalid', httpStatus: response.status };
      }
      if (!isCanonicalBase64(payload.clearedInvoice)) {
        return { kind: 'uncertain', reason: 'response-invalid', httpStatus: response.status };
      }
      return {
        kind: 'accepted',
        httpStatus: response.status,
        authorityStatus: 'CLEARED',
        clearedInvoiceBase64: payload.clearedInvoice,
      };
    },
  };
}

function validateInput(input: SubmitZatcaInvoiceInput): void {
  if (!UUID_PATTERN.test(input.invoiceUuid)) {
    throw new Error('ZATCA invoice UUID is malformed.');
  }
  const invoiceHash = decodeBase64Strict(input.invoiceHashBase64, 64);
  if (invoiceHash.byteLength !== 32) {
    throw new Error('ZATCA invoice hash must be exactly one SHA-256 digest.');
  }
  if (
    input.invoiceBase64.length < 1 ||
    input.invoiceBase64.length > MAX_INVOICE_BASE64_CHARACTERS
  ) {
    throw new Error('ZATCA invoice payload is outside allowed bounds.');
  }
  const invoiceBytes = decodeBase64Strict(input.invoiceBase64, MAX_INVOICE_BASE64_CHARACTERS);
  if (invoiceBytes.byteLength < 16) {
    throw new Error('ZATCA invoice payload is unexpectedly small.');
  }
  const xmlPrefix = new TextDecoder('utf-8', { fatal: true }).decode(
    invoiceBytes.subarray(0, Math.min(invoiceBytes.byteLength, 256)),
  );
  if (!xmlPrefix.trimStart().startsWith('<')) {
    throw new Error('ZATCA invoice payload is not UTF-8 XML.');
  }
}

function hasAuthorityErrors(
  validationResults: z.infer<typeof validationResultsSchema> | undefined,
): boolean {
  if (validationResults === undefined) return false;
  if (validationResults.errorMessages !== undefined && validationResults.errorMessages.length > 0) {
    return true;
  }
  return validationResults.status?.toUpperCase() === 'ERROR';
}

function basicAuthorization(username: string, password: string): string {
  if (
    username.length < 1 ||
    username.length > 32_768 ||
    password.length < 1 ||
    password.length > 8_192
  ) {
    throw new Error('ZATCA Production CSID credentials are outside allowed bounds.');
  }
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

function isDefiniteClientRejection(status: number): boolean {
  return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
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

function decodeBase64Strict(value: string, maxCharacters: number): Uint8Array {
  if (
    value.length < 1 ||
    value.length > maxCharacters ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('invalid base64');
  }
  const decoded = Uint8Array.from(Buffer.from(value, 'base64'));
  const canonical = Buffer.from(decoded).toString('base64');
  if (
    canonical.length !== value.length ||
    !timingSafeEqual(Buffer.from(canonical, 'ascii'), Buffer.from(value, 'ascii'))
  ) {
    throw new Error('non-canonical base64');
  }
  return decoded;
}

function isCanonicalBase64(value: string): boolean {
  try {
    decodeBase64Strict(value, MAX_INVOICE_BASE64_CHARACTERS);
    return true;
  } catch {
    return false;
  }
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}
