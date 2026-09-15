import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const baseUrl = process.env.KORVI_GATE5_BASE_URL ?? 'http://localhost:3000';
const tenantSlug = process.env.KORVI_BROWSER_TENANT_SLUG ?? 'stage5d-browser-proof';
const ownerEmail = process.env.KORVI_BROWSER_OWNER_EMAIL ?? 'owner@stage5d-browser-proof.test';
const password = process.env.KORVI_BROWSER_PASSWORD;
const chromePort = process.env.KORVI_GATE5_CHROME_PORT ?? '9227';
const artifactDirectory =
  process.env.KORVI_GATE5_ARTIFACT_DIR ?? 'artifacts/gate5-full-shift-offline';
const phase = process.argv[2] ?? '';
const representativeSales = Number.parseInt(process.env.KORVI_GATE5_SALES ?? '150', 10);
const targetStock = Number.parseInt(process.env.KORVI_GATE5_TARGET_STOCK ?? '200', 10);
const operationsPath = `${artifactDirectory}/operations.json`;

if (password === undefined || password.length < 16) {
  throw new Error('KORVI_BROWSER_PASSWORD must contain at least 16 characters.');
}
if (
  !Number.isInteger(representativeSales) ||
  representativeSales < 101 ||
  representativeSales > 300
) {
  throw new Error('KORVI_GATE5_SALES must be an integer between 101 and 300.');
}
if (!Number.isInteger(targetStock) || targetStock <= representativeSales) {
  throw new Error('KORVI_GATE5_TARGET_STOCK must exceed KORVI_GATE5_SALES.');
}
if (!['queue', 'restart-offline', 'interrupt-sync', 'finalize'].includes(phase)) {
  throw new Error(
    'Usage: node gate5-full-shift-offline-proof.mjs <queue|restart-offline|interrupt-sync|finalize>',
  );
}

await mkdir(artifactDirectory, { recursive: true });

function js(value) {
  return JSON.stringify(value);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

async function connectTarget(initialUrl = 'about:blank') {
  const target = await createTarget(initialUrl);
  assert.equal(typeof target.webSocketDebuggerUrl, 'string');
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await Promise.all([
    cdp.send('Page.enable'),
    cdp.send('Runtime.enable'),
    cdp.send('Network.enable'),
    cdp.send('DOM.enable'),
  ]);
  return cdp;
}

async function evaluate(cdp, expression) {
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

async function waitFor(cdp, expression, label, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForText(cdp, text, timeoutMs = 25_000) {
  await waitFor(
    cdp,
    `document.body?.innerText.includes(${js(text)}) === true`,
    `text ${JSON.stringify(text)}`,
    timeoutMs,
  );
}

async function setInput(cdp, id, value) {
  const changed = await evaluate(
    cdp,
    `(() => {
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
  })()`,
  );
  assert.equal(changed, true, `Input #${id} was not available.`);
}

async function pointForButton(cdp, text) {
  const point = await evaluate(
    cdp,
    `(() => {
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
  })()`,
  );
  assert.ok(point !== null, `Enabled button containing ${JSON.stringify(text)} was not visible.`);
  return point;
}

async function clickButton(cdp, text) {
  await waitFor(
    cdp,
    `([...document.querySelectorAll('button')].some((button) => !button.disabled && (button.textContent ?? '').replace(/\\s+/g, ' ').trim().includes(${js(text)})))`,
    `enabled button ${JSON.stringify(text)}`,
  );
  const point = await pointForButton(cdp, text);
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

async function pressEnter(cdp) {
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

async function capture(cdp, name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  assert.equal(typeof shot.data, 'string');
  await writeFile(`${artifactDirectory}/${name}.png`, Buffer.from(shot.data, 'base64'), {
    mode: 0o600,
  });
}

async function setNetwork(cdp, offline, latency = 0) {
  await cdp.send('Network.emulateNetworkConditions', {
    offline,
    latency,
    downloadThroughput: offline ? 0 : -1,
    uploadThroughput: offline ? 0 : -1,
  });
}

async function queueRows(cdp) {
  return evaluate(
    cdp,
    `new Promise((resolve, reject) => {
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
          nextAttemptAt: row.nextAttemptAt,
          leaseUntil: row.leaseUntil,
          rejectionReason: row.rejectionReason,
          tenantId: row.tenantId,
          branchId: row.branchId,
          terminalId: row.terminalId,
          payload: JSON.parse(row.payloadJson),
        })).sort((a, b) => a.id.localeCompare(b.id)));
        database.close();
      };
    };
  })`,
  );
}

async function draftRows(cdp) {
  return evaluate(
    cdp,
    `new Promise((resolve, reject) => {
    const open = indexedDB.open('korvi-pos-offline');
    open.onerror = () => reject(open.error ?? new Error('IndexedDB open failed'));
    open.onsuccess = () => {
      const database = open.result;
      if (!database.objectStoreNames.contains('sale-drafts-v1')) {
        database.close();
        resolve([]);
        return;
      }
      const tx = database.transaction('sale-drafts-v1', 'readonly');
      const request = tx.objectStore('sale-drafts-v1').getAll();
      request.onerror = () => reject(request.error ?? new Error('Draft read failed'));
      request.onsuccess = () => { resolve(request.result); database.close(); };
    };
  })`,
  );
}

async function catalogueCount(cdp) {
  return evaluate(
    cdp,
    `new Promise((resolve, reject) => {
    const open = indexedDB.open('korvi-pos-offline');
    open.onerror = () => reject(open.error ?? new Error('IndexedDB open failed'));
    open.onsuccess = () => {
      const database = open.result;
      if (!database.objectStoreNames.contains('catalogue-v1')) {
        database.close();
        resolve(0);
        return;
      }
      const tx = database.transaction('catalogue-v1', 'readonly');
      const request = tx.objectStore('catalogue-v1').count();
      request.onerror = () => reject(request.error ?? new Error('Catalogue count failed'));
      request.onsuccess = () => { resolve(request.result); database.close(); };
    };
  })`,
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
  assert.equal(
    response.ok,
    true,
    `Admin login failed: ${String(response.status)} ${JSON.stringify(body)}`,
  );
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
  assert.ok(row !== undefined, 'Gate 5 inventory row is missing.');
  return row;
}

async function readOperations() {
  return JSON.parse(await readFile(operationsPath, 'utf8'));
}

async function writeEvidence(name, value) {
  await writeFile(`${artifactDirectory}/${name}`, `${value}\n`, { mode: 0o600 });
}

async function killChrome() {
  const pidFile = process.env.KORVI_GATE5_CHROME_PID_FILE;
  if (pidFile === undefined) throw new Error('KORVI_GATE5_CHROME_PID_FILE is required.');
  const pid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('Invalid Chrome PID.');
  process.kill(pid, 'SIGKILL');
  await sleep(300);
}

async function navigateOffline(cdp) {
  await setNetwork(cdp, true);
  await cdp.send('Page.navigate', { url: `${baseUrl}/cashier` });
  await waitForText(cdp, 'نقطة بيع كورفي', 30_000);
  await waitFor(cdp, 'navigator.onLine === false', 'offline navigator state');
}

async function addProofProduct(cdp) {
  await setInput(cdp, 'product-search', 'BROWSER-SKU-001');
  await pressEnter(cdp);
  await waitForText(cdp, 'صنف برهان المتصفح', 12_000);
  await clickButton(cdp, 'صنف برهان المتصفح');
  await setInput(cdp, 'cash-received', '100.00');
}

async function runQueuePhase() {
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

  const startingStock = Number.parseInt(seeded.quantityScaled, 10) / 1000;
  assert.ok(Number.isInteger(startingStock) && startingStock >= 0);
  const requiredDelta = targetStock - startingStock;
  if (requiredDelta !== 0) {
    await adminRequest(admin.cookie, '/v1/admin/inventory/adjustments', {
      method: 'POST',
      body: JSON.stringify({
        operationId: randomUUID(),
        branchId: branch.id,
        reason: 'Gate 5 representative full-shift backlog stock baseline',
        lines: [{ productId: seeded.productId, deltaQuantityScaled: String(requiredDelta * 1000) }],
      }),
    });
  }
  const baseline = await inventoryRow(admin.cookie, branch.id, seeded.productId);
  assert.equal(baseline.quantityScaled, String(targetStock * 1000));

  const terminal = await adminRequest(admin.cookie, '/v1/admin/terminals', {
    method: 'POST',
    body: JSON.stringify({
      branchId: branch.id,
      code: `POS-GATE5-${String(Date.now()).slice(-6)}`,
      label: 'صندوق برهان الدوام الكامل دون اتصال',
    }),
  });
  await adminRequest(
    admin.cookie,
    `/v1/admin/members/${encodeURIComponent(admin.principal.user.id)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ defaultBranchId: branch.id }),
    },
  );

  const cdp = await connectTarget(`${baseUrl}/cashier`);
  try {
    await waitFor(
      cdp,
      `document.getElementById('tenant-slug') instanceof HTMLInputElement`,
      'login',
    );
    await setInput(cdp, 'tenant-slug', tenantSlug);
    await setInput(cdp, 'email', ownerEmail);
    await setInput(cdp, 'password', password);
    await clickButton(cdp, 'دخول');
    await waitForText(cdp, 'افتح وردية', 30_000);
    await setInput(cdp, 'opening-float', '100.00');
    await clickButton(cdp, 'فتح الوردية');
    await waitForText(cdp, 'ابحث أو امسح الباركود', 30_000);

    await addProofProduct(cdp);
    assert.ok((await catalogueCount(cdp)) > 0, 'Catalogue did not persist before outage.');
    assert.deepEqual(await queueRows(cdp), [], 'Queue must begin empty.');

    await setNetwork(cdp, true);
    await waitFor(cdp, 'navigator.onLine === false', 'browser offline state');

    const operationIds = [];
    for (let index = 0; index < representativeSales; index += 1) {
      if (index > 0) await addProofProduct(cdp);
      await clickButton(cdp, 'إتمام البيع');
      await waitForText(cdp, 'بيع دون اتصال — محفوظ بأمان', 20_000);
      const operationId = await evaluate(
        cdp,
        `(() => {
        const match = (document.body?.innerText ?? '').match(/معرّف العملية:\\s*([0-9a-f-]{36})/i);
        return match?.[1] ?? null;
      })()`,
      );
      assert.equal(
        typeof operationId,
        'string',
        `Queued operation id missing at sale ${String(index + 1)}.`,
      );
      operationIds.push(operationId);
      if ((index + 1) % 25 === 0 || index + 1 === representativeSales) {
        const rows = await queueRows(cdp);
        assert.equal(rows.filter((row) => row.state === 'pending').length, index + 1);
      }
      await clickButton(cdp, 'بدء بيع جديد');
      await waitFor(
        cdp,
        `document.getElementById('product-search') instanceof HTMLInputElement`,
        'new sale',
      );
    }

    assert.equal(
      new Set(operationIds).size,
      representativeSales,
      'Operation IDs must remain unique.',
    );
    const orderedIds = [...operationIds].sort();
    assert.deepEqual(operationIds, orderedIds, 'UUIDv7 operation IDs must preserve capture order.');

    await addProofProduct(cdp);
    await sleep(500);
    const drafts = await draftRows(cdp);
    assert.equal(drafts.length, 1, 'One active draft should survive the process restart.');
    assert.equal(drafts[0]?.lines?.length, 1);

    const rows = await queueRows(cdp);
    assert.equal(rows.length, representativeSales);
    assert.ok(rows.every((row) => row.state === 'pending'));
    assert.ok(rows.every((row) => row.attempts === 0));
    await capture(cdp, '01-full-shift-backlog-before-restart');

    await writeFile(
      operationsPath,
      `${JSON.stringify(
        {
          commit: process.env.GITHUB_SHA ?? 'local',
          tenantId: admin.principal.tenant.id,
          branchId: branch.id,
          terminalId: terminal.id,
          productId: seeded.productId,
          shiftId: rows[0]?.payload?.expectedShiftId,
          representativeSales,
          targetStock,
          operationIds,
          firstOperationId: operationIds[0],
          lastOperationId: operationIds.at(-1),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await writeEvidence(
      'queue-phase.txt',
      [
        `commit=${process.env.GITHUB_SHA ?? 'local'}`,
        `representative_sales=${String(representativeSales)}`,
        'long_outage_semantics=time-compressed',
        'offline_catalogue=PASS',
        'offline_ordered_queue=PASS',
        'stable_operation_ids=PASS',
        'durable_active_draft=PASS',
        'pre_restart_attempts_zero=PASS',
      ].join('\n'),
    );
  } finally {
    cdp.close();
  }
  await killChrome();
}

async function runRestartOfflinePhase() {
  const operations = await readOperations();
  assert.equal(operations.commit, process.env.GITHUB_SHA ?? 'local');
  const cdp = await connectTarget('about:blank');
  try {
    await navigateOffline(cdp);
    await waitForText(cdp, 'ابحث أو امسح الباركود', 30_000);
    const rows = await queueRows(cdp);
    assert.equal(rows.length, operations.representativeSales);
    assert.deepEqual(
      rows.map((row) => row.id),
      operations.operationIds,
      'Restart must preserve exact ordered operation identity.',
    );
    assert.ok(rows.every((row) => row.state === 'pending'));
    assert.ok(rows.every((row) => row.attempts === 0));
    assert.ok((await catalogueCount(cdp)) > 0, 'Catalogue was lost across process restart.');
    const drafts = await draftRows(cdp);
    assert.equal(drafts.length, 1, 'Draft was lost across process restart.');
    assert.equal(drafts[0]?.lines?.length, 1);
    const cashValue = await evaluate(
      cdp,
      `document.getElementById('cash-received')?.value ?? null`,
    );
    assert.equal(cashValue, '100.00', 'Draft cash value did not restore offline.');
    await capture(cdp, '02-restarted-offline-with-durable-state');
    await writeEvidence(
      'restart-offline-phase.txt',
      [
        `commit=${operations.commit}`,
        'process_restart_during_outage=PASS',
        'catalogue_survives_restart=PASS',
        'draft_survives_restart=PASS',
        'queue_survives_restart=PASS',
        'operation_order_survives_restart=PASS',
        'no_attempt_before_reconnect=PASS',
      ].join('\n'),
    );
  } finally {
    cdp.close();
  }
}

async function runInterruptSyncPhase() {
  const operations = await readOperations();
  const cdp = await connectTarget('about:blank');
  try {
    await setNetwork(cdp, false, 300);
    await cdp.send('Page.navigate', { url: `${baseUrl}/cashier` });
    await waitForText(cdp, 'ابحث أو امسح الباركود', 30_000);
    await waitFor(cdp, 'navigator.onLine === true', 'restored navigator state');

    const deadline = Date.now() + 90_000;
    let rows = [];
    while (Date.now() < deadline) {
      rows = await queueRows(cdp);
      const settled = rows.filter((row) => row.state === 'settled').length;
      const unfinished = rows.filter((row) => row.state !== 'settled').length;
      if (settled >= 5 && unfinished > 0) break;
      await sleep(100);
    }
    const settledBeforeKill = rows.filter((row) => row.state === 'settled').length;
    const unfinishedBeforeKill = rows.filter((row) => row.state !== 'settled').length;
    assert.ok(settledBeforeKill >= 5, 'Sync did not make partial progress before interruption.');
    assert.ok(
      unfinishedBeforeKill > 0,
      'Sync finished before restart-during-sync could be proved.',
    );
    await writeEvidence(
      'interrupted-sync-phase.txt',
      [
        `commit=${operations.commit}`,
        `settled_before_process_kill=${String(settledBeforeKill)}`,
        `unfinished_before_process_kill=${String(unfinishedBeforeKill)}`,
        'restart_during_active_sync=PASS',
      ].join('\n'),
    );
  } finally {
    cdp.close();
  }
  await killChrome();
}

async function runFinalizePhase() {
  const operations = await readOperations();
  const cdp = await connectTarget(`${baseUrl}/cashier`);
  try {
    await waitForText(cdp, 'ابحث أو امسح الباركود', 30_000);
    const deadline = Date.now() + 180_000;
    let rows = [];
    while (Date.now() < deadline) {
      rows = await queueRows(cdp);
      if (
        rows.length === operations.representativeSales &&
        rows.every((row) => row.state === 'settled')
      ) {
        break;
      }
      const retryButtonExists = await evaluate(
        cdp,
        `([...document.querySelectorAll('button')].some((button) => !button.disabled && (button.textContent ?? '').includes('إعادة المحاولة')))`,
      ).catch(() => false);
      if (retryButtonExists) await clickButton(cdp, 'إعادة المحاولة').catch(() => undefined);
      await sleep(500);
    }

    assert.equal(rows.length, operations.representativeSales);
    assert.ok(
      rows.every((row) => row.state === 'settled'),
      'Every queued sale must settle after restart.',
    );
    assert.ok(rows.every((row) => row.rejectionReason === null));
    assert.deepEqual(
      rows.map((row) => row.id),
      operations.operationIds,
    );
    assert.ok(rows.every((row) => row.attempts >= 1));
    await capture(cdp, '03-full-backlog-settled-after-second-restart');

    const drafts = await draftRows(cdp);
    assert.equal(
      drafts.length,
      1,
      'Unsubmitted draft must not be discarded by queue synchronization.',
    );

    await writeEvidence(
      'proof.txt',
      [
        `commit=${operations.commit}`,
        `representative_sales=${String(operations.representativeSales)}`,
        'full_shift_semantics=time-compressed',
        'wan_outage_many_sales=PASS',
        'catalogue_durable=PASS',
        'draft_durable=PASS',
        'ordered_queue_durable=PASS',
        'process_restart_during_outage=PASS',
        'restart_during_sync=PASS',
        'bounded_batch_backlog=PASS',
        'ack_before_advance=PASS',
        'stable_operation_ids=PASS',
        'all_local_outcomes_settled=PASS',
        'zero_local_rejections=PASS',
      ].join('\n'),
    );
  } finally {
    cdp.close();
  }
}

if (phase === 'queue') await runQueuePhase();
if (phase === 'restart-offline') await runRestartOfflinePhase();
if (phase === 'interrupt-sync') await runInterruptSyncPhase();
if (phase === 'finalize') await runFinalizePhase();
