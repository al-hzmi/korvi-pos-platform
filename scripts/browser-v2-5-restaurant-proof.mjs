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
  console.log(`[cashier-proof] ${message}`);
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
        clearTimeout(pending.timer);
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

  async send(method, params = {}, timeoutMs = 30_000) {
    const id = this.#nextId++;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(
          new Error(`Chrome DevTools command ${method} timed out after ${String(timeoutMs)}ms.`),
        );
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Chrome DevTools connection closed before command completion.'));
    }
    this.#pending.clear();
    this.#socket.close();
  }
}

async function connect() {
  const targets = await fetch(`http://127.0.0.1:${chromePort}/json/list`).then((response) =>
    response.json(),
  );
  const page = targets.find(
    (target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string',
  );
  assert.ok(page !== undefined, 'No Chrome page target is available.');
  const client = new CdpClient(page.webSocketDebuggerUrl);
  await client.ready();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  return client;
}

const cdp = await connect();

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.text ?? 'Browser evaluation failed.');
  }
  return result.result?.value;
}

async function waitFor(expression, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function jsString(value) {
  return JSON.stringify(value);
}

async function waitForText(text, timeoutMs = 20_000) {
  await waitFor(
    `document.body?.innerText.includes(${jsString(text)}) === true`,
    `text ${JSON.stringify(text)}`,
    timeoutMs,
  );
}

async function setInput(id, value) {
  await waitFor(
    `document.getElementById(${jsString(id)}) instanceof HTMLInputElement`,
    `input #${id}`,
  );
  const changed = await evaluate(`(() => {
    const input = document.getElementById(${jsString(id)});
    if (!(input instanceof HTMLInputElement)) return false;
    input.scrollIntoView({ block: 'center', inline: 'nearest' });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter === undefined) return false;
    setter.call(input, ${jsString(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
    return true;
  })()`);
  assert.equal(changed, true, `Input #${id} disappeared before it could be edited.`);
}

async function _setInputByAriaLabel(label, value) {
  const changed = await evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find(
      (candidate) => candidate.getAttribute('aria-label') === ${jsString(label)}
    );
    if (!(input instanceof HTMLInputElement)) return false;
    input.scrollIntoView({ block: 'center', inline: 'nearest' });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter === undefined) return false;
    setter.call(input, ${jsString(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
    return true;
  })()`);
  assert.equal(changed, true, `Input with aria-label ${label} was not available.`);
}

async function _setInputByAriaLabelPrefix(prefix, value) {
  const changed = await evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find(
      (candidate) => (candidate.getAttribute('aria-label') ?? '').startsWith(${jsString(prefix)})
    );
    if (!(input instanceof HTMLInputElement)) return false;
    input.scrollIntoView({ block: 'center', inline: 'nearest' });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter === undefined) return false;
    setter.call(input, ${jsString(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
    return true;
  })()`);
  assert.equal(changed, true, `Input with aria-label prefix ${prefix} was not available.`);
}

async function _setInputByPlaceholder(placeholder, value) {
  const changed = await evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find(
      (candidate) => candidate.getAttribute('placeholder') === ${jsString(placeholder)}
    );
    if (!(input instanceof HTMLInputElement)) return false;
    input.scrollIntoView({ block: 'center', inline: 'nearest' });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter === undefined) return false;
    setter.call(input, ${jsString(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
    return true;
  })()`);
  assert.equal(changed, true, `Input with placeholder ${placeholder} was not available.`);
}

async function _setInputByLabelText(labelText, value) {
  const labelInputExpression = `(() => {
    const label = [...document.querySelectorAll('label')].find((candidate) =>
      (candidate.textContent ?? '').replace(/\\s+/g, ' ').includes(${jsString(labelText)})
    );
    if (!(label instanceof HTMLLabelElement)) return false;\n    const byFor = label.htmlFor === '' ? null : document.getElementById(label.htmlFor);\n    const input = byFor instanceof HTMLInputElement ? byFor : label.querySelector('input');\n    return input instanceof HTMLInputElement;
  })()`;
  await waitFor(labelInputExpression, `input under label ${labelText}`);

  const changed = await evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find((candidate) =>
      (candidate.textContent ?? '').replace(/\\s+/g, ' ').includes(${jsString(labelText)})
    );
    if (!(label instanceof HTMLLabelElement)) return false;
    const byFor = label.htmlFor === '' ? null : document.getElementById(label.htmlFor);
    const input = byFor instanceof HTMLInputElement ? byFor : label.querySelector('input');
    if (!(input instanceof HTMLInputElement)) return false;
    input.scrollIntoView({ block: 'center', inline: 'nearest' });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter === undefined) return false;
    setter.call(input, ${jsString(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
    return true;
  })()`);
  assert.equal(
    changed,
    true,
    `Input under label ${labelText} disappeared before it could be edited.`,
  );
}

async function _setSelect(id, value) {
  const changed = await evaluate(`(() => {
    const select = document.getElementById(${jsString(id)});
    if (!(select instanceof HTMLSelectElement)) return false;
    select.scrollIntoView({ block: 'center', inline: 'nearest' });
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter === undefined) return false;
    setter.call(select, ${jsString(value)});
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(changed, true, `Select #${id} was not available.`);
}

async function _setSelectByLabelText(labelText, value) {
  const changed = await evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find((candidate) =>
      (candidate.textContent ?? '').replace(/\\s+/g, ' ').includes(${jsString(labelText)})
    );
    const select = label?.querySelector('select');
    if (!(select instanceof HTMLSelectElement)) return false;
    select.scrollIntoView({ block: 'center', inline: 'nearest' });
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter === undefined) return false;
    setter.call(select, ${jsString(value)});
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(changed, true, `Select under label ${labelText} was not available.`);
}

async function amountAfterLabel(label) {
  const value = await evaluate(`(() => {
    const label = [...document.querySelectorAll('dt')].find(
      (candidate) => (candidate.textContent ?? '').trim() === ${jsString(label)}
    );
    const text = label?.nextElementSibling?.textContent ?? '';
    const match = text.replace(/,/g, '').match(/-?\\d+(?:\\.\\d{1,2})?/);
    return match?.[0] ?? null;
  })()`);
  assert.equal(typeof value, 'string', `Could not read amount after ${label}.`);
  return value;
}

function majorToMinor(value) {
  assert.match(value, /^-?\d+(?:\.\d{1,2})?$/);
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -minor : minor;
}

function _minorToMajor(value) {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / 100n;
  const fraction = (magnitude % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

async function pointForButton(text) {
  const point = await evaluate(`(() => {
    const wanted = ${jsString(text)};
    const button = [...document.querySelectorAll('button')].find((candidate) =>
      (candidate.textContent ?? '').replace(/\\s+/g, ' ').trim().includes(wanted)
    );
    if (!(button instanceof HTMLButtonElement) || button.disabled) return null;
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
    return { x, y };
  })()`);
  assert.ok(point !== null, `Enabled button containing ${JSON.stringify(text)} was not visible.`);
  return point;
}

async function clickButton(text) {
  await waitFor(
    `([...document.querySelectorAll('button')].some((button) => !button.disabled && (button.textContent ?? '').replace(/\\s+/g, ' ').trim().includes(${jsString(text)})))`,
    `enabled button ${JSON.stringify(text)}`,
  );
  const point = await pointForButton(text);
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

async function clickButtonWithinDialog(text) {
  await waitFor(
    `(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return dialog !== null && [...dialog.querySelectorAll('button')].some(
        (button) =>
          !button.disabled &&
          (button.textContent ?? '').replace(/\\s+/g, ' ').trim().includes(${jsString(text)})
      );
    })()`,
    `enabled dialog button ${JSON.stringify(text)}`,
  );
  const point = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (dialog === null) return null;
    const wanted = ${jsString(text)};
    const button = [...dialog.querySelectorAll('button')].find((candidate) =>
      (candidate.textContent ?? '').replace(/\\s+/g, ' ').trim().includes(wanted)
    );
    if (!(button instanceof HTMLButtonElement) || button.disabled) return null;
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert.ok(
    point !== null,
    `Enabled dialog button containing ${JSON.stringify(text)} was not visible.`,
  );
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

async function pressEnter() {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

async function browserRequest(path, init = {}, timeoutMs = 30_000) {
  const result = await evaluate(`(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ${timeoutMs});
    try {
      const response = await fetch(${jsString(path)}, {
        credentials: 'same-origin',
        ...${JSON.stringify(init)},
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(${JSON.stringify(init.headers ?? {})})
        }
      });
      const body = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, body, transportError: null };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        body: null,
        transportError:
          error instanceof Error ? error.name + ': ' + error.message : String(error)
      };
    } finally {
      clearTimeout(timer);
    }
  })()`);
  assert.equal(
    result.ok,
    true,
    result.transportError === null
      ? `${path} returned HTTP ${String(result.status)}: ${JSON.stringify(result.body)}`
      : `${path} transport failed after ${timeoutMs}ms: ${String(result.transportError)}`,
  );
  return result.body;
}

async function capture(name) {
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  assert.equal(typeof screenshot.data, 'string');
  await writeFile(`${artifactDirectory}/${name}.png`, Buffer.from(screenshot.data, 'base64'), {
    mode: 0o600,
  });
}

try {
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });

  const branches = await browserRequest('/v1/admin/inventory/branches?limit=50');
  const branch = branches.rows.find((row) => row.nameAr === 'فرع ألف');
  assert.ok(branch !== undefined, 'V2-5 proof branch is missing.');

  const balances = await browserRequest(
    `/v1/admin/inventory/balances?branchId=${encodeURIComponent(branch.id)}&limit=50`,
  );
  const product = balances.rows.find((row) => row.sku === 'BROWSER-SKU-001');
  assert.ok(product !== undefined, 'V2-5 proof product is missing.');

  const principal = await browserRequest('/v1/auth/me');
  const _terminal = await browserRequest('/v1/admin/terminals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      branchId: branch.id,
      code: 'V25-POS-01',
      label: 'صندوق برهان V2-5',
    }),
  });
  await browserRequest(`/v1/admin/members/${encodeURIComponent(principal.user.id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultBranchId: branch.id }),
  });

  const stationCreation = await browserRequest('/v1/admin/restaurant/preparation-stations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      branchId: branch.id,
      code: 'V25-KITCHEN',
      nameAr: 'مطبخ V2-5',
      sortOrder: 0,
    }),
  });
  // Administrative mutations return { value, replayed }; only value is the station.
  const station = stationCreation.value;
  assert.equal(typeof station?.id, 'string', 'Preparation station was not created.');
  await browserRequest(
    `/v1/admin/restaurant/preparation-routes/${encodeURIComponent(product.productId)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        branchId: branch.id,
        stationIds: [station.id],
      }),
    },
  );
  record(
    'restaurant preparation station and product routing configured through authenticated admin APIs',
  );

  await browserRequest('/v1/auth/logout', { method: 'POST' });
  await cdp.send('Page.navigate', { url: `${baseUrl}/` });
  await waitFor(
    `document.getElementById('tenant-slug') instanceof HTMLInputElement`,
    'restaurant cashier login form',
  );
  await setInput('tenant-slug', tenantSlug);
  await setInput('email', ownerEmail);
  await setInput('password', password);
  await clickButton('دخول');
  await waitFor(
    `fetch('/v1/auth/me', { credentials: 'same-origin' }).then((response) => response.ok).catch(() => false)`,
    'authenticated restaurant cashier session',
    30_000,
  );
  await cdp.send('Page.navigate', { url: `${baseUrl}/cashier` });

  await waitForText('افتح وردية', 30_000);
  await setInput('opening-float', '100.00');
  await clickButton('فتح الوردية');
  await waitForText('ابحث أو امسح الباركود', 30_000);
  record('restaurant cashier opened a real shift on the configured branch and terminal');

  await setInput('product-search', 'BROWSER-SKU-001');
  await pressEnter();
  await waitForText('صنف برهان المتصفح', 20_000);
  await clickButton('صنف برهان المتصفح');
  await waitForText('تخصيص الصنف', 20_000);
  await waitForText('الحجم', 20_000);
  await clickButtonWithinDialog('كبير');
  await clickButtonWithinDialog('إضافة للسلة');
  await waitForText('كبير', 20_000);
  // Preview is server-authoritative and debounced. The immediate fallback is the
  // product's base price, not proof that the selected option was priced.
  await waitFor(
    `(() => {
      const label = [...document.querySelectorAll('dt')].find(
        (candidate) => (candidate.textContent ?? '').trim() === 'الإجمالي المستحق'
      );
      const displayed = (label?.nextElementSibling?.textContent ?? '').replace(/,/g, '');
      return displayed.match(/-?\\d+(?:\\.\\d{1,2})?/)?.[0] === '14.50';
    })()`,
    'server-authoritative modifier total of 14.50 SAR',
    30_000,
  );

  const selectedTotal = majorToMinor(await amountAfterLabel('الإجمالي المستحق'));
  assert.equal(
    selectedTotal,
    1450n,
    'Modifier +2.00 SAR did not produce the expected 14.50 SAR total.',
  );
  record(
    'cashier selected the server-authored modifier identity and preview total became 14.50 SAR',
  );

  await clickButton('حفظ كطلب مفتوح');
  try {
    await waitForText('تم حفظ الطلب مفتوحاً ويمكن استئنافه من أي صندوق مخوّل في الفرع.', 30_000);
  } catch (error) {
    const diagnostics = await evaluate(`(() => ({
      notices: [...document.querySelectorAll('[role="alert"], [role="status"]')]
        .map((node) => node.textContent?.trim()).filter(Boolean),
      visibleText: document.body?.innerText?.slice(-3000) ?? '',
    }))()`);
    throw new Error(`Open-order save was not confirmed: ${JSON.stringify(diagnostics)}`, {
      cause: error,
    });
  }
  await waitForText('سفري', 20_000);

  const openOrders = await browserRequest('/v1/restaurant/orders');
  assert.ok(Array.isArray(openOrders.orders), 'Restaurant list response lacks orders.');
  const orderSummary = openOrders.orders.find((order) => order.status === 'open');
  assert.ok(orderSummary !== undefined, 'Browser-created restaurant order is missing.');
  const order = await browserRequest(
    `/v1/restaurant/orders/${encodeURIComponent(orderSummary.id)}`,
  );
  assert.equal(order.lines.length, 1);
  assert.equal(order.lines[0]?.baseUnitPriceMinor, '1250');
  assert.equal(order.lines[0]?.modifierTotalMinor, '200');
  assert.equal(order.lines[0]?.unitPriceMinor, '1450');
  assert.equal(order.lines[0]?.modifierSelections.length, 1);
  assert.equal(order.lines[0]?.modifierSelections[0]?.optionNameAr, 'كبير');
  assert.equal(order.lines[0]?.modifierSelections[0]?.priceDeltaMinor, '200');
  record('open order persisted immutable modifier identity/revision/name/price-delta snapshots');

  await clickButton('سفري');
  await waitForText('مستأنف', 20_000);
  await clickButton('إرسال للمطبخ');
  await waitForText('تم إرسال الطلب للمطبخ · 1 مهمة تحضير.', 30_000);
  record('cashier fired the modifier-bearing open order to preparation');

  await cdp.send('Page.navigate', { url: `${baseUrl}/kds` });
  await waitForText('شاشة المطبخ', 30_000);
  await waitForText('مطبخ V2-5', 30_000);
  await waitForText('الإضافات: الحجم: كبير', 30_000);
  await capture('v2-5-kds-modifier-summary');
  await clickButton('بدء التحضير');
  await waitForText('قيد التحضير', 20_000);
  await clickButton('جاهز');
  await waitForText('جاهز للتقديم', 20_000);
  record(
    'KDS rendered the modifier summary from persisted order-line snapshots and advanced task state',
  );

  await cdp.send('Page.navigate', { url: `${baseUrl}/cashier` });
  await waitForText('ابحث أو امسح الباركود', 30_000);
  await waitForText('الطلبات المفتوحة', 20_000);
  // Cashier intentionally persists an active open-order identity in its
  // durable draft. On return from KDS it may restore that exact order
  // automatically; in that case the list-entry button is intentionally
  // disabled/absent. Prove the real UI path in either valid state.
  await waitFor(
    `(() => {
      const panel = document.querySelector('section[aria-label="الطلبات المفتوحة"]');
      if (panel === null) return false;
      return [...panel.querySelectorAll('span')].some(
        (node) => node.textContent?.trim() === 'مستأنف'
      ) || [...panel.querySelectorAll('button')].some(
        (button) => !button.disabled && button.textContent?.includes('سفري')
      );
    })()`,
    'restored active order or an enabled open-order resume button',
    30_000,
  );
  const restored = await evaluate(`(() => {
    const panel = document.querySelector('section[aria-label="الطلبات المفتوحة"]');
    return panel !== null && [...panel.querySelectorAll('span')].some(
      (node) => node.textContent?.trim() === 'مستأنف'
    );
  })()`);
  if (!restored) await clickButton('سفري');
  await waitForText('مستأنف', 20_000);
  record(
    restored
      ? 'cashier restored the same active open order across the KDS navigation'
      : 'cashier resumed the saved open order from the live order list',
  );
  const settlementTotal = majorToMinor(await amountAfterLabel('الإجمالي المستحق'));
  assert.equal(
    settlementTotal,
    1450n,
    'Resumed order lost its modifier financial snapshot before settlement.',
  );

  await setInput('cash-received', '14.50');
  await clickButton('إتمام البيع');
  await waitForText('تمّت العملية', 30_000);
  await waitForText('فاتورة', 30_000);

  const settled = await browserRequest(
    `/v1/restaurant/orders/${encodeURIComponent(orderSummary.id)}`,
  );
  assert.equal(settled.status, 'settled');
  assert.equal(settled.lines[0]?.baseUnitPriceMinor, '1250');
  assert.equal(settled.lines[0]?.modifierTotalMinor, '200');
  assert.equal(settled.lines[0]?.unitPriceMinor, '1450');
  assert.equal(settled.lines[0]?.modifierSelections[0]?.optionNameAr, 'كبير');
  assert.equal(settled.lines[0]?.modifierSelections[0]?.priceDeltaMinor, '200');
  record(
    'same open order settled for 14.50 SAR and retained immutable modifier financial/history snapshots',
  );

  // The merchant's actual sale-history read model must expose immutable
  // finalized option names/revisions/prices; consulting today's menu here
  // would rewrite historical truth when the merchant edits an option.
  const saleHistory = await browserRequest('/v1/admin/sales?limit=20');
  const finalizedSummary = saleHistory.items.find(
    (item) => item.status === 'finalized' && item.totalMinor === '1450' &&
      item.branch.id === branch.id,
  );
  assert.ok(finalizedSummary !== undefined, 'Settled sale missing from merchant sales history.');
  const finalizedSale = await browserRequest(
    `/v1/admin/sales/${encodeURIComponent(finalizedSummary.id)}`,
  );
  assert.equal(finalizedSale.totalMinor, '1450');
  assert.equal(finalizedSale.lines.length, 1);
  assert.equal(finalizedSale.lines[0]?.baseUnitPriceMinor, '1250');
  assert.equal(finalizedSale.lines[0]?.modifierTotalMinor, '200');
  assert.equal(finalizedSale.lines[0]?.unitPriceMinor, '1450');
  assert.equal(finalizedSale.lines[0]?.modifierSelections.length, 1);
  assert.equal(finalizedSale.lines[0]?.modifierSelections[0]?.optionNameAr, 'كبير');
  assert.equal(finalizedSale.lines[0]?.modifierSelections[0]?.priceDeltaMinor, '200');
  record('merchant sale history exposes finalized modifier decomposition and immutable option snapshots');

  const tasks = await browserRequest(
    `/v1/restaurant/preparation-stations/${encodeURIComponent(station.id)}/tasks?includeServed=true`,
  );
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.modifierSummary, 'الحجم: كبير');
  assert.equal(tasks[0]?.status, 'ready');
  record('server KDS truth retained modifier summary after sale settlement');

  await capture('v2-5-cashier-settled');
  record(
    `exact V2-5 Chrome operator proof completed for ${process.env.GITHUB_SHA ?? 'local-sha-unknown'}`,
  );
  await writeFile(`${artifactDirectory}/v2-5-proof.txt`, `${evidence.join('\n')}\n`, {
    mode: 0o600,
  });
} catch (error) {
  await capture('v2-5-failure').catch(() => undefined);
  await writeFile(
    `${artifactDirectory}/v2-5-proof.txt`,
    `${evidence.join('\n')}\nFAIL: ${error instanceof Error ? error.message : 'unknown failure'}\n`,
    { mode: 0o600 },
  );
  throw error;
} finally {
  cdp.close();
}
