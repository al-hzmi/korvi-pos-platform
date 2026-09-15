/* global self, caches */
'use strict';

const SHELL_PATH = '/';
const STATIC_PREFIXES = ['/_next/static/', '/brand/'];
const SHELL_CACHE_PREFIX = 'korvi-pos-shell-v1-';
const META_CACHE_NAME = 'korvi-pos-shell-meta-v1';
const META_PATH = '/__korvi_internal__/active-shell-cache';
const COMPLETE_PATH = '/__korvi_internal__/shell-complete';

const META_KEY = new URL(META_PATH, self.location.origin).href;
const COMPLETE_KEY = new URL(COMPLETE_PATH, self.location.origin).href;
const SHELL_KEY = new URL(SHELL_PATH, self.location.origin).href;

let snapshotFlight = Promise.resolve();

function isAllowedStaticUrl(url) {
  return (
    url.origin === self.location.origin &&
    STATIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))
  );
}

function isShellNavigationRequest(request) {
  if (request.method !== 'GET' || request.mode !== 'navigate') return false;
  const url = new URL(request.url);
  return url.origin === self.location.origin && url.pathname === SHELL_PATH;
}

function isCacheableHtmlResponse(response) {
  const contentType = response.headers.get('content-type') ?? '';
  return (
    response.status === 200 &&
    !response.redirected &&
    response.type !== 'opaque' &&
    contentType.toLowerCase().includes('text/html')
  );
}

function isCacheableStaticResponse(response) {
  const contentType = response.headers.get('content-type') ?? '';
  return (
    response.status === 200 &&
    !response.redirected &&
    response.type !== 'opaque' &&
    !contentType.toLowerCase().includes('text/html')
  );
}

function extractHtmlAssetUrls(html) {
  const urls = new Set();
  const attributePattern = /\b(?:src|href)=["']([^"'<>]+)["']/g;
  let match;
  while ((match = attributePattern.exec(html)) !== null) {
    const raw = match[1];
    if (raw === undefined || raw === '' || raw.startsWith('#')) continue;
    try {
      const url = new URL(raw, self.location.origin);
      if (isAllowedStaticUrl(url)) urls.add(url.href);
    } catch {
      // Malformed references cannot be shell dependencies.
    }
  }
  return urls;
}

function extractCssAssetUrls(css, baseUrl) {
  const urls = new Set();
  const urlPattern = /url\(\s*(["']?)([^"')]+)\1\s*\)/g;
  let match;
  while ((match = urlPattern.exec(css)) !== null) {
    const raw = match[2]?.trim();
    if (raw === undefined || raw === '' || raw.startsWith('#')) continue;
    try {
      const url = new URL(raw, baseUrl);
      if (isAllowedStaticUrl(url)) urls.add(url.href);
    } catch {
      // Malformed references cannot be shell dependencies.
    }
  }
  return urls;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readMeta() {
  const cache = await caches.open(META_CACHE_NAME);
  const response = await cache.match(META_KEY);
  if (response === undefined) return null;

  try {
    const value = await response.json();
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof value.active !== 'string' ||
      !value.active.startsWith(SHELL_CACHE_PREFIX)
    ) {
      return null;
    }
    const previous =
      typeof value.previous === 'string' &&
      value.previous.startsWith(SHELL_CACHE_PREFIX) &&
      value.previous !== value.active
        ? value.previous
        : null;
    return { active: value.active, previous };
  } catch {
    return null;
  }
}

async function writeMeta(meta) {
  const cache = await caches.open(META_CACHE_NAME);
  await cache.put(
    META_KEY,
    new Response(JSON.stringify(meta), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
  );
}

async function cleanupShellCaches(meta) {
  const keep = new Set([meta.active, meta.previous].filter((name) => name !== null));
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && !keep.has(name))
      .map((name) => caches.delete(name)),
  );
}

async function fetchStaticIntoCache(url, cache, manifest, seen) {
  if (seen.has(url.href)) return;
  seen.add(url.href);

  const response = await fetch(
    new Request(url.href, {
      method: 'GET',
      cache: 'reload',
      credentials: 'same-origin',
      redirect: 'error',
    }),
  );
  if (!isCacheableStaticResponse(response)) {
    throw new Error(`Offline shell dependency is not cacheable: ${url.pathname}`);
  }

  await cache.put(url.href, response.clone());
  manifest.add(url.href);

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('text/css')) return;

  const css = await response.text();
  const dependencies = [...extractCssAssetUrls(css, url.href)];
  await Promise.all(
    dependencies.map((href) => fetchStaticIntoCache(new URL(href), cache, manifest, seen)),
  );
}

async function buildSnapshot(htmlResponse) {
  if (!isCacheableHtmlResponse(htmlResponse)) {
    throw new Error('Korvi cashier shell HTML is not cacheable.');
  }

  const responseForCache = htmlResponse.clone();
  const html = await htmlResponse.text();
  const cacheName = `${SHELL_CACHE_PREFIX}${await sha256Hex(html)}`;
  const existing = await caches.open(cacheName);
  const existingComplete = await existing.match(COMPLETE_KEY);

  if (existingComplete !== undefined) {
    const current = await readMeta();
    const previous =
      current?.active !== undefined && current.active !== cacheName
        ? current.active
        : (current?.previous ?? null);
    const nextMeta = { active: cacheName, previous: previous === cacheName ? null : previous };
    await writeMeta(nextMeta);
    await cleanupShellCaches(nextMeta);
    return cacheName;
  }

  await caches.delete(cacheName);
  const cache = await caches.open(cacheName);
  const manifest = new Set([SHELL_KEY]);
  const seen = new Set();

  try {
    await cache.put(SHELL_KEY, responseForCache);
    const assets = [...extractHtmlAssetUrls(html)];
    await Promise.all(
      assets.map((href) => fetchStaticIntoCache(new URL(href), cache, manifest, seen)),
    );
    await cache.put(
      COMPLETE_KEY,
      new Response(
        JSON.stringify({
          shell: SHELL_KEY,
          assets: [...manifest].filter((url) => url !== SHELL_KEY),
        }),
        { headers: { 'content-type': 'application/json; charset=utf-8' } },
      ),
    );
  } catch (error) {
    await caches.delete(cacheName);
    throw error;
  }

  const current = await readMeta();
  const previous =
    current?.active !== undefined && current.active !== cacheName
      ? current.active
      : (current?.previous ?? null);
  const nextMeta = { active: cacheName, previous: previous === cacheName ? null : previous };
  await writeMeta(nextMeta);
  await cleanupShellCaches(nextMeta);
  return cacheName;
}

function scheduleSnapshot(response) {
  const next = snapshotFlight.then(() => buildSnapshot(response));
  snapshotFlight = next.catch(() => undefined);
  return next;
}

async function primeShell() {
  const response = await fetch(
    new Request(SHELL_KEY, {
      method: 'GET',
      cache: 'reload',
      credentials: 'same-origin',
      redirect: 'error',
      headers: { accept: 'text/html' },
    }),
  );
  await scheduleSnapshot(response);
}

async function matchShellFallback() {
  const meta = await readMeta();
  if (meta === null) return undefined;
  for (const cacheName of [meta.active, meta.previous]) {
    if (cacheName === null) continue;
    const response = await (await caches.open(cacheName)).match(SHELL_KEY);
    if (response !== undefined) return response;
  }
  return undefined;
}

async function matchStaticAsset(request) {
  const meta = await readMeta();
  if (meta === null) return undefined;
  for (const cacheName of [meta.active, meta.previous]) {
    if (cacheName === null) continue;
    const response = await (await caches.open(cacheName)).match(request);
    if (response !== undefined) return response;
  }
  return undefined;
}

async function resolveShellNavigation(request, preloadResponse) {
  try {
    return (await preloadResponse) ?? (await fetch(request));
  } catch {
    const cached = await matchShellFallback();
    if (cached !== undefined) return cached;
    return new Response('Korvi cashier shell is unavailable offline on this device.', {
      status: 503,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }
}

async function resolveStaticAsset(request) {
  const cached = await matchStaticAsset(request);
  if (cached !== undefined) return cached;
  return fetch(request);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await primeShell();
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const meta = await readMeta();
      if (meta !== null) await cleanupShellCaches(meta);
      if (self.registration.navigationPreload !== undefined) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  if (isShellNavigationRequest(event.request)) {
    const responsePromise = resolveShellNavigation(event.request, event.preloadResponse);
    event.respondWith(responsePromise);
    event.waitUntil(
      responsePromise
        .then((response) =>
          isCacheableHtmlResponse(response)
            ? scheduleSnapshot(response.clone()).catch(() => undefined)
            : undefined,
        )
        .catch(() => undefined),
    );
    return;
  }

  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!isAllowedStaticUrl(url)) return;

  const responsePromise = resolveStaticAsset(event.request);
  event.respondWith(responsePromise);
  event.waitUntil(
    responsePromise
      .then(async (response) => {
        if (!isCacheableStaticResponse(response)) return;
        const meta = await readMeta();
        if (meta === null) return;
        const cache = await caches.open(meta.active);
        await cache.put(event.request, response.clone());
      })
      .catch(() => undefined),
  );
});
