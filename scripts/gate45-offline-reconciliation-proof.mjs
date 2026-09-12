import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const baseUrl = process.env.KORVI_GATE45_BASE_URL ?? 'http://localhost:3000';
const tenantSlug = process.env.KORVI_BROWSER_TENANT_SLUG ?? 'stage5d-browser-proof';
const ownerEmail = process.env.KORVI_BROWSER_OWNER_EMAIL ?? 'owner@stage5d-browser-proof.test';
const password = process.env.KORVI_BROWSER_PASSWORD;
const chromePort = process.env.KORVI_GATE45_CHROME_PORT ?? '9226';
const artifactDirectory = process.env.KORVI_GATE45_ARTIFACT_DIR ?? 'artifacts/gate45-offline-proof';

if (password === undefined || password.length < 16) {
  throw new Error('KORVI_BROWSER_PASSWORD must contain at least 16 characters.');
}

await mkdir(artifactDirectory, { recursive: true });
const evidence = [];
function record(message) {
  evidence.push(message);
  console.log(`[gate45] ${message}`);
}

function js(value) {
  return JSON.stringify(value);
}

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

  async send(method, params = {}) {
    await this.ready();
    const id = this.#nextId++;
    const answer = new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#socket.send(JSON.stringify({ id, method, params }));
    return answer;
  }

  close() {
    this.#socket.close();
  }
}

async function createTarget(url) {
  const response = await fetch(
    `http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
  );
  if (!response.ok) throw new Error(`Unable to create Chrome target: ${String(response.status)}`);
  return response.json();
}

const target = await createTarget(`${baseUrl}/`);
assert.equal(typeof target.webSocketDebuggerUrl, 'string');
const cdp = new CdpClient(target.webSocketDebuggerUrl);
await Promise.all([
  cdp.send('Page.enable'),
  cdp.send('Runtime.enable'),
  cdp.send('Network.enable'),
  cdp.send('DOM.enable'),
]);

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.text ?? 'Browser evaluation failed.');
  }
  return result.result?.value;
}

async function waitFor(expression, label, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForText(text, timeoutMs = 25_000) {
  await waitFor(
    `document.body?.innerText.includes(${js(text)}) === true`,
    `text ${JSON.stringify(text)}`,
    timeoutMs,
  );
}

async function setInput(id, value) {
  const changed = await evaluate(`(() => {
    const input = document.getElementById(${js(id)});
    if (!(input instanceof HTMLInputElement)) return false;
    input.scrollIntoView({ block: 'center', inline: 'nearest' });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter === undefined) return false;
    setter.call(input, ${js(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
    return true;
  })()`);
  assert.equal(changed, true, `Input #${id} was not available.`);
}

async function pointForButton(text) {
  const point = await evaluate(`(() => {
    const wanted = ${js(text)};
    const button = [...document.querySelectorAll('button')].find((candidate) =>
      !candidate.disabled && (candidate.textContent ?? '').replace(/\\s+/g, ' ').trim().includes(wanted)
    );
    if (!(button instanceof HTMLButtonElement)) return null;
    button.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = button.getBoundingClientRect();
    const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    if (rect.width <= 0 || rect.height <= 0 || point.x < 0 || point.y < 0 || point.x > innerWidth || point.y > innerHeight) return null;
    return point;
  })()`);
  assert.ok(point !== null, `Enabled button containing ${JSON.stringify(text)} was not visible.`);
  return point;
}

async function clickButton(text) {
  await waitFor(
    `([...document.querySelectorAll('button')].some((button) => !button.disabled && (button.textContent ?? '').replace(/\\s+/g, ' ').trim().includes(${js(text)})))`,
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

async function capture(name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  assert.equal(typeof shot.data, 'string');
  await writeFile(`${artifactDirectory}/${name}.png`, Buffer.from(shot.data, 'base64'), {
    mode: 0o600,
  });
}

async function queueRows() {
  return evaluate(`new Promise((resolve, reject) => {
    const open = indexedDB.open('korvi-pos-offline');
    open.onerror = () => reject(open.error ?? new Error('IndexedDB open failed'));
    open.onsuccess = () => {
      const database = open.result;
      if (!database.objectStoreNames.contains('transaction-queue-v1')) {
        database.close();
        resolve([]);
        return;
      }
      const tx = database.transaction('transaction-queue-v1', 'readonly');
      const request = tx.objectStore('transaction-queue-v1').getAll();
      request.onerror = () => reject(request.error ?? new Error('Queue read failed'));
      request.onsuccess = () => {
        resolve(request.result.map((row) => ({
          id: row.id,
          state: row.state,
          attempts: row.attempts,
          enqueuedAt: row.enqueuedAt,
          rejectionReason: row.rejectionReason,
          tenantId: row.tenantId,
          branchId: row.branchId,
          terminalId: row.terminalId,
          payload: JSON.parse(row.payloadJson),
        })));
        database.close();
      };
    };
  })`);
}

async function queuedOperationId() {
  const value = await evaluate(`(() => {
    const match = (document.body?.innerText ?? '').match(/معرّف العملية:\\s*([0-9a-f-]{36})/i);
    return match?.[1] ?? null;
  })()`);
  assert.equal(typeof value, 'string', 'Queued operation id was not rendered.');
  return value;
}

async function setBrowserOffline(offline) {
  await cdp.send('Network.emulateNetworkConditions', {
    offline,
    latency: 0,
    downloadThroughput: offline ? 0 : -1,
    uploadThroughput: offline ? 0 : -1,
  });
  await waitFor(
    `navigator.onLine === ${offline ? 'false' : 'true'}`,
    offline ? 'browser offline state' : 'browser online state',
  );
}

async function loginAdminSession() {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: baseUrl,
    },
    body: JSON.stringify({ tenantSlug, email: ownerEmail, password }),
  });
  const body = await response.json().catch(() => null);
  assert.equal(response.ok, true, `Admin login failed: ${String(response.status)} ${JSON.stringify(body)}`);
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
  assert.ok(raw.length > 0, 'Admin login did not return a session cookie.');
  const cookie = raw.map((value) => value.split(';', 1)[0]).join('; ');
  return { cookie, principal: body };
}

async function adminRequest(cookie, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      cookie,
      origin: baseUrl,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  assert.equal(
    response.ok,
    true,
    `${path} returned HTTP ${String(response.status)}: ${JSON.stringify(body)}`,
  );
  return body;
}

async function inventoryRow(cookie, branchId, productId) {
  const page = await adminRequest(
    cookie,
    `/v1/admin/inventory/balances?branchId=${encodeURIComponent(branchId)}&limit=50`,
  );
  const row = page.rows.find((candidate) => candidate.productId === productId);
  assert.ok(row !== undefined, 'Gate 45 inventory row is missing.');
  return row;
}

try {
  const admin = await loginAdminSession();
  assert.equal(typeof admin.principal?.user?.id, 'string', 'Authenticated admin user id missing.');

  const branches = await adminRequest(admin.cookie, '/v1/admin/inventory/branches?limit=50');
  const branch = branches.rows.find((row) => row.nameAr === 'فرع ألف');
  assert.ok(branch !== undefined, 'Stage 5D branch A is missing.');

  const balances = await adminRequest(
    admin.cookie,
    `/v1/admin/inventory/balances?branchId=${encodeURIComponent(branch.id)}&limit=50`,
  );
  const seeded = balances.rows.find((row) => row.sku === 'BROWSER-SKU-001');
  assert.ok(seeded !== undefined, 'Stage 5D browser product is missing.');
  assert.equal(seeded.quantityScaled, '11000', 'Gate 45 requires the proved 11-unit Stage 5D stock baseline.');

  const terminal = await adminRequest(admin.cookie, '/v1/admin/terminals', {
    method: 'POST',
    body: JSON.stringify({
      branchId: branch.id,
      code: 'POS-GATE45-01',
      label: 'صندوق برهان التسوية دون اتصال',
    }),
  });
  assert.equal(terminal.branchId, branch.id);

  const member = await adminRequest(
    admin.cookie,
    `/v1/admin/members/${encodeURIComponent(admin.principal.user.id)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ defaultBranchId: branch.id }),
    },
  );
  assert.equal(member.defaultBranchId, branch.id);
  record('legitimate merchant authorities established the branch, till and cashier assignment');

  await waitFor(
    `document.getElementById('tenant-slug') instanceof HTMLInputElement`,
    'cashier login form',
  );
  await setInput('tenant-slug', tenantSlug);
  await setInput('email', ownerEmail);
  await setInput('password', password);
  await clickButton('دخول');

  await waitForText('افتح وردية', 30_000);
  await setInput('opening-float', '100.00');
  await clickButton('فتح الوردية');
  await waitForText('ابحث أو امسح الباركود', 30_000);
  record('actual Chrome cashier UI opened a real server-authorized shift');

  async function addProofProduct() {
    await setInput('product-search', 'BROWSER-SKU-001');
    await pressEnter();
    await waitForText('صنف برهان المتصفح', 20_000);
    await clickButton('صنف برهان المتصفح');
    await setInput('cash-received', '100.00');
  }

  await addProofProduct();
  assert.deepEqual(await queueRows(), [], 'Queue must begin empty on the fresh browser profile.');
  record('online catalogue result was rendered and durably cached before the outage');

  await setBrowserOffline(true);
  await clickButton('إتمام البيع');
  await waitForText('بيع دون اتصال — محفوظ بأمان', 30_000);
  const firstOperationId = await queuedOperationId();
  let rows = await queueRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, firstOperationId);
  assert.equal(rows[0]?.state, 'pending');
  assert.equal(rows[0]?.payload.expectedShiftId?.length, 36);
  await capture('01-first-offline-sale-queued');
  record('first offline checkout became one immutable durable pending command before the till unlocked');

  await clickButton('بدء بيع جديد');
  await addProofProduct();
  await clickButton('إتمام البيع');
  await waitForText('بيع دون اتصال — محفوظ بأمان', 30_000);
  const secondOperationId = await queuedOperationId();
  assert.notEqual(secondOperationId, firstOperationId);
  rows = await queueRows();
  const firstPending = rows.find((row) => row.id === firstOperationId);
  const secondPending = rows.find((row) => row.id === secondOperationId);
  assert.equal(firstPending?.state, 'pending');
  assert.equal(secondPending?.state, 'pending');
  assert.equal(rows.filter((row) => row.state === 'pending').length, 2);
  await capture('02-second-offline-sale-queued');
  record('two offline sales persisted as distinct ordered UUIDv7 commands without creating local financial truth');

  assert.equal(await evaluate('navigator.onLine'), false, 'Browser unexpectedly regained network.');
  const adjustmentOperationId = randomUUID();
  await adminRequest(admin.cookie, '/v1/admin/inventory/adjustments', {
    method: 'POST',
    body: JSON.stringify({
      operationId: adjustmentOperationId,
      branchId: branch.id,
      reason: 'Gate 45 legitimate stock conflict proof during cashier outage',
      lines: [{ productId: seeded.productId, deltaQuantityScaled: '-10000' }],
    }),
  });
  const afterAdjustment = await inventoryRow(admin.cookie, branch.id, seeded.productId);
  assert.equal(afterAdjustment.quantityScaled, '1000');
  record('while Chrome remained offline, the real inventory authority reduced server stock 11→1 units');

  await setBrowserOffline(false);
  await waitFor(
    `fetch('/health', { cache: 'no-store' }).then((response) => response.ok).catch(() => false)`,
    'restored same-origin network reachability',
    20_000,
  ).catch(async () => {
    await waitFor(
      `fetch('/v1/auth/me', { credentials: 'same-origin', cache: 'no-store' }).then((response) => response.ok).catch(() => false)`,
      'restored authenticated network reachability',
      20_000,
    );
  });
  record('actual Chrome network connectivity was restored without replacing the browser profile or IndexedDB');

  await waitFor(
    `(async () => {
      const rows = await new Promise((resolve, reject) => {
        const open = indexedDB.open('korvi-pos-offline');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('transaction-queue-v1', 'readonly');
          const request = tx.objectStore('transaction-queue-v1').getAll();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => { resolve(request.result); db.close(); };
        };
      });
      const first = rows.find((row) => row.id === ${js(firstOperationId)});
      const second = rows.find((row) => row.id === ${js(secondOperationId)});
      return first?.state === 'settled' && second?.state === 'rejected';
    })()`,
    'offline queue reconciliation',
    35_000,
  );

  rows = await queueRows();
  const firstFinal = rows.find((row) => row.id === firstOperationId);
  const secondFinal = rows.find((row) => row.id === secondOperationId);
  assert.equal(firstFinal?.state, 'settled');
  assert.equal(secondFinal?.state, 'rejected');
  assert.equal(secondFinal?.rejectionReason, 'insufficient-stock');
  assert.equal(firstFinal?.attempts, 1);
  assert.equal(secondFinal?.attempts, 1);
  await waitForText('رفضها الخادم وتحتاج مراجعة', 20_000);
  assert.equal(
    await evaluate(`document.body?.innerText.includes('تمّت العملية') === true`),
    false,
    'Queued/rejected checkout must not be rendered as a completed authoritative sale.',
  );
  await capture('03-reconnected-needs-review');
  record('reconnect settled the oldest command once, then preserved the stock-conflicted command as needs-review');

  const finalBalance = await inventoryRow(admin.cookie, branch.id, seeded.productId);
  assert.equal(finalBalance.quantityScaled, '0');
  record('server inventory reconciled exactly: 11 initial −10 legitimate adjustment −1 accepted sale = 0 units');

  const operations = {
    commit: process.env.GITHUB_SHA ?? 'local',
    tenantId: admin.principal.tenant.id,
    branchId: branch.id,
    terminalId: terminal.id,
    productId: seeded.productId,
    firstOperationId,
    secondOperationId,
    adjustmentOperationId,
    initialQuantityScaled: seeded.quantityScaled,
    postAdjustmentQuantityScaled: afterAdjustment.quantityScaled,
    finalQuantityScaled: finalBalance.quantityScaled,
    firstQueueState: firstFinal.state,
    secondQueueState: secondFinal.state,
    secondRejectionReason: secondFinal.rejectionReason,
  };
  await writeFile(`${artifactDirectory}/operations.json`, `${JSON.stringify(operations, null, 2)}\n`, {
    mode: 0o600,
  });

  const proof = [
    `commit=${operations.commit}`,
    'actual_chrome_offline_checkout=PASS',
    'durable_two_command_queue=PASS',
    'legitimate_inventory_conflict=PASS',
    'reconnect_same_profile=PASS',
    'oldest_command_server_settled=PASS',
    'conflicted_command_needs_review=PASS',
    'no_local_financial_authority=PASS',
    'server_inventory_reconciled=PASS',
    `settled_operation_id=${firstOperationId}`,
    `rejected_operation_id=${secondOperationId}`,
    `rejection_reason=${secondFinal.rejectionReason}`,
    ...evidence.map((entry, index) => `evidence_${String(index + 1)}=${entry}`),
  ].join('\n');
  await writeFile(`${artifactDirectory}/proof.txt`, `${proof}\n`, { mode: 0o600 });
} finally {
  cdp.close();
}
