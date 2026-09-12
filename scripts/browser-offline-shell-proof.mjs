import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const baseUrl = process.env.KORVI_BROWSER_BASE_URL ?? 'http://127.0.0.1:3000';
const chromePort = process.env.KORVI_CHROME_DEBUG_PORT ?? '9222';
const artifactDirectory =
  process.env.KORVI_BROWSER_ARTIFACT_DIR ?? 'artifacts/gate41-offline-shell';
const webPidFile = process.env.KORVI_WEB_PID_FILE;

if (webPidFile === undefined || webPidFile.trim() === '') {
  throw new Error('KORVI_WEB_PID_FILE is required for the hard-outage proof.');
}

await mkdir(artifactDirectory, { recursive: true });

const evidence = [];
function record(message) {
  evidence.push(message);
  console.log(`[proof] ${message}`);
}

class CdpClient {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();

  constructor(url) {
    this.#socket = new WebSocket(url);
    this.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === 'number') {
        const pending = this.#pending.get(message.id);
        if (pending === undefined) return;
        this.#pending.delete(message.id);
        if (message.error !== undefined) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result ?? {});
        return;
      }
      if (typeof message.method !== 'string') return;
      for (const listener of this.#listeners.get(message.method) ?? []) {
        listener(message.params ?? {});
      }
    });
  }

  async ready() {
    if (this.#socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error('Chrome DevTools websocket failed to open.'));
      };
      const cleanup = () => {
        this.#socket.removeEventListener('open', opened);
        this.#socket.removeEventListener('error', failed);
      };
      this.#socket.addEventListener('open', opened, { once: true });
      this.#socket.addEventListener('error', failed, { once: true });
    });
  }

  on(method, listener) {
    const listeners = this.#listeners.get(method) ?? [];
    listeners.push(listener);
    this.#listeners.set(method, listeners);
  }

  async send(method, params = {}) {
    await this.ready();
    const id = this.#nextId++;
    const response = new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  close() {
    this.#socket.close();
  }
}

async function createTarget(url) {
  const endpoint = `http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(url)}`;
  const response = await fetch(endpoint, { method: 'PUT' });
  if (!response.ok) throw new Error(`Unable to create Chrome target: ${String(response.status)}`);
  return response.json();
}

async function waitForServerDown(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(500) });
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Web server did not stop; the offline proof would be invalid.');
}

const target = await createTarget(`${baseUrl}/`);
assert.equal(typeof target.webSocketDebuggerUrl, 'string');
const cdp = new CdpClient(target.webSocketDebuggerUrl);
await cdp.ready();
await Promise.all([
  cdp.send('Page.enable'),
  cdp.send('Runtime.enable'),
  cdp.send('Network.enable'),
]);

const responses = [];
cdp.on('Network.responseReceived', (params) => {
  const response = params.response;
  if (response === undefined || typeof response.url !== 'string') return;
  responses.push({
    url: response.url,
    type: params.type ?? '',
    status: response.status ?? 0,
    fromServiceWorker: response.fromServiceWorker === true,
  });
});

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.text ?? 'Browser evaluation failed.');
  }
  return result.result?.value;
}

async function waitFor(expression, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return;
    } catch {
      // A navigation can replace the execution context between polls.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function capture(name) {
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  assert.equal(typeof result.data, 'string');
  await writeFile(`${artifactDirectory}/${name}.png`, Buffer.from(result.data, 'base64'));
}

async function readCacheState() {
  return evaluate(`(async () => {
    const names = await caches.keys();
    const cachesWithKeys = [];
    for (const name of names) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      cachesWithKeys.push({ name, urls: keys.map((request) => request.url) });
    }
    const metaCache = await caches.open('korvi-pos-shell-meta-v1');
    const metaResponse = await metaCache.match('/__korvi_internal__/active-shell-cache');
    const meta = metaResponse === undefined ? null : await metaResponse.json();
    return { names, caches: cachesWithKeys, meta };
  })()`);
}

try {
  await waitFor(
    `document.readyState === 'complete' || document.readyState === 'interactive'`,
    'initial cashier document',
  );
  assert.equal(await evaluate('window.isSecureContext'), true, 'Loopback must be a secure context.');
  await waitFor(
    `(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const registration = await navigator.serviceWorker.ready;
      return registration.active !== null;
    })()`,
    'active service worker',
  );
  await waitFor('navigator.serviceWorker.controller !== null', 'service worker controller');

  const swResponse = await fetch(`${baseUrl}/sw.js`, { cache: 'no-store' });
  assert.equal(swResponse.status, 200);
  const cacheControl = swResponse.headers.get('cache-control') ?? '';
  assert.match(cacheControl, /no-store/i);
  assert.equal(swResponse.headers.get('service-worker-allowed'), '/');
  assert.equal(swResponse.headers.get('x-content-type-options'), 'nosniff');
  record('service_worker_headers=PASS');

  const onlineCacheState = await readCacheState();
  assert.equal(typeof onlineCacheState.meta?.active, 'string');
  assert.match(onlineCacheState.meta.active, /^korvi-pos-shell-v1-[0-9a-f]{64}$/);
  const activeCache = onlineCacheState.caches.find(
    (entry) => entry.name === onlineCacheState.meta.active,
  );
  assert.notEqual(activeCache, undefined, 'Active shell cache must exist.');
  const activeUrls = activeCache.urls.map((value) => new URL(value));
  assert.equal(activeUrls.some((url) => url.pathname === '/'), true, 'Cashier HTML must be cached.');
  assert.equal(
    activeUrls.some((url) => url.pathname === '/__korvi_internal__/shell-complete'),
    true,
    'Atomic completion marker must be present.',
  );
  assert.equal(
    activeUrls.some((url) => url.pathname.startsWith('/_next/static/')),
    true,
    'Next production assets must be cached.',
  );
  assert.equal(
    onlineCacheState.caches
      .flatMap((entry) => entry.urls)
      .some((value) => new URL(value).pathname.startsWith('/v1/')),
    false,
    'Authenticated API responses must never enter CacheStorage.',
  );
  record(`active_shell_cache=${onlineCacheState.meta.active}`);
  record(`cached_shell_entries=${String(activeCache.urls.length)}`);
  record('api_cache_exclusion=PASS');

  await capture('online-primed-shell');

  const pidText = (await readFile(webPidFile, 'utf8')).trim();
  const webPid = Number(pidText);
  assert.equal(Number.isSafeInteger(webPid) && webPid > 1, true, 'Web PID must be safe.');
  process.kill(-webPid, 'SIGTERM');
  await waitForServerDown(`${baseUrl}/`);
  record('web_server_hard_stop=PASS');

  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  const responseStart = responses.length;
  const offlineUrl = `${baseUrl}/?gate41-offline-proof=${Date.now().toString(10)}`;
  await cdp.send('Page.navigate', { url: offlineUrl });

  await waitFor(
    `document.readyState === 'complete' || document.readyState === 'interactive'`,
    'offline cashier document',
  );
  await waitFor('navigator.serviceWorker.controller !== null', 'offline service worker controller');
  await waitFor(
    `document.body.textContent?.includes('الخدمة غير متاحة') === true`,
    'offline-safe unavailable session state',
  );

  const offlineDocument = responses.slice(responseStart).find((entry) => {
    if (entry.type !== 'Document') return false;
    const url = new URL(entry.url);
    return url.origin === baseUrl && url.pathname === '/';
  });
  assert.notEqual(offlineDocument, undefined, 'Offline document response must be observed.');
  assert.equal(
    offlineDocument.fromServiceWorker,
    true,
    'Document must come from the Service Worker.',
  );
  assert.equal(offlineDocument.status, 200);

  const offlineStaticResponses = responses.slice(responseStart).filter((entry) => {
    const url = new URL(entry.url);
    return url.pathname.startsWith('/_next/static/') && entry.fromServiceWorker;
  });
  assert.equal(
    offlineStaticResponses.length > 0,
    true,
    'At least one Next asset must be served by the Service Worker during the outage.',
  );

  const navigationTiming = await evaluate(`(() => {
    const entry = performance.getEntriesByType('navigation').at(-1);
    return entry === undefined
      ? null
      : { workerStart: entry.workerStart, transferSize: entry.transferSize, responseStatus: entry.responseStatus };
  })()`);
  assert.notEqual(navigationTiming, null);
  assert.equal(navigationTiming.workerStart > 0, true, 'Navigation must pass through a worker.');
  assert.equal(navigationTiming.responseStatus, 200);

  const apiAttempt = await evaluate(`fetch('/v1/auth/me', { cache: 'no-store' })
    .then((response) => ({ resolved: true, status: response.status }))
    .catch(() => ({ resolved: false }))`);
  assert.equal(
    apiAttempt.resolved,
    false,
    'API request must not be satisfied by the offline shell worker.',
  );

  const offlineCacheState = await readCacheState();
  assert.equal(
    offlineCacheState.caches
      .flatMap((entry) => entry.urls)
      .some((value) => new URL(value).pathname.startsWith('/v1/')),
    false,
  );

  assert.equal(await evaluate(`document.documentElement.lang`), 'ar');
  assert.equal(await evaluate(`document.documentElement.dir`), 'rtl');
  await capture('hard-outage-offline-shell');

  record('offline_document_from_service_worker=PASS');
  record(`offline_static_service_worker_responses=${String(offlineStaticResponses.length)}`);
  record('offline_api_bypass=PASS');
  record('cashier_shell_hard_outage=PASS');
} finally {
  cdp.close();
  await writeFile(`${artifactDirectory}/proof.txt`, `${evidence.join('\n')}\n`);
}
