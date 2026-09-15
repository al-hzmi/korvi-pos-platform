import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';

const phase = process.argv[2];
if (phase !== 'seed' && phase !== 'verify') {
  throw new Error('Usage: node scripts/gate42-indexeddb-proof.mjs <seed|verify>');
}

const baseUrl = process.env.KORVI_GATE42_BASE_URL ?? 'http://127.0.0.1:4173';
const chromePort = process.env.KORVI_GATE42_CHROME_PORT ?? '9223';
const artifactDirectory =
  process.env.KORVI_GATE42_ARTIFACT_DIR ?? 'artifacts/gate42-indexeddb-proof';

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

const target = await createTarget(baseUrl);
assert.equal(typeof target.webSocketDebuggerUrl, 'string');
const cdp = new CdpClient(target.webSocketDebuggerUrl);
await cdp.ready();
await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable')]);

async function evaluate(expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails !== undefined) {
    throw new Error(response.exceptionDetails.text ?? 'Browser evaluation failed.');
  }
  return response.result?.value;
}

async function waitForReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate('globalThis.gate42Proof?.ready === true')) return;
    } catch {
      // Navigation can replace the execution context between polls.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for Gate 42 browser harness.');
}

try {
  await waitForReady();
  const result = await evaluate(`globalThis.gate42Proof.${phase}()`);
  assert.equal(result.version, 1);
  assert.deepEqual([...result.stores].sort(), ['catalogue-v1', 'sale-drafts-v1']);
  assert.equal(result.tenantACount, 2);
  assert.equal(result.tenantBCount, 1);
  assert.equal(result.draftQuantity, '2000');

  if (phase === 'verify') {
    assert.equal(result.arabicSearchSku, 'MILK-1L');
    assert.equal(result.barcodeSearchSku, 'RICE-5KG');
    assert.equal(result.tenantIsolation, true);
    assert.equal(result.draftIsolation, true);
    assert.equal(result.corruptionRejected, true);

    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    assert.equal(typeof screenshot.data, 'string');
    await writeFile(
      `${artifactDirectory}/restart-persistence.png`,
      Buffer.from(screenshot.data, 'base64'),
    );
  }

  const lines = [
    `phase=${phase}=PASS`,
    `schema_version=${String(result.version)}`,
    `stores=${[...result.stores].sort().join(',')}`,
    `tenant_a_catalogue_count=${String(result.tenantACount)}`,
    `tenant_b_catalogue_count=${String(result.tenantBCount)}`,
    `sale_draft_quantity=${String(result.draftQuantity)}`,
  ];
  if (phase === 'verify') {
    lines.push(
      `arabic_search=${String(result.arabicSearchSku)}=PASS`,
      `barcode_search=${String(result.barcodeSearchSku)}=PASS`,
      'tenant_isolation=PASS',
      'draft_isolation=PASS',
      'corruption_rejection=PASS',
      'browser_restart_persistence=PASS',
    );
  }
  await appendFile(`${artifactDirectory}/proof.txt`, `${lines.join('\n')}\n`);
} finally {
  cdp.close();
}
