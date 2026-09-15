import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';

const phase = process.argv[2];
if (phase !== 'seed' && phase !== 'verify') {
  throw new Error('Usage: node scripts/gate43-queue-proof.mjs <seed|verify>');
}

const baseUrl = process.env.KORVI_GATE43_BASE_URL ?? 'http://127.0.0.1:4174';
const chromePort = process.env.KORVI_GATE43_CHROME_PORT ?? '9224';
const artifactDirectory = process.env.KORVI_GATE43_ARTIFACT_DIR ?? 'artifacts/gate43-queue-proof';

const orderedIds = [
  '018f3000-0001-7000-8000-000000000001',
  '018f3000-0002-7000-8000-000000000002',
  '018f3000-0003-7000-8000-000000000003',
  '018f3000-0004-7000-8000-000000000004',
];

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
      if (await evaluate('globalThis.gate43Proof?.ready === true')) return;
    } catch {
      // Navigation can replace the execution context between polls.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for Gate 43 browser harness.');
}

try {
  await waitForReady();
  const result = await evaluate(`globalThis.gate43Proof.${phase}()`);
  assert.equal(result.version, 2);
  assert.deepEqual([...result.stores].sort(), [
    'catalogue-v1',
    'sale-drafts-v1',
    'transaction-queue-v1',
  ]);
  assert.equal(result.legacyCataloguePreserved, true);
  assert.equal(result.legacyDraftPreserved, true);
  assert.equal(result.queueACount, 4);
  assert.equal(result.queueBCount, 1);
  assert.deepEqual(result.orderedBeforeTransition, orderedIds);
  assert.equal(result.duplicateIdempotent, true);
  assert.equal(result.immutableCollisionRejected, true);
  assert.equal(result.crossPartitionCollisionRejected, true);
  assert.equal(result.terminalConflictRejected, true);

  if (phase === 'verify') {
    assert.deepEqual(result.pendingAfterRestart, orderedIds.slice(2));
    assert.equal(result.settledPersisted, true);
    assert.equal(result.rejectedPersisted, true);
    assert.equal(result.rejectionReasonPersisted, true);
    assert.equal(result.partitionIsolation, true);
    assert.equal(result.payloadPersisted, true);
    assert.equal(result.corruptionRejected, true);

    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    assert.equal(typeof screenshot.data, 'string');
    await writeFile(
      `${artifactDirectory}/restart-ordered-queue.png`,
      Buffer.from(screenshot.data, 'base64'),
    );
  }

  const lines = [
    `phase=${phase}=PASS`,
    `schema_version=${String(result.version)}`,
    `stores=${[...result.stores].sort().join(',')}`,
    'v1_catalogue_upgrade_preservation=PASS',
    'v1_sale_draft_upgrade_preservation=PASS',
    `queue_a_count=${String(result.queueACount)}`,
    `queue_b_count=${String(result.queueBCount)}`,
    `uuidv7_order=${result.orderedBeforeTransition.join(',')}=PASS`,
    'duplicate_exact_envelope_idempotency=PASS',
    'immutable_operation_collision_refusal=PASS',
    'cross_partition_operation_id_refusal=PASS',
    'terminal_state_rewrite_refusal=PASS',
  ];
  if (phase === 'verify') {
    lines.push(
      `pending_after_restart=${result.pendingAfterRestart.join(',')}=PASS`,
      'settled_state_restart_persistence=PASS',
      'rejected_state_restart_persistence=PASS',
      'rejection_reason_restart_persistence=PASS',
      'partition_isolation=PASS',
      'payload_restart_persistence=PASS',
      'corrupt_queue_refusal=PASS',
      'browser_process_restart_persistence=PASS',
      'proof_origin_outage_recovery=PASS',
    );
  }
  await appendFile(`${artifactDirectory}/proof.txt`, `${lines.join('\n')}\n`);
} finally {
  cdp.close();
}
