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
  assert.equal(changed, true, `Input #${id} was not available.`);
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

async function browserRequest(path, init = {}) {
  const result = await evaluate(`(async () => {
    const response = await fetch(${jsString(path)}, {
      credentials: 'same-origin',
      ...${JSON.stringify(init)},
      headers: {
        accept: 'application/json',
        ...(${JSON.stringify(init.headers ?? {})})
      }
    });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  })()`);
  assert.equal(
    result.ok,
    true,
    `${path} returned HTTP ${String(result.status)}: ${JSON.stringify(result.body)}`,
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

  await setInput('product-search', 'BROWSER-SKU-001');
  await pressEnter();
  await waitForText('صنف برهان المتصفح', 20_000);
  await clickButton('صنف برهان المتصفح');

  await clickButton('إلكتروني / متعدد');
  const totalMajor = await amountAfterLabel('الإجمالي المستحق');
  const totalMinor = majorToMinor(totalMajor);
  const cashTenderMinor = 100n;
  const electronicTenderMinor = totalMinor - cashTenderMinor;
  assert.ok(electronicTenderMinor > 0n, 'Proof item total must exceed the 1.00 SAR cash split.');

  await setInput('cash-received', '1.00');
  await setInputByAriaLabel('مبلغ الدفعة الإلكترونية 1', minorToMajor(electronicTenderMinor));
  await setInputByAriaLabel('مرجع الموافقة 1', 'AR2-MIXED-PROOF-001');

  let saleRequests = 0;
  cdp.on('Network.requestWillBeSent', (params) => {
    const request = params.request;
    if (request?.method === 'POST' && new URL(request.url).pathname === '/v1/sales')
      saleRequests += 1;
  });

  await clickButton('إتمام البيع');
  await waitForText('تمّت العملية', 30_000);
  await waitForText('فاتورة', 30_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    saleRequests,
    1,
    'A successful cashier sale must emit exactly one POST /v1/sales request.',
  );

  const receiptText = await evaluate(`document.body?.innerText ?? ''`);
  assert.match(receiptText, /صنف برهان المتصفح/u);
  assert.match(receiptText, /عملية بيع جديدة/u);
  record('actual Chrome cashier UI completed one sale and rendered the server-owned receipt');

  const salesPage = await browserRequest('/v1/admin/sales?limit=10');
  const proofSale = salesPage.items.find(
    (sale) => sale.terminal?.id === terminal.id && sale.status === 'finalized',
  );
  assert.ok(
    proofSale !== undefined,
    'Mixed-tender proof sale was not visible in server sales truth.',
  );
  const proofSaleDetail = await browserRequest(
    `/v1/admin/sales/${encodeURIComponent(proofSale.id)}`,
  );
  const cashTender = proofSaleDetail.tenders.find((tender) => tender.kind === 'cash');
  const electronicTender = proofSaleDetail.tenders.find((tender) => tender.kind === 'electronic');
  assert.equal(cashTender?.amountMinor, cashTenderMinor.toString());
  assert.equal(electronicTender?.amountMinor, electronicTenderMinor.toString());
  assert.equal(electronicTender?.scheme, 'mada');
  assert.equal(electronicTender?.reference, 'AR2-MIXED-PROOF-001');
  record(
    'server truth preserved the exact cash + Mada mixed tender composition from the cashier UI',
  );

  const afterBalance = await browserRequest(
    `/v1/admin/inventory/balances?branchId=${encodeURIComponent(branch.id)}&limit=50`,
  );
  const afterRow = afterBalance.rows.find((row) => row.sku === 'BROWSER-SKU-001');
  assert.equal(afterRow?.quantityScaled, '10000');

  const afterCost = await browserRequest(
    `/v1/admin/inventory/cost-balances?branchId=${encodeURIComponent(branch.id)}&limit=50`,
  );
  const afterCostRow = afterCost.rows.find((row) => row.sku === 'BROWSER-SKU-001');
  assert.equal(afterCostRow?.quantityScaled, '10000');
  assert.equal(afterCostRow?.knownQuantityScaled, '10000');
  assert.equal(afterCostRow?.unknownPositiveQuantityScaled, '0');
  assert.equal(afterCostRow?.knownValueMinor, '5000');
  record(
    'server truth reconciles exactly after sale: stock 11→10 and known cost pool 55.00→50.00 SAR',
  );

  await clickButton('عملية بيع جديدة');
  await waitForText('ابحث أو امسح الباركود', 20_000);
  await clickButton('مرتجع / استرداد');
  await waitForText('إنشاء مرتجع', 20_000);
  await setInput('return-search', proofSale.invoiceNumber ?? String(proofSale.sequence));
  await clickButton('بحث');
  await clickButton(proofSale.invoiceNumber ?? `#${String(proofSale.sequence)}`);
  await waitForText('المتبقي:', 20_000);
  await setInputByAriaLabel('كمية إرجاع صنف برهان المتصفح', '1');
  await setSelect('return-refund-kind', 'electronic');
  await setSelect('return-refund-scheme', 'mada');
  await setInput('return-refund-reference', 'AR2-REFUND-PROOF-001');

  let returnRequests = 0;
  cdp.on('Network.requestWillBeSent', (params) => {
    const request = params.request;
    if (request?.method === 'POST' && new URL(request.url).pathname === '/v1/returns')
      returnRequests += 1;
  });

  await clickButton('اعتماد المرتجع');
  await waitForText('تم اعتماد المرتجع', 30_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(returnRequests, 1, 'Return UI must emit exactly one POST /v1/returns request.');

  const returnedSaleDetail = await browserRequest(
    `/v1/admin/sales/${encodeURIComponent(proofSale.id)}`,
  );
  assert.equal(returnedSaleDetail.returns.length, 1);
  assert.equal(returnedSaleDetail.returns[0]?.totalMinor, totalMinor.toString());

  const restoredBalance = await browserRequest(
    `/v1/admin/inventory/balances?branchId=${encodeURIComponent(branch.id)}&limit=50`,
  );
  const restoredRow = restoredBalance.rows.find((row) => row.sku === 'BROWSER-SKU-001');
  assert.equal(restoredRow?.quantityScaled, '11000');
  record('cashier UI executed a server-priced return and inventory returned 10→11 units');

  await clickButton('تم');
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
