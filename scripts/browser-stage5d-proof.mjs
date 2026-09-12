import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const baseUrl = process.env.KORVI_BROWSER_BASE_URL ?? 'http://localhost:3000';
const tenantSlug = process.env.KORVI_BROWSER_TENANT_SLUG ?? 'stage5d-browser-proof';
const ownerEmail = process.env.KORVI_BROWSER_OWNER_EMAIL ?? 'owner@stage5d-browser-proof.test';
const password = process.env.KORVI_BROWSER_PASSWORD;
const chromePort = process.env.KORVI_CHROME_DEBUG_PORT ?? '9222';
const artifactDirectory = process.env.KORVI_BROWSER_ARTIFACT_DIR ?? 'artifacts/stage5d-browser';

if (password === undefined || password.length < 16) {
  throw new Error('KORVI_BROWSER_PASSWORD must contain at least 16 characters.');
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
      for (const listener of this.#listeners.get(message.method) ?? [])
        listener(message.params ?? {});
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

const target = await createTarget(`${baseUrl}/control`);
assert.equal(typeof target.webSocketDebuggerUrl, 'string');
const cdp = new CdpClient(target.webSocketDebuggerUrl);
await cdp.ready();
await Promise.all([
  cdp.send('Page.enable'),
  cdp.send('Runtime.enable'),
  cdp.send('Network.enable'),
  cdp.send('DOM.enable'),
]);

const requestCounts = new Map();
cdp.on('Network.requestWillBeSent', (params) => {
  const request = params.request;
  if (request === undefined || typeof request.url !== 'string') return;
  try {
    const url = new URL(request.url);
    const key = `${request.method ?? 'GET'} ${url.pathname}`;
    requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
  } catch {
    // Ignore browser-internal URLs.
  }
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

async function waitFor(expression, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function js(value) {
  return JSON.stringify(value);
}

function normalizedTextExpression(text) {
  return `(value) => value.replace(/\\s+/g, ' ').trim() === ${js(text)}`;
}

async function waitForText(text, timeoutMs = 20_000) {
  await waitFor(
    `(() => [...document.querySelectorAll('body *')].some((node) => node.children.length === 0 && node.textContent?.replace(/\\s+/g, ' ').trim() === ${js(text)}))()`,
    `text ${text}`,
    timeoutMs,
  );
}

async function waitForEnabledButton(text, timeoutMs = 20_000) {
  await waitFor(
    `(() => [...document.querySelectorAll('button')].some((button) => (${normalizedTextExpression(text)})(button.textContent ?? '') && !button.disabled))()`,
    `enabled button ${text}`,
    timeoutMs,
  );
}

async function pointForButton(text) {
  const value = await evaluate(`(async () => {
    const button = [...document.querySelectorAll('button')].find((candidate) =>
      (${normalizedTextExpression(text)})(candidate.textContent ?? '') && !candidate.disabled
    );
    if (!(button instanceof HTMLElement)) return null;
    button.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!button.isConnected || button.disabled) return null;
    const rect = button.getBoundingClientRect();
    const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    if (rect.width <= 0 || rect.height <= 0 || point.x < 0 || point.y < 0 || point.x > innerWidth || point.y > innerHeight) return null;
    const hit = document.elementFromPoint(point.x, point.y);
    if (hit === null || (hit !== button && !button.contains(hit))) return null;
    return point;
  })()`);
  if (value === null || value === undefined)
    throw new Error(`Enabled button not found or not hit-testable: ${text}`);
  return value;
}

async function pointForLabel(text) {
  const value = await evaluate(`(async () => {
    const label = [...document.querySelectorAll('label')].find((candidate) =>
      (candidate.textContent ?? '').replace(/\\s+/g, ' ').includes(${js(text)})
    );
    if (!(label instanceof HTMLElement)) return null;
    label.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!label.isConnected) return null;
    const rect = label.getBoundingClientRect();
    const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    if (rect.width <= 0 || rect.height <= 0 || point.x < 0 || point.y < 0 || point.x > innerWidth || point.y > innerHeight) return null;
    const hit = document.elementFromPoint(point.x, point.y);
    if (hit === null || (hit !== label && !label.contains(hit))) return null;
    return point;
  })()`);
  if (value === null || value === undefined)
    throw new Error(`Label not found or not hit-testable: ${text}`);
  return value;
}

async function pointForAriaPrefix(prefix, selector = 'input') {
  const value = await evaluate(`(async () => {
    const element = [...document.querySelectorAll(${js(selector)})].find((candidate) =>
      (candidate.getAttribute('aria-label') ?? '').startsWith(${js(prefix)}) && !candidate.disabled
    );
    if (!(element instanceof HTMLElement)) return null;
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!element.isConnected || element.disabled) return null;
    const rect = element.getBoundingClientRect();
    const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    if (rect.width <= 0 || rect.height <= 0 || point.x < 0 || point.y < 0 || point.x > innerWidth || point.y > innerHeight) return null;
    const hit = document.elementFromPoint(point.x, point.y);
    if (hit === null || (hit !== element && !element.contains(hit))) return null;
    return point;
  })()`);
  if (value === null || value === undefined)
    throw new Error(`ARIA element not found or not hit-testable: ${prefix}`);
  return value;
}

async function mouseClickPoint(point) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
}

async function clickButton(text) {
  await waitForEnabledButton(text);
  await mouseClickPoint(await pointForButton(text));
}

async function clickLabel(text) {
  await mouseClickPoint(await pointForLabel(text));
}

async function touchButton(text) {
  await waitForEnabledButton(text);
  const point = await pointForButton(text);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: point.x, y: point.y, radiusX: 2, radiusY: 2, force: 1 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function setLabeledValue(labelText, value) {
  const changed = await evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find((candidate) =>
      (candidate.textContent ?? '').replace(/\\s+/g, ' ').includes(${js(labelText)})
    );
    const element = label?.querySelector('input, select, textarea');
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) return false;
    const prototype = element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter === undefined) return false;
    setter.call(element, ${js(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(changed, true, `Could not fill label ${labelText}.`);
}

async function setAriaValue(label, value, prefix = false) {
  const changed = await evaluate(`(() => {
    const element = [...document.querySelectorAll('input, select, textarea')].find((candidate) => {
      const aria = candidate.getAttribute('aria-label') ?? '';
      return ${prefix ? `aria.startsWith(${js(label)})` : `aria === ${js(label)}`};
    });
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) return false;
    const prototype = element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter === undefined) return false;
    setter.call(element, ${js(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(changed, true, `Could not fill aria-label ${label}.`);
}

async function selectLabeledOption(labelText, optionText) {
  const selected = await evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find((candidate) =>
      (candidate.textContent ?? '').replace(/\\s+/g, ' ').includes(${js(labelText)})
    );
    const element = label?.querySelector('select');
    if (!(element instanceof HTMLSelectElement)) return false;
    const option = [...element.options].find((candidate) =>
      (candidate.textContent ?? '').replace(/\\s+/g, ' ').includes(${js(optionText)})
    );
    if (option === undefined) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter === undefined) return false;
    setter.call(element, option.value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(selected, true, `Could not select ${optionText} from ${labelText}.`);
}

async function selectAriaOption(ariaLabel, optionText) {
  const selected = await evaluate(`(() => {
    const element = [...document.querySelectorAll('select')].find((candidate) =>
      candidate.getAttribute('aria-label') === ${js(ariaLabel)}
    );
    if (!(element instanceof HTMLSelectElement)) return false;
    const option = [...element.options].find((candidate) =>
      (candidate.textContent ?? '').replace(/\\s+/g, ' ').includes(${js(optionText)})
    );
    if (option === undefined) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter === undefined) return false;
    setter.call(element, option.value);
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(selected, true, `Could not select ${optionText} from ${ariaLabel}.`);
}

async function pressKey(key, code = key) {
  const virtualKeyCode = key === 'Enter' ? 13 : key === 'Tab' ? 9 : 0;
  const common = {
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  };
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    ...common,
    ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}),
  });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}

async function waitForRequest(key, expectedCount, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((requestCounts.get(key) ?? 0) >= expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for request ${key}.`);
}

async function capture(name) {
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  assert.equal(typeof result.data, 'string');
  await writeFile(`${artifactDirectory}/${name}.png`, Buffer.from(result.data, 'base64'));
}

async function browserJson(path) {
  const value = await evaluate(`(async () => {
    const response = await fetch(${js(path)}, { headers: { accept: 'application/json' } });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  })()`);
  assert.equal(value.status, 200, `Browser GET ${path} returned ${String(value.status)}.`);
  return value.body;
}

try {
  await waitFor(
    `document.readyState === 'complete' || document.readyState === 'interactive'`,
    'page load',
  );
  await waitFor(`document.querySelector('#tenant-slug') !== null`, 'login form');

  await evaluate(`document.querySelector('#tenant-slug')?.focus()`);
  await cdp.send('Input.insertText', { text: tenantSlug });
  await pressKey('Tab', 'Tab');
  assert.equal(await evaluate(`document.activeElement?.id`), 'email');
  await cdp.send('Input.insertText', { text: ownerEmail });
  await pressKey('Tab', 'Tab');
  assert.equal(await evaluate(`document.activeElement?.id`), 'password');
  await cdp.send('Input.insertText', { text: password });
  const loginBefore = requestCounts.get('POST /v1/auth/login') ?? 0;
  await pressKey('Enter', 'Enter');
  await waitForRequest('POST /v1/auth/login', loginBefore + 1, 30_000);
  await waitFor(`document.querySelector('#tenant-slug') === null`, 'login form dismissal', 30_000);
  const cookies = await cdp.send('Network.getCookies', { urls: [baseUrl] });
  assert.ok(
    cookies.cookies?.some((cookie) => cookie.name === 'korvi_session' && cookie.httpOnly === true),
    'Development session cookie was not stored as HttpOnly.',
  );
  assert.equal(await evaluate(`document.cookie.includes('korvi_session=')`), false);
  await waitForEnabledButton('الفروع والصناديق', 30_000);
  record(
    'keyboard login emitted one auth request and established an HttpOnly session invisible to page JavaScript',
  );

  await clickButton('الفروع والصناديق');
  await waitForText('إضافة فرع');
  await setLabeledValue('رمز الفرع', 'BR-A');
  await setLabeledValue('الاسم العربي', 'فرع ألف');
  await setLabeledValue('الاسم الإنجليزي — اختياري', 'Alpha Branch');
  await clickButton('إنشاء الفرع');
  await waitForText('أُنشئ الفرع «فرع ألف».');
  await setLabeledValue('رمز الفرع', 'BR-B');
  await setLabeledValue('الاسم العربي', 'فرع باء');
  await setLabeledValue('الاسم الإنجليزي — اختياري', 'Beta Branch');
  await clickButton('إنشاء الفرع');
  await waitForText('أُنشئ الفرع «فرع باء».');
  record('two active branches created through the authenticated control UI');

  await clickButton('المنتجات');
  await waitForText('إضافة صنف');
  await setLabeledValue('رقم الصنف', 'BROWSER-SKU-001');
  await setLabeledValue('الاسم العربي', 'صنف برهان المتصفح');
  await setLabeledValue('الاسم الإنجليزي — اختياري', 'Browser Proof Item');
  await setLabeledValue('السعر (ر.س)', '12.50');
  await setLabeledValue('الباركود — حسب إعدادات المنشأة', '6281000000001');
  await clickButton('إنشاء الصنف');
  await waitForText('أُنشئ الصنف «صنف برهان المتصفح» وأصبح مفعّلاً للبيع.');
  record('tracked product created through the authenticated control UI');

  await clickButton('المخزون');
  await waitForText('تسجيل حركة مخزون', 30_000);
  await selectLabeledOption('الفرع', 'فرع ألف');
  await waitForText('صنف برهان المتصفح', 20_000);
  await setLabeledValue('التغير (+ للزيادة، − للنقص)', '+10');
  await setLabeledValue('سبب التسوية (مطلوب)', 'رصيد افتتاحي تجريبي');
  const adjustmentBefore = requestCounts.get('POST /v1/admin/inventory/adjustments') ?? 0;
  const rapidDoubleActivation = await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find((candidate) =>
    (${normalizedTextExpression('تسجيل التسوية')})(candidate.textContent ?? '') && !candidate.disabled
  );
  if (!(button instanceof HTMLButtonElement)) return false;
  button.click();
  button.click();
  return true;
})()`);
  assert.equal(
    rapidDoubleActivation,
    true,
    'Could not synchronously double-activate the inventory adjustment button.',
  );
  await waitForText('سُجلت حركة المخزون بنجاح.', 30_000);
  const adjustmentAfter = requestCounts.get('POST /v1/admin/inventory/adjustments') ?? 0;
  assert.equal(
    adjustmentAfter - adjustmentBefore,
    1,
    'Rapid double submit emitted more than one adjustment request.',
  );
  record(
    'rapid double-click emitted exactly one inventory adjustment request and one committed movement',
  );

  await waitForEnabledButton('بدء حركة جديدة', 30_000);
  await waitFor(
    `([...document.querySelectorAll('label')].some((label) => (label.textContent ?? '').includes('إجمالي قيمة اقتناء الكمية المجهولة') && !label.querySelector('input')?.disabled))`,
    'cost bootstrap unlocked',
    30_000,
  );
  await setLabeledValue('إجمالي قيمة اقتناء الكمية المجهولة (ر.س)', '50.00');
  const costBootstrapKey = 'POST /v1/admin/inventory/cost-bootstrap';
  const costBootstrapBefore = requestCounts.get(costBootstrapKey) ?? 0;
  await clickButton('تسجيل التقييم');
  await waitForRequest(costBootstrapKey, costBootstrapBefore + 1, 10_000);
  await waitForText('سُجل تقييم التكلفة المستقبلي بنجاح.', 30_000);
  const costBootstrapAfter = requestCounts.get(costBootstrapKey) ?? 0;
  assert.equal(
    costBootstrapAfter - costBootstrapBefore,
    1,
    'Cost bootstrap emitted more than one request.',
  );
  await waitForEnabledButton('بدء تقييم جديد', 30_000);
  await clickButton('بدء تقييم جديد');
  await clickButton('بدء حركة جديدة');
  record(
    'unknown positive stock was valued explicitly; no selling-price or zero-cost inference used',
  );

  await clickLabel('جرد فعلي');
  await setLabeledValue('الكمية التي جُردت فعليًا', '9');
  await setLabeledValue('سبب الحركة (اختياري)', 'جرد فعلي آلي عبر Chrome');
  await clickButton('تسجيل الجرد');
  await waitForText('سُجلت حركة المخزون بنجاح.', 30_000);
  await waitForEnabledButton('بدء حركة جديدة', 30_000);
  await clickButton('بدء حركة جديدة');
  record(
    'physical count committed through browser workflow and refreshed server revision before next decision',
  );

  await clickLabel('تحويل إلى فرع');
  await selectLabeledOption('فرع الوجهة', 'فرع باء');
  await setLabeledValue('الكمية المطلوب تحويلها', '2');
  await setLabeledValue('سبب الحركة (اختياري)', 'تحويل برهان المتصفح');
  await clickButton('تنفيذ التحويل');
  await waitForText('سُجلت حركة المخزون بنجاح.', 30_000);
  await waitForEnabledButton('بدء حركة جديدة', 30_000);
  await clickButton('بدء حركة جديدة');
  record('inter-branch transfer committed through control UI with post-write refresh gate');

  await clickButton('المشتريات');
  await waitForText('المشتريات والاستلام');
  await setLabeledValue('اسم المورد', 'مورد برهان المتصفح');
  await clickButton('إضافة المورد');
  await waitForText('سُجلت عملية المشتريات بنجاح.', 30_000);
  await waitForEnabledButton('بدء عملية جديدة', 30_000);
  await clickButton('بدء عملية جديدة');
  record('supplier created through purchasing UI');

  await clickButton('أوامر الشراء');
  await selectLabeledOption('المورد', 'مورد برهان المتصفح');
  await selectLabeledOption('فرع الاستلام', 'فرع ألف');
  await selectAriaOption('الصنف في بند أمر الشراء 1', 'صنف برهان المتصفح');
  await setLabeledValue('رقم مرجعي (اختياري)', 'BROWSER-PO-001');
  await setAriaValue('الكمية المطلوبة في بند أمر الشراء 1', '4');
  await clickButton('إنشاء أمر الشراء');
  await waitForText('سُجلت عملية المشتريات بنجاح.', 30_000);
  await waitForEnabledButton('بدء عملية جديدة', 30_000);
  await clickButton('بدء عملية جديدة');
  record('purchase order created without changing stock');

  await clickButton('الاستلامات');
  await waitForEnabledButton('تسجيل الاستلام', 30_000);
  await setLabeledValue('مرجع إشعار التسليم (اختياري)', 'BROWSER-GRN-001');
  await setAriaValue('الكمية المستلمة ', '2', true);
  await clickButton('تسجيل الاستلام');
  await waitForText('سُجل الاستلام وحركة المخزون ذريًا.', 30_000);
  await waitForEnabledButton('بدء عملية جديدة', 30_000);
  await clickButton('بدء عملية جديدة');
  record('first partial receipt committed atomically with deliberately unknown cost');

  await waitForEnabledButton('تسجيل الاستلام', 30_000);
  await setLabeledValue('مرجع إشعار التسليم (اختياري)', 'BROWSER-GRN-002');
  await setAriaValue('الكمية المستلمة ', '2', true);
  await mouseClickPoint(await pointForAriaPrefix('تسجيل قيمة اقتناء '));
  await setAriaValue('إجمالي قيمة اقتناء ', '12.00', true);
  await clickButton('تسجيل الاستلام');
  await waitForText('سُجل الاستلام وحركة المخزون ذريًا.', 30_000);
  await waitForEnabledButton('بدء عملية جديدة', 30_000);
  await clickButton('بدء عملية جديدة');
  record('second receipt closed the order with explicit trusted acquisition value');

  await clickButton('المخزون');
  await waitForText('تقييم الكمية الموجبة مجهولة التكلفة', 30_000);
  await selectLabeledOption('الفرع', 'فرع ألف');
  await waitFor(
    `([...document.querySelectorAll('label')].some((label) => (label.textContent ?? '').includes('إجمالي قيمة اقتناء الكمية المجهولة') && !label.querySelector('input')?.disabled))`,
    'post-receipt unknown cost bootstrap',
    30_000,
  );
  await setLabeledValue('إجمالي قيمة اقتناء الكمية المجهولة (ر.س)', '8.00');
  await clickButton('تسجيل التقييم');
  await waitForText('سُجل تقييم التكلفة المستقبلي بنجاح.', 30_000);
  await waitForEnabledButton('بدء تقييم جديد', 30_000);
  await clickButton('بدء تقييم جديد');
  record(
    'unknown cost created by partial receipt was explicitly valued and acknowledged only after fresh cost truth',
  );

  const branches = await browserJson('/v1/admin/inventory/branches?limit=50');
  const branchA = branches.rows.find((branch) => branch.nameAr === 'فرع ألف');
  const branchB = branches.rows.find((branch) => branch.nameAr === 'فرع باء');
  assert.ok(branchA !== undefined && branchB !== undefined, 'Expected both proof branches.');

  const balanceA = await browserJson(
    `/v1/admin/inventory/balances?branchId=${encodeURIComponent(branchA.id)}&limit=50`,
  );
  const balanceB = await browserJson(
    `/v1/admin/inventory/balances?branchId=${encodeURIComponent(branchB.id)}&limit=50`,
  );
  const rowA = balanceA.rows.find((row) => row.sku === 'BROWSER-SKU-001');
  const rowB = balanceB.rows.find((row) => row.sku === 'BROWSER-SKU-001');
  assert.equal(rowA?.quantityScaled, '11000');
  assert.equal(rowB?.quantityScaled, '2000');

  const costA = await browserJson(
    `/v1/admin/inventory/cost-balances?branchId=${encodeURIComponent(branchA.id)}&limit=50`,
  );
  const costB = await browserJson(
    `/v1/admin/inventory/cost-balances?branchId=${encodeURIComponent(branchB.id)}&limit=50`,
  );
  const costRowA = costA.rows.find((row) => row.sku === 'BROWSER-SKU-001');
  const costRowB = costB.rows.find((row) => row.sku === 'BROWSER-SKU-001');
  assert.equal(costRowA?.quantityScaled, '11000');
  assert.equal(costRowA?.knownQuantityScaled, '11000');
  assert.equal(costRowA?.unknownPositiveQuantityScaled, '0');
  assert.equal(costRowA?.knownValueMinor, '5500');
  assert.equal(costRowB?.quantityScaled, '2000');
  assert.equal(costRowB?.knownQuantityScaled, '2000');
  assert.equal(costRowB?.unknownPositiveQuantityScaled, '0');
  assert.equal(costRowB?.knownValueMinor, '1000');

  const orders = await browserJson('/v1/admin/purchasing/orders?limit=50');
  const order = orders.rows.find((candidate) => candidate.reference === 'BROWSER-PO-001');
  assert.ok(order !== undefined, 'Browser-created purchase order missing from server read.');
  assert.equal(order.status, 'received');
  const detail = await browserJson(`/v1/admin/purchasing/orders/${encodeURIComponent(order.id)}`);
  assert.equal(detail.lines.length, 1);
  assert.equal(detail.lines[0]?.orderedQuantityScaled, '4000');
  assert.equal(detail.lines[0]?.receivedQuantityScaled, '4000');
  assert.equal(detail.lines[0]?.remainingQuantityScaled, '0');
  const receipts = await browserJson(
    `/v1/admin/purchasing/orders/${encodeURIComponent(order.id)}/receipts?limit=100`,
  );
  assert.equal(receipts.receipts.length, 2);
  record(
    'server reads after browser actions match stock, cost history, transfer, and two-receipt purchase truth',
  );

  await capture('desktop-final');
  const desktopOverflow = await evaluate(
    `document.documentElement.scrollWidth > document.documentElement.clientWidth + 1`,
  );
  assert.equal(desktopOverflow, false, 'Desktop control page has body-level horizontal overflow.');

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
    screenWidth: 390,
    screenHeight: 844,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await touchButton('المشتريات');
  await waitForText('المشتريات والاستلام');
  const mobileOverflow = await evaluate(
    `document.documentElement.scrollWidth > document.documentElement.clientWidth + 1`,
  );
  assert.equal(mobileOverflow, false, 'Mobile control page has body-level horizontal overflow.');
  await capture('mobile-touch-purchasing');
  record(
    '390x844 mobile emulation accepted a real CDP touch navigation event without body overflow',
  );

  record(`exact browser proof completed for ${process.env.GITHUB_SHA ?? 'local-sha-unknown'}`);
  await writeFile(`${artifactDirectory}/proof.txt`, `${evidence.join('\n')}\n`, { mode: 0o600 });
} catch (error) {
  await capture('failure').catch(() => undefined);
  await writeFile(
    `${artifactDirectory}/proof.txt`,
    `${evidence.join('\n')}\nFAIL: ${error instanceof Error ? error.message : 'unknown failure'}\n`,
    { mode: 0o600 },
  );
  throw error;
} finally {
  cdp.close();
}
