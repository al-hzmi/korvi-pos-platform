import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 502, 503, 504]);
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ProbeFailure extends Error {
  constructor(check) {
    super(`external staging probe failed: ${check}`);
    this.name = 'ProbeFailure';
  }
}

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new ProbeFailure(`invalid_${name.toLowerCase()}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new ProbeFailure(`invalid_${name.toLowerCase()}`);
  return value;
}

function publicHttpsOrigin(name) {
  const raw = process.env[name];
  if (raw === undefined) throw new ProbeFailure(`missing_${name.toLowerCase()}`);

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ProbeFailure(`invalid_${name.toLowerCase()}`);
  }

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new ProbeFailure(`unsafe_${name.toLowerCase()}`);
  }
  return url;
}

function safeHeaders(response) {
  return {
    contentType: response.headers.get('content-type') ?? '',
    cacheControl: response.headers.get('cache-control') ?? '',
    requestId: response.headers.get('x-request-id') ?? '',
  };
}

function assertRequestId(headers, check) {
  if (!UUID_V7.test(headers.requestId)) throw new ProbeFailure(`${check}_request_id`);
}

async function jsonBody(response, check) {
  try {
    return await response.json();
  } catch {
    throw new ProbeFailure(`${check}_json`);
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestWithRetry(url, method, checkName, retry) {
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(retry.timeoutMs),
      });
      if (RETRYABLE_STATUS.has(response.status) && attempt < retry.maxAttempts) {
        await response.body?.cancel().catch(() => undefined);
        await sleep(retry.retryDelayMs);
        continue;
      }
      return { response, attempt };
    } catch {
      if (attempt === retry.maxAttempts) throw new ProbeFailure(`${checkName}_transport`);
      await sleep(retry.retryDelayMs);
    }
  }
  throw new ProbeFailure(`${checkName}_unreachable`);
}

async function apiJsonCheck(origin, path, expectedStatus, expectedBody, retry) {
  const checkName = path === '/health' ? 'api_health' : 'api_readiness';
  const { response, attempt } = await requestWithRetry(
    new URL(path, origin),
    'GET',
    checkName,
    retry,
  );
  const headers = safeHeaders(response);
  if (response.status !== expectedStatus) throw new ProbeFailure(`${checkName}_status`);
  if (!headers.contentType.toLowerCase().includes('application/json')) {
    throw new ProbeFailure(`${checkName}_content_type`);
  }
  assertRequestId(headers, checkName);
  const body = await jsonBody(response, checkName);
  if (body?.status !== expectedBody.status || Object.keys(body).length !== 1) {
    throw new ProbeFailure(`${checkName}_body`);
  }
  return { name: checkName, result: 'PASS', status: response.status, attempt };
}

async function anonymousMetricsCheck(origin, retry) {
  const checkName = 'anonymous_metrics_refusal';
  const { response, attempt } = await requestWithRetry(
    new URL('/metrics', origin),
    'GET',
    checkName,
    retry,
  );
  const headers = safeHeaders(response);
  if (response.status !== 401) throw new ProbeFailure(`${checkName}_status`);
  if (
    !headers.cacheControl
      .toLowerCase()
      .split(',')
      .map((value) => value.trim())
      .includes('no-store')
  ) {
    throw new ProbeFailure(`${checkName}_cache_control`);
  }
  if (!headers.contentType.toLowerCase().includes('application/json')) {
    throw new ProbeFailure(`${checkName}_content_type`);
  }
  assertRequestId(headers, checkName);
  const body = await jsonBody(response, checkName);
  if (body?.error !== 'unauthorized' || Object.keys(body).length !== 1) {
    throw new ProbeFailure(`${checkName}_body`);
  }
  return { name: checkName, result: 'PASS', status: response.status, attempt };
}

async function webCheck(origin, retry) {
  const checkName = 'web_root';
  const { response, attempt } = await requestWithRetry(origin, 'GET', checkName, retry);
  const headers = safeHeaders(response);
  if (response.status !== 200) throw new ProbeFailure(`${checkName}_status`);
  if (!headers.contentType.toLowerCase().includes('text/html')) {
    throw new ProbeFailure(`${checkName}_content_type`);
  }
  await response.body?.cancel().catch(() => undefined);
  return { name: checkName, result: 'PASS', status: response.status, attempt };
}

async function main() {
  const apiOrigin = publicHttpsOrigin('KORVI_PROBE_API_ORIGIN');
  const webOrigin = publicHttpsOrigin('KORVI_PROBE_WEB_ORIGIN');
  const evidencePath =
    process.env.KORVI_PROBE_EVIDENCE_PATH ?? 'artifacts/external-staging-probe.json';
  const retry = {
    timeoutMs: positiveInteger('KORVI_PROBE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
    maxAttempts: positiveInteger('KORVI_PROBE_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS),
    retryDelayMs: positiveInteger('KORVI_PROBE_RETRY_DELAY_MS', DEFAULT_RETRY_DELAY_MS),
  };

  const evidence = {
    schemaVersion: 1,
    checkedAtUtc: new Date().toISOString(),
    sourceCommit: process.env.GITHUB_SHA ?? 'unknown',
    deploymentIdentityBound: false,
    scope: 'external_staging_surface',
    apiHost: apiOrigin.host,
    webHost: webOrigin.host,
    checks: [],
  };

  await mkdir(dirname(evidencePath), { recursive: true });

  try {
    evidence.checks.push(await apiJsonCheck(apiOrigin, '/health', 200, { status: 'ok' }, retry));
    evidence.checks.push(await apiJsonCheck(apiOrigin, '/ready', 200, { status: 'ready' }, retry));
    evidence.checks.push(await anonymousMetricsCheck(apiOrigin, retry));
    evidence.checks.push(await webCheck(webOrigin, retry));
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    console.log(
      '[ok] external staging surface: health, database readiness, metrics refusal, web root',
    );
  } catch (error) {
    evidence.checks.push({
      name:
        error instanceof ProbeFailure
          ? error.message.replace('external staging probe failed: ', '')
          : 'unknown',
      result: 'FAIL',
    });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    throw error instanceof ProbeFailure ? error : new ProbeFailure('unknown');
  }
}

await main();
