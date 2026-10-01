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
    const id = this.#nextId++;
    return await new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
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

async function setInputByAriaLabel(label, value) {
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

async function setInputByAriaLabelPrefix(prefix, value) {
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

async function setInputByPlaceholder(placeholder, value) {
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

async function setInputByLabelText(labelText, value) {
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

async function setSelect(id, value) {
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

async function setSelectByLabelText(labelText, value) {
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

function minorToMajor(value) {
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
          error instanceof Error ? \`${error.name}: ${error.message}\` : String(error)
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
  assert.ok(branch !== undefined, 'Stage 5D proof branch A is missing.');

  const beforeBalance = await browserRequest(
    `/v1/admin/inventory/balances?branchId=${encodeURIComponent(branch.id)}&limit=50`,
  );
  const beforeRow = beforeBalance.rows.find((row) => row.sku === 'BROWSER-SKU-001');
  assert.equal(
    beforeRow?.quantityScaled,
    '11000',
    'Cashier proof must inherit legitimate Stage 5D stock.',
  );

  const beforeCost = await browserRequest(
    `/v1/admin/inventory/cost-balances?branchId=${encodeURIComponent(branch.id)}&limit=50`,
  );
  const beforeCostRow = beforeCost.rows.find((row) => row.sku === 'BROWSER-SKU-001');
  assert.equal(beforeCostRow?.knownQuantityScaled, '11000');
  assert.equal(beforeCostRow?.knownValueMinor, '5500');
  assert.equal(beforeCostRow?.unknownPositiveQuantityScaled, '0');
  record(
    'cashier sale starts from Stage 5D browser-created stock: 11 known units / 55.00 SAR cost pool',
  );

  const principal = await browserRequest('/v1/auth/me');
  const terminal = await browserRequest('/v1/admin/terminals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ branchId: branch.id, code: 'POS-PROOF-01', label: 'صندوق برهان البيع' }),
  });
  assert.equal(terminal.branchId, branch.id);

  const member = await browserRequest(
    `/v1/admin/members/${encodeURIComponent(principal.user.id)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultBranchId: branch.id }),
    },
  );
  assert.equal(member.defaultBranchId, branch.id);
  record(
    'terminal and cashier branch assignment configured through authenticated admin authorities; no SQL fixture used',
  );

  await browserRequest('/v1/auth/logout', { method: 'POST' });
  await cdp.send('Page.navigate', { url: `${baseUrl}/` });
  await waitFor(
    `document.getElementById('tenant-slug') instanceof HTMLInputElement`,
    'cashier login form',
  );
  await setInput('tenant-slug', tenantSlug);
  await setInput('email', ownerEmail);
  await setInput('password', password);
  await clickButton('دخول');
  await waitFor(
    `fetch('/v1/auth/me', { credentials: 'same-origin' }).then((response) => response.ok).catch(() => false)`,
    'authenticated cashier session',
    30_000,
  );
  await cdp.send('Page.navigate', { url: `${baseUrl}/cashier` });

  await waitForText('افتح وردية', 30_000);
  await setInput('opening-float', '100.00');
  await clickButton('فتح الوردية');
  await waitForText('ابحث أو امسح الباركود', 30_000);
  record(
    'cashier re-authenticated into the assigned branch/terminal and opened a real shift through the POS UI',
  );

  let saleRequests = 0;
  cdp.on('Network.requestWillBeSent', (params) => {
    const request = params.request;
    if (request?.method === 'POST' && new URL(request.url).pathname === '/v1/sales')
      saleRequests += 1;
  });

  await setInput('product-search', 'BROWSER-SKU-001');
  await pressEnter();
  await waitForText('صنف برهان المتصفح', 20_000);
  await clickButton('صنف برهان المتصفح');

  await clickButton('إلكتروني / متعدد');
  const totalMajor = await amountAfterLabel('الإجمالي المستحق');
  const totalMinor = majorToMinor(totalMajor);
  await setInputByAriaLabel('مبلغ الدفعة الإلكترونية 1', minorToMajor(totalMinor));
  await setInputByAriaLabel('مرجع الموافقة 1', 'AR2-ELECTRONIC-PROOF-001');

  await clickButton('إتمام البيع');
  await waitForText('تمّت العملية', 30_000);
  await waitForText('مدى', 20_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    saleRequests,
    1,
    'Full electronic checkout must emit exactly one POST /v1/sales request.',
  );
  record('actual Chrome cashier UI completed one full Mada electronic sale');

  await clickButton('عملية بيع جديدة');
  await waitForText('ابحث أو امسح الباركود', 20_000);
  await setInput('product-search', 'BROWSER-SKU-001');
  await pressEnter();
  await waitForText('صنف برهان المتصفح', 20_000);
  await clickButton('صنف برهان المتصفح');
  await clickButton('إلكتروني / متعدد');

  const mixedTotalMajor = await amountAfterLabel('الإجمالي المستحق');
  const mixedTotalMinor = majorToMinor(mixedTotalMajor);
  assert.equal(mixedTotalMinor, totalMinor, 'Identical proof product changed total between sales.');
  const cashTenderMinor = 100n;
  const electronicTenderMinor = totalMinor - cashTenderMinor;
  assert.ok(electronicTenderMinor > 0n, 'Proof item total must exceed the 1.00 SAR cash split.');

  await setInput('cash-received', '1.00');
  await setInputByAriaLabel('مبلغ الدفعة الإلكترونية 1', minorToMajor(electronicTenderMinor));
  await setInputByAriaLabel('مرجع الموافقة 1', 'AR2-MIXED-PROOF-001');

  await clickButton('إتمام البيع');
  await waitForText('تمّت العملية', 30_000);
  await waitForText('فاتورة', 30_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    saleRequests,
    2,
    'Electronic and mixed checkout must each emit exactly one POST /v1/sales request.',
  );

  const receiptText = await evaluate(`document.body?.innerText ?? ''`);
  assert.match(receiptText, /صنف برهان المتصفح/u);
  assert.match(receiptText, /عملية بيع جديدة/u);
  record('actual Chrome cashier UI completed one sale and rendered the server-owned receipt');

  const salesPage = await browserRequest('/v1/admin/sales?limit=10');
  let proofSale = null;
  let proofSaleDetail = null;
  let electronicSale = null;
  let electronicSaleDetail = null;
  for (const sale of salesPage.items) {
    if (sale.terminal?.id !== terminal.id || sale.status !== 'finalized') continue;
    const detail = await browserRequest(`/v1/admin/sales/${encodeURIComponent(sale.id)}`);
    if (
      detail.tenders.some(
        (tender) => tender.kind === 'electronic' && tender.reference === 'AR2-ELECTRONIC-PROOF-001',
      )
    ) {
      electronicSale = sale;
      electronicSaleDetail = detail;
    }
    if (
      detail.tenders.some(
        (tender) => tender.kind === 'electronic' && tender.reference === 'AR2-MIXED-PROOF-001',
      )
    ) {
      proofSale = sale;
      proofSaleDetail = detail;
    }
  }

  assert.ok(
    electronicSale !== null && electronicSaleDetail !== null,
    'Electronic proof sale missing from server truth.',
  );
  assert.ok(
    proofSale !== null && proofSaleDetail !== null,
    'Mixed-tender proof sale missing from server truth.',
  );

  const pureElectronicTender = electronicSaleDetail.tenders.find(
    (tender) => tender.kind === 'electronic',
  );
  assert.equal(pureElectronicTender?.amountMinor, totalMinor.toString());
  assert.equal(pureElectronicTender?.scheme, 'mada');
  assert.equal(pureElectronicTender?.reference, 'AR2-ELECTRONIC-PROOF-001');

  const cashTender = proofSaleDetail.tenders.find((tender) => tender.kind === 'cash');
  const electronicTender = proofSaleDetail.tenders.find((tender) => tender.kind === 'electronic');
  assert.equal(cashTender?.amountMinor, cashTenderMinor.toString());
  assert.equal(electronicTender?.amountMinor, electronicTenderMinor.toString());
  assert.equal(electronicTender?.scheme, 'mada');
  assert.equal(electronicTender?.reference, 'AR2-MIXED-PROOF-001');
  record('server truth preserved exact full-electronic and mixed tender composition');

  const afterBalance = await browserRequest(
    `/v1/admin/inventory/balances?branchId=${encodeURIComponent(branch.id)}&limit=50`,
  );
  const afterRow = afterBalance.rows.find((row) => row.sku === 'BROWSER-SKU-001');
  assert.equal(afterRow?.quantityScaled, '9000');

  const afterCost = await browserRequest(
    `/v1/admin/inventory/cost-balances?branchId=${encodeURIComponent(branch.id)}&limit=50`,
  );
  const afterCostRow = afterCost.rows.find((row) => row.sku === 'BROWSER-SKU-001');
  assert.equal(afterCostRow?.quantityScaled, '9000');
  assert.equal(afterCostRow?.knownQuantityScaled, '9000');
  assert.equal(afterCostRow?.unknownPositiveQuantityScaled, '0');
  assert.equal(afterCostRow?.knownValueMinor, '4500');
  record(
    'server truth reconciles exactly after two sales: stock 11→9 and known cost pool 55.00→45.00 SAR',
  );

  await clickButton('عملية بيع جديدة');
  await waitForText('ابحث أو امسح الباركود', 20_000);
  await clickButton('مرتجع / استرداد');
  await waitForText('إنشاء مرتجع', 20_000);
  await setInput('return-search', electronicSale.invoiceNumber ?? String(electronicSale.sequence));
  await clickButton('بحث');
  await clickButton(electronicSale.invoiceNumber ?? `#${String(electronicSale.sequence)}`);
  await waitForText('المتبقي:', 20_000);
  await setInputByAriaLabel('كمية إرجاع صنف برهان المتصفح', '1');
  await setSelect('return-refund-kind', 'electronic');
  await setSelect('return-refund-scheme', 'mada');
  await setInput('return-refund-reference', 'AR2-REFUND-PROOF-001');

  let returnRequests = 0;
  let returnResponseStatus = null;
  cdp.on('Network.requestWillBeSent', (params) => {
    const request = params.request;
    if (request?.method === 'POST' && new URL(request.url).pathname === '/v1/returns')
      returnRequests += 1;
  });
  cdp.on('Network.responseReceived', (params) => {
    if (new URL(params.response.url).pathname === '/v1/returns') {
      returnResponseStatus = params.response.status;
    }
  });

  await clickButton('اعتماد المرتجع');
  try {
    await waitForText('تم اعتماد المرتجع', 30_000);
  } catch (error) {
    const visibleText = String(await evaluate(`document.body?.innerText ?? ''`))
      .replace(/\s+/g, ' ')
      .slice(-1200);
    throw new Error(
      `Return UI did not reach success. POST count=${String(returnRequests)} HTTP=${String(returnResponseStatus)} visible=${visibleText}`,
      { cause: error },
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(returnRequests, 1, 'Return UI must emit exactly one POST /v1/returns request.');

  const returnedSaleDetail = await browserRequest(
    `/v1/admin/sales/${encodeURIComponent(electronicSale.id)}`,
  );
  assert.equal(returnedSaleDetail.returns.length, 1);
  assert.equal(returnedSaleDetail.returns[0]?.totalMinor, totalMinor.toString());

  const restoredBalance = await browserRequest(
    `/v1/admin/inventory/balances?branchId=${encodeURIComponent(branch.id)}&limit=50`,
  );
  const restoredRow = restoredBalance.rows.find((row) => row.sku === 'BROWSER-SKU-001');
  assert.equal(restoredRow?.quantityScaled, '10000');
  record(
    'cashier UI executed a server-priced electronic return on the pure-electronic sale and inventory returned 9→10 units',
  );

  await clickButton('تم');
  await waitForText('ابحث أو امسح الباركود', 20_000);
  await setInput('product-search', 'BROWSER-SKU-001');
  await pressEnter();
  await waitForText('صنف برهان المتصفح', 20_000);
  await clickButton('صنف برهان المتصفح');

  const exchangeReplacementTotalMajor = await amountAfterLabel('الإجمالي المستحق');
  const exchangeReplacementTotalMinor = majorToMinor(exchangeReplacementTotalMajor);
  let noReceiptRequests = 0;
  let noReceiptResponseStatus = null;
  cdp.on('Network.requestWillBeSent', (params) => {
    const request = params.request;
    if (
      request?.method === 'POST' &&
      new URL(request.url).pathname === '/v1/no-receipt-exchanges'
    ) {
      noReceiptRequests += 1;
    }
  });
  cdp.on('Network.responseReceived', (params) => {
    if (new URL(params.response.url).pathname === '/v1/no-receipt-exchanges') {
      noReceiptResponseStatus = params.response.status;
    }
  });

  await clickButton('استبدال بدون فاتورة');
  await waitForText('الأصناف المستلمة بدون فاتورة', 20_000);
  await setInputByPlaceholder('ابحث بالاسم أو الباركود أو SKU', 'BROWSER-SKU-001');
  await clickButton('بحث');
  await waitForText('BROWSER-SKU-001', 20_000);
  await clickButtonWithinDialog('صنف برهان المتصفح');
  await waitForText('مرجع اليوم:', 20_000);
  await setInputByLabelText('قيمة الاستبدال المعتمدة (ريال)', exchangeReplacementTotalMajor);
  await clickButton('اعتماد الحالة والبيع البديل');
  try {
    await waitForText('تم اعتماد الحالة', 30_000);
  } catch (error) {
    const visibleText = String(await evaluate(`document.body?.innerText ?? ''`))
      .replace(/\s+/g, ' ')
      .slice(-1600);
    throw new Error(
      `No-receipt exchange UI did not reach success. POST count=${String(noReceiptRequests)} HTTP=${String(noReceiptResponseStatus)} visible=${visibleText}`,
      { cause: error },
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    noReceiptRequests,
    1,
    'No-receipt exchange UI must emit exactly one POST /v1/no-receipt-exchanges request.',
  );
  assert.ok(
    noReceiptResponseStatus === 200 || noReceiptResponseStatus === 201,
    `No-receipt exchange returned HTTP ${String(noReceiptResponseStatus)}.`,
  );

  const exchangeSales = await browserRequest('/v1/admin/sales?limit=20');
  let exchangeSaleDetail = null;
  for (const sale of exchangeSales.items) {
    if (sale.terminal?.id !== terminal.id || sale.status !== 'finalized') continue;
    const detail = await browserRequest(`/v1/admin/sales/${encodeURIComponent(sale.id)}`);
    if (detail.tenders.some((tender) => tender.kind === 'exchange_allowance')) {
      exchangeSaleDetail = detail;
      break;
    }
  }
  assert.ok(
    exchangeSaleDetail !== null,
    'Linked replacement sale with exchange allowance is missing.',
  );
  const allowanceTender = exchangeSaleDetail.tenders.find(
    (tender) => tender.kind === 'exchange_allowance',
  );
  assert.equal(allowanceTender?.amountMinor, exchangeReplacementTotalMinor.toString());
  assert.equal(allowanceTender?.changeMinor, '0');
  assert.equal(
    exchangeSaleDetail.tenders.some((tender) => tender.kind === 'cash'),
    false,
    'Exact allowance exchange must not invent a cash tender.',
  );

  const exchangeBalance = await browserRequest(
    `/v1/admin/inventory/balances?branchId=${encodeURIComponent(branch.id)}&limit=50`,
  );
  const exchangeRow = exchangeBalance.rows.find((row) => row.sku === 'BROWSER-SKU-001');
  assert.equal(
    exchangeRow?.quantityScaled,
    '10000',
    'Accepted stock + replacement sale must net to zero authoritative quantity.',
  );
  const exchangeCost = await browserRequest(
    `/v1/admin/inventory/cost-balances?branchId=${encodeURIComponent(branch.id)}&limit=50`,
  );
  const exchangeCostRow = exchangeCost.rows.find((row) => row.sku === 'BROWSER-SKU-001');
  assert.equal(exchangeCostRow?.knownQuantityScaled, '10000');
  assert.equal(exchangeCostRow?.unknownPositiveQuantityScaled, '0');
  record(
    'actual Chrome cashier UI completed an online-authoritative no-receipt exchange; allowance settled exactly, drawer unchanged, stock net-zero',
  );
  await capture('cashier-v2-1-no-receipt-success');
  await clickButton('تم وابدأ بيعاً جديداً');
  await waitForText('ابحث أو امسح الباركود', 20_000);

  await cdp.send('Page.navigate', { url: `${baseUrl}/control/promotions` });
  await waitForText('العروض والكوبونات', 30_000);
  await waitForText('إنشاء عرض', 30_000);
  await setInput('promotion-code', 'BROWSER-COUPON-PROMO');
  await setInput('promotion-name', 'خصم برهان الكوبون');
  await setSelectByLabelText('طريقة التفعيل', 'coupon');
  await setSelectByLabelText('نوع الخصم', 'fixed');
  await setInput('promotion-effect-value', '100');
  await setInput('promotion-priority', '500');
  await clickButton('إنشاء كمسودة');
  await waitForText('تم إنشاء العرض كمسودة', 30_000);
  await waitForText('BROWSER-COUPON-PROMO', 20_000);
  await clickButton('تفعيل');
  await waitForText('تم تفعيل العرض', 30_000);
  await setInputByLabelText('كود جديد', 'BROWSER10');
  await setInputByLabelText('حد الاستخدام (اختياري)', '1');
  await clickButton('إضافة الكوبون');
  await waitForText('تم إنشاء كود الخصم', 30_000);
  await waitForText('BROWSER10', 20_000);
  await capture('control-v2-2-promotion-coupon-success');

  const promotionTruthAfterControl = await browserRequest('/v1/admin/promotions');
  const activatedCouponPromotion = promotionTruthAfterControl.promotions.find(
    (promotion) => promotion.merchantCode === 'BROWSER-COUPON-PROMO',
  );
  assert.ok(
    activatedCouponPromotion !== undefined,
    'Promotion created through Control UI is missing from server truth.',
  );
  assert.equal(activatedCouponPromotion.status, 'active');
  const proofCoupon = activatedCouponPromotion.coupons.find(
    (coupon) => coupon.normalizedCode === 'BROWSER10',
  );
  assert.ok(
    proofCoupon !== undefined,
    'Coupon created through Control UI is missing from server truth.',
  );
  assert.equal(proofCoupon.totalRedemptionLimit, 1);
  record(
    'actual Chrome Control UI created, activated and persisted a one-use coupon through promotion.manage authority',
  );

  await cdp.send('Page.navigate', { url: `${baseUrl}/cashier` });
  await waitForText('ابحث أو امسح الباركود', 30_000);
  await waitFor(
    `(() => {
      const input = document.getElementById('product-search');
      return input instanceof HTMLInputElement && !input.disabled;
    })()`,
    'cashier durable draft hydration before coupon proof',
    20_000,
  );

  // newSale() clears the durable IndexedDB draft through an ordered async write
  // chain. Navigating to Control immediately afterwards can race that delete,
  // so a stale one-line draft may legitimately hydrate when we return. Prove
  // the coupon from an explicitly empty cashier state instead of assuming the
  // previous page's async cleanup completed before navigation.
  const staleCartPresent = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(
      (candidate) => (candidate.textContent ?? '').replace(/\\s+/g, ' ').trim() === 'إفراغ السلة'
    );
    return button instanceof HTMLButtonElement;
  })()`);
  if (staleCartPresent) {
    await waitFor(
      `(() => {
        const button = [...document.querySelectorAll('button')].find(
          (candidate) => (candidate.textContent ?? '').replace(/\\s+/g, ' ').trim() === 'إفراغ السلة'
        );
        return button instanceof HTMLButtonElement && !button.disabled;
      })()`,
      'restored durable cart to unlock before clearing',
      20_000,
    );
    const clearedRestoredDraft = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find(
        (candidate) => (candidate.textContent ?? '').replace(/\\s+/g, ' ').trim() === 'إفراغ السلة'
      );
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    })()`);
    assert.equal(
      clearedRestoredDraft,
      true,
      'Restored durable cart could not be cleared before coupon proof.',
    );
    await waitForText('السلة فارغة', 20_000);
    record('coupon proof cleared a legitimately restored durable draft before starting its sale');
  } else {
    await waitForText('السلة فارغة', 20_000);
  }

  await setInput('product-search', 'BROWSER-SKU-001');
  await waitForText('صنف برهان المتصفح', 20_000);
  await clickButton('صنف برهان المتصفح');

  const couponBaseMajor = await amountAfterLabel('الإجمالي المستحق');
  const couponBaseMinor = majorToMinor(couponBaseMajor);
  assert.equal(
    couponBaseMinor,
    exchangeReplacementTotalMinor,
    'Coupon proof product changed base price before the coupon was entered.',
  );

  await setInput('coupon-code', 'BROWSER10');
  await waitForText('خصم العروض', 20_000);
  const couponTotalMajor = await amountAfterLabel('الإجمالي المستحق');
  const couponTotalMinor = majorToMinor(couponTotalMajor);
  assert.equal(
    couponTotalMinor,
    couponBaseMinor - 100n,
    'Server-authoritative coupon preview did not reduce the sale by exactly 1.00 SAR.',
  );

  await clickButton('إلكتروني / متعدد');
  await setInputByAriaLabel('مبلغ الدفعة الإلكترونية 1', minorToMajor(couponTotalMinor));
  await setInputByAriaLabel('مرجع الموافقة 1', 'V22-COUPON-PROOF-001');
  await clickButton('إتمام البيع');
  await waitForText('تمّت العملية', 30_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(saleRequests, 3, 'Coupon checkout must add exactly one POST /v1/sales request.');

  const couponSalesPage = await browserRequest('/v1/admin/sales?limit=20');
  let couponSaleDetail = null;
  for (const sale of couponSalesPage.items) {
    if (sale.terminal?.id !== terminal.id || sale.status !== 'finalized') continue;
    const detail = await browserRequest(`/v1/admin/sales/${encodeURIComponent(sale.id)}`);
    if (
      detail.tenders.some(
        (tender) => tender.kind === 'electronic' && tender.reference === 'V22-COUPON-PROOF-001',
      )
    ) {
      couponSaleDetail = detail;
      break;
    }
  }
  assert.ok(couponSaleDetail !== null, 'Coupon proof sale missing from server truth.');
  assert.equal(couponSaleDetail.totalMinor, couponTotalMinor.toString());
  const couponTender = couponSaleDetail.tenders.find(
    (tender) => tender.reference === 'V22-COUPON-PROOF-001',
  );
  assert.equal(couponTender?.amountMinor, couponTotalMinor.toString());

  const promotionTruth = await browserRequest('/v1/admin/promotions');
  const storedPromotion = promotionTruth.promotions.find(
    (promotion) => promotion.id === activatedCouponPromotion.id,
  );
  const storedCoupon = storedPromotion?.coupons.find((coupon) => coupon.id === proofCoupon.id);
  assert.equal(storedCoupon?.observedRedemptionCount, 1);
  record(
    'actual Chrome cashier applied one-use coupon through server preview, finalized the discounted sale, and durable redemption count became 1',
  );
  await capture('cashier-v2-2-coupon-success');
  await clickButton('عملية بيع جديدة');
  await waitForText('ابحث أو امسح الباركود', 20_000);

  await cdp.send('Page.navigate', { url: `${baseUrl}/control/lots` });
  await waitForText('إدارة الدفعات وتواريخ الصلاحية', 30_000);
  await setInput('lot-product-search', 'BROWSER-SKU-001');
  await pressEnter();
  await waitForText('BROWSER-SKU-001', 20_000);
  await clickButton('صنف برهان المتصفح');
  await waitForText('غير مفعل', 20_000);
  await setSelectByLabelText('سياسة الاختيار عند الصرف', 'fefo');
  await setSelectByLabelText('تاريخ الدفعة', 'optional');
  await clickButton('تفعيل تتبع الدفعات');
  await waitForText('تم تفعيل تتبع الدفعات', 30_000);
  await waitForText('رصيد تاريخي غير معروف', 20_000);

  const lotTruthBeforeSale = await browserRequest(
    `/v1/admin/lots/products/${encodeURIComponent(beforeRow.productId)}`,
  );
  assert.equal(lotTruthBeforeSale.config.trackingMode, 'required');
  assert.equal(lotTruthBeforeSale.config.selectionPolicy, 'fefo');
  const baselineLot = lotTruthBeforeSale.config.lots.find(
    (lot) =>
      lot.provenance === 'historical-unknown' &&
      lot.availabilityByBranch.some((row) => row.branchId === branch.id),
  );
  assert.ok(
    baselineLot !== undefined,
    'Lot tracking activation did not create historical baseline.',
  );
  const baselineAvailability = baselineLot.availabilityByBranch.find(
    (row) => row.branchId === branch.id,
  );
  assert.ok(
    baselineAvailability !== undefined,
    'Historical baseline lot has no availability for the proof branch.',
  );
  const baselineQuantityBeforeSale = BigInt(baselineAvailability.quantityScaled);
  assert.ok(
    baselineQuantityBeforeSale >= 1000n,
    'Historical baseline must contain at least one sellable unit.',
  );
  record(
    'actual Chrome Control UI enabled FEFO lot tracking and preserved existing stock as explicit historical-unknown provenance',
  );
  await capture('control-v2-4-lot-tracking-success');

  await cdp.send('Page.navigate', { url: `${baseUrl}/cashier` });
  await waitForText('ابحث أو امسح الباركود', 30_000);
  await waitFor(
    `(() => {
      const input = document.getElementById('product-search');
      return input instanceof HTMLInputElement && !input.disabled;
    })()`,
    'cashier durable draft hydration before lot-controlled sale',
    20_000,
  );

  const lotStaleCartPresent = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find(
      (candidate) => (candidate.textContent ?? '').replace(/\\s+/g, ' ').trim() === 'إفراغ السلة'
    );
    return button instanceof HTMLButtonElement;
  })()`);
  if (lotStaleCartPresent) {
    await clickButton('إفراغ السلة');
    await waitFor(
      `![...document.querySelectorAll('button')].some(
        (candidate) => (candidate.textContent ?? '').replace(/\\s+/g, ' ').trim() === 'إفراغ السلة'
      )`,
      'restored lot-proof cart to clear',
      20_000,
    );
  }

  await setInput('product-search', 'BROWSER-SKU-001');
  await pressEnter();
  await waitForText('صنف برهان المتصفح', 20_000);
  await clickButton('صنف برهان المتصفح');
  await clickButton('إلكتروني / متعدد');
  const lotSaleTotalMajor = await amountAfterLabel('الإجمالي المستحق');
  const lotSaleTotalMinor = majorToMinor(lotSaleTotalMajor);
  await setInputByAriaLabel('مبلغ الدفعة الإلكترونية 1', minorToMajor(lotSaleTotalMinor));
  await setInputByAriaLabel('مرجع الموافقة 1', 'V24-LOT-PROOF-001');
  await clickButton('إتمام البيع');
  await waitForText('تمّت العملية', 30_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    saleRequests,
    4,
    'Lot-controlled online checkout must add exactly one POST /v1/sales request.',
  );

  const lotTruthAfterSale = await browserRequest(
    `/v1/admin/lots/products/${encodeURIComponent(beforeRow.productId)}`,
  );
  const storedBaselineLot = lotTruthAfterSale.config.lots.find((lot) => lot.id === baselineLot.id);
  assert.ok(storedBaselineLot !== undefined, 'Baseline lot disappeared after sale.');
  const afterAvailability = storedBaselineLot.availabilityByBranch.find(
    (row) => row.branchId === branch.id,
  );
  const baselineQuantityAfterSale = BigInt(afterAvailability?.quantityScaled ?? '0');
  assert.equal(
    baselineQuantityBeforeSale - baselineQuantityAfterSale,
    1000n,
    'Lot-controlled sale did not consume exactly one base unit from the FEFO-selected lot.',
  );

  const lotSalesPage = await browserRequest('/v1/admin/sales?limit=20');
  let lotSaleDetail = null;
  for (const sale of lotSalesPage.items) {
    if (sale.terminal?.id !== terminal.id || sale.status !== 'finalized') continue;
    const detail = await browserRequest(`/v1/admin/sales/${encodeURIComponent(sale.id)}`);
    if (
      detail.tenders.some(
        (tender) => tender.kind === 'electronic' && tender.reference === 'V24-LOT-PROOF-001',
      )
    ) {
      lotSaleDetail = detail;
      break;
    }
  }
  assert.ok(lotSaleDetail !== null, 'Lot-controlled proof sale missing from server truth.');
  assert.equal(lotSaleDetail.totalMinor, lotSaleTotalMinor.toString());
  record(
    'actual Chrome cashier finalized a lot-controlled online sale; authoritative lot availability decreased by exactly one base unit',
  );
  await capture('cashier-v2-4-lot-controlled-sale-success');
  await clickButton('عملية بيع جديدة');
  await waitForText('ابحث أو امسح الباركود', 20_000);

  const purchasingSuppliers = await browserRequest(
    '/v1/admin/purchasing/suppliers?limit=50&activeOnly=true',
  );
  const lotProofSupplier = purchasingSuppliers.rows.find(
    (supplier) => supplier.name === 'مورد برهان المتصفح',
  );
  assert.ok(lotProofSupplier !== undefined, 'V2-4 receiving proof supplier is missing.');
  const lotProofOrderResult = await browserRequest('/v1/admin/purchasing/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operationId: `v24-lot-po-${Date.now().toString()}`,
      supplierId: lotProofSupplier.id,
      branchId: branch.id,
      reference: 'BROWSER-V24-LOT-PO-001',
      lines: [{ productId: beforeRow.productId, orderedQuantityScaled: '1000' }],
    }),
  });
  const lotProofOrder = lotProofOrderResult.order;
  assert.equal(lotProofOrder.reference, 'BROWSER-V24-LOT-PO-001');

  await cdp.send('Page.navigate', { url: `${baseUrl}/control/purchasing` });
  await waitForText('المشتريات والاستلام', 30_000);
  await clickButton('الاستلامات');
  await waitForText('BROWSER-V24-LOT-PO-001', 30_000);
  const selectedLotProofOrder = await evaluate(`(() => {
    const row = [...document.querySelectorAll('tr')].find((candidate) =>
      (candidate.textContent ?? '').includes('BROWSER-V24-LOT-PO-001')
    );
    const button = row?.querySelector('button');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    button.click();
    return true;
  })()`);
  assert.equal(selectedLotProofOrder, true, 'Could not select V2-4 lot receiving proof order.');
  await waitFor(
    `[...document.querySelectorAll('button')].some(
      (button) => !button.disabled && (button.textContent ?? '').includes('تسجيل الاستلام')
    )`,
    'lot-aware receiving form',
    30_000,
  );

  await setInputByLabelText('مرجع إشعار التسليم', 'BROWSER-V24-GRN-001');
  await setInputByLabelText('الكمية المستلمة', '1');
  await clickButton('إضافة دفعة');
  await setInputByLabelText('كمية الدفعة', '1');
  await setInputByLabelText('Batch / رقم الدفعة', 'V24-BATCH-001');
  await setSelectByLabelText('نوع التاريخ', 'expiry');
  await setInputByAriaLabelPrefix('تاريخ الدفعة 1 ', '2027-12-31');

  let lotReceiptRequests = 0;
  let lotReceiptResponseStatus = null;
  let lotReceiptResponseBody = null;
  let lotReceiptBodyPromise = null;
  cdp.on('Network.requestWillBeSent', (params) => {
    const request = params.request;
    if (
      request?.method === 'POST' &&
      new URL(request.url).pathname === '/v1/admin/purchasing/receipts'
    ) {
      lotReceiptRequests += 1;
    }
  });
  cdp.on('Network.responseReceived', (params) => {
    if (new URL(params.response.url).pathname !== '/v1/admin/purchasing/receipts') return;
    lotReceiptResponseStatus = params.response.status;
    lotReceiptBodyPromise = cdp
      .send('Network.getResponseBody', { requestId: params.requestId })
      .then((payload) => {
        lotReceiptResponseBody = payload.body;
      })
      .catch(() => undefined);
  });

  await clickButton('تسجيل الاستلام');
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  if (lotReceiptRequests === 0) {
    const visibleText = String(await evaluate(`document.body?.innerText ?? ''`))
      .replace(/\s+/g, ' ')
      .slice(-1800);
    throw new Error(
      `Lot-aware receiving emitted no POST /v1/admin/purchasing/receipts request. Visible UI tail: ${visibleText}`,
    );
  }
  if (lotReceiptBodyPromise !== null) await lotReceiptBodyPromise;
  if (
    lotReceiptResponseStatus !== null &&
    lotReceiptResponseStatus !== 200 &&
    lotReceiptResponseStatus !== 201
  ) {
    throw new Error(
      `Lot-aware receiving returned HTTP ${String(lotReceiptResponseStatus)}: ${String(lotReceiptResponseBody)}`,
    );
  }

  try {
    await waitForText('سُجل الاستلام وحركة المخزون ذريًا.', 20_000);
  } catch (error) {
    const visibleText = String(await evaluate(`document.body?.innerText ?? ''`))
      .replace(/\s+/g, ' ')
      .slice(-1800);
    throw new Error(
      `Lot-aware receiving did not reach success after HTTP ${String(lotReceiptResponseStatus)}. Response: ${String(lotReceiptResponseBody)}. Visible UI tail: ${visibleText}`,
      { cause: error },
    );
  }

  const lotProofReceipts = await browserRequest(
    `/v1/admin/purchasing/orders/${encodeURIComponent(lotProofOrder.id)}/receipts?limit=20`,
  );
  assert.equal(lotProofReceipts.receipts.length, 1);
  const lotProofReceiptLine = lotProofReceipts.receipts[0]?.lines[0];
  assert.equal(lotProofReceiptLine?.lots?.length, 1);
  assert.equal(lotProofReceiptLine?.lots?.[0]?.externalBatchReference, 'V24-BATCH-001');
  assert.equal(lotProofReceiptLine?.lots?.[0]?.dateKind, 'expiry');
  assert.equal(lotProofReceiptLine?.lots?.[0]?.dateValue, '2027-12-31');

  const lotTruthAfterReceiving = await browserRequest(
    `/v1/admin/lots/products/${encodeURIComponent(beforeRow.productId)}`,
  );
  const receivedProofLot = lotTruthAfterReceiving.config.lots.find(
    (lot) => lot.externalBatchReference === 'V24-BATCH-001',
  );
  assert.ok(
    receivedProofLot !== undefined,
    'UI receipt did not create the authoritative received lot.',
  );
  assert.equal(receivedProofLot.provenance, 'received');
  assert.equal(receivedProofLot.dateKind, 'expiry');
  assert.equal(receivedProofLot.dateValue, '2027-12-31');
  assert.equal(
    receivedProofLot.availabilityByBranch.find((row) => row.branchId === branch.id)?.quantityScaled,
    '1000',
  );
  record(
    'actual Chrome purchasing UI received a lot-controlled item with explicit batch/expiry provenance and server truth preserved the allocation',
  );
  await capture('control-v2-4-lot-aware-receiving-success');

  await cdp.send('Page.navigate', { url: `${baseUrl}/cashier` });
  await waitForText('ابحث أو امسح الباركود', 30_000);

  await clickButton('إغلاق الوردية');
  await waitForText('إغلاق الوردية وتسوية الدرج', 20_000);
  await setInput('shift-close-declared-cash', '101.00');

  let closeRequests = 0;
  cdp.on('Network.requestWillBeSent', (params) => {
    const request = params.request;
    if (request?.method === 'POST' && new URL(request.url).pathname === '/v1/shifts/close')
      closeRequests += 1;
  });

  await clickButton('اعتماد العد وإغلاق الوردية');
  await waitForText('أغلقت الوردية واعتمدت التسوية من الخادم.', 30_000);
  await waitForText('الفارق (المعدود − المتوقع)', 20_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    closeRequests,
    1,
    'Shift-close UI must emit exactly one POST /v1/shifts/close request.',
  );

  const currentShift = await browserRequest(
    `/v1/shifts/current?terminalId=${encodeURIComponent(terminal.id)}`,
  );
  assert.equal(
    currentShift.shift,
    null,
    'Closed shift must disappear from current-shift authority.',
  );
  record(
    'cashier UI completed blind-count shift close; server reconciliation closed the authoritative shift',
  );

  const overflow = await evaluate(
    `document.documentElement.scrollWidth > document.documentElement.clientWidth + 1`,
  );
  assert.equal(overflow, false, 'Cashier commercial workflow has body-level horizontal overflow.');
  await capture('cashier-commercial-workflows-success');

  await clickButton('إنهاء والعودة');
  await waitForText('افتح وردية', 20_000);

  record(
    `Gate 20 + AR-2 commercial browser proof completed for ${process.env.GITHUB_SHA ?? 'local-sha-unknown'}`,
  );
  await writeFile(`${artifactDirectory}/cashier-proof.txt`, `${evidence.join('\n')}\n`, {
    mode: 0o600,
  });
} catch (error) {
  await capture('cashier-sale-failure').catch(() => undefined);
  await writeFile(
    `${artifactDirectory}/cashier-proof.txt`,
    `${evidence.join('\n')}\nFAIL: ${error instanceof Error ? error.message : 'unknown failure'}\n`,
    { mode: 0o600 },
  );
  throw error;
} finally {
  cdp.close();
}
