import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const baseUrl = process.env.KORVI_BROWSER_BASE_URL ?? 'http://localhost:3000';
const chromePort = process.env.KORVI_CHROME_DEBUG_PORT ?? '9222';
const artifactDirectory = process.env.KORVI_BROWSER_ARTIFACT_DIR ?? 'artifacts/stage5d-browser';

await mkdir(artifactDirectory, { recursive: true });

class CdpClient {
  #socket;
  #nextId = 1;
  #pending = new Map();

  constructor(url) {
    this.#socket = new WebSocket(url);
    this.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== 'number') return;
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result ?? {});
    });
  }

  async ready() {
    if (this.#socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.#socket.addEventListener('open', resolve, { once: true });
      this.#socket.addEventListener('error', () => reject(new Error('Chrome CDP connection failed.')), { once: true });
    });
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

const target = await createTarget(`${baseUrl}/control`);
assert.equal(typeof target.webSocketDebuggerUrl, 'string');
const cdp = new CdpClient(target.webSocketDebuggerUrl);
await cdp.ready();
await Promise.all([
  cdp.send('Page.enable'),
  cdp.send('Runtime.enable'),
  cdp.send('DOM.enable'),
  cdp.send('Network.enable'),
]);
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});

function js(value) {
  return JSON.stringify(value);
}

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails !== undefined)
    throw new Error(result.exceptionDetails.text ?? 'Browser evaluation failed.');
  return result.result?.value;
}

async function waitFor(expression, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function exactTextExpression(text) {
  return `(value) => value.replace(/\\s+/g, ' ').trim() === ${js(text)}`;
}

async function clickButton(text) {
  await waitFor(
    `(() => [...document.querySelectorAll('button')].some((button) => (${exactTextExpression(text)})(button.textContent ?? '') && !button.disabled))()`,
    `enabled button ${text}`,
  );
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) =>
      (${exactTextExpression(text)})(candidate.textContent ?? '') && !candidate.disabled
    );
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, `Unable to click ${text}.`);
}

async function waitForHeading(text) {
  await waitFor(
    `(() => [...document.querySelectorAll('h1,h2')].some((node) => (${exactTextExpression(text)})(node.textContent ?? '')))()`,
    `heading ${text}`,
  );
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 900));
  await evaluate(`window.scrollTo({ top: 0, behavior: 'instant' })`);
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function capture(name) {
  await settle();
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  assert.equal(typeof result.data, 'string');
  await writeFile(`${artifactDirectory}/${name}.png`, Buffer.from(result.data, 'base64'));
  console.log(`[promo] captured ${name}.png`);
}

await waitFor(`document.querySelector('#tenant-slug') === null`, 'authenticated control surface');
await waitForHeading('الرئيسية');
await capture('promo-01-dashboard');

await clickButton('المنتجات');
await waitForHeading('المنتجات');
await waitFor(`document.body.textContent?.includes('إضافة صنف')`, 'products panel');
await capture('promo-02-products');

await clickButton('المخزون');
await waitForHeading('المخزون');
await waitFor(`document.body.textContent?.includes('تسجيل حركة مخزون')`, 'inventory panel');
await capture('promo-03-inventory');

await clickButton('المشتريات');
await waitForHeading('المشتريات');
await waitFor(`document.body.textContent?.includes('المشتريات والاستلام')`, 'purchasing panel');
await clickButton('الموردون');
await capture('promo-04-purchasing-suppliers');
await clickButton('أوامر الشراء');
await waitFor(`document.body.textContent?.includes('إنشاء أمر الشراء')`, 'purchase order workspace');
await capture('promo-05-purchasing-orders');
await clickButton('الاستلامات');
await waitFor(`document.body.textContent?.includes('الاستلامات')`, 'receiving workspace');
await capture('promo-06-purchasing-receiving');

await clickButton('الفروع والصناديق');
await waitForHeading('الفروع والصناديق');
await waitFor(`document.body.textContent?.includes('إضافة فرع')`, 'branches panel');
await capture('promo-07-branches-terminals');

await clickButton('الموظفون والصلاحيات');
await waitForHeading('الموظفون والصلاحيات');
await waitFor(`!document.body.textContent?.includes('جارٍ تحميل الموظفين والصلاحيات')`, 'staff panel load');
await capture('promo-08-staff-permissions');

await clickButton('الإعدادات');
await waitForHeading('إعدادات المنشأة');
await settle();
await capture('promo-09-settings');

cdp.close();
