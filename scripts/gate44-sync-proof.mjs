import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';

const phase = process.argv[2];
if (phase !== 'seed' && phase !== 'verify') {
  throw new Error('Usage: node scripts/gate44-sync-proof.mjs <seed|verify>');
}

const baseUrl = process.env.KORVI_GATE44_BASE_URL ?? 'http://127.0.0.1:4175';
const chromePort = process.env.KORVI_GATE44_CHROME_PORT ?? '9225';
const artifactDirectory = process.env.KORVI_GATE44_ARTIFACT_DIR ?? 'artifacts/gate44-sync-proof';

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
  const response = await fetch(
    `http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
  );
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
      if (await evaluate('globalThis.gate44Proof?.ready === true')) return;
    } catch {
      // Navigation can replace the execution context between polls.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for Gate 44 browser harness.');
}

try {
  await waitForReady();
  const result = await evaluate(`globalThis.gate44Proof.${phase}()`);
  assert.equal(result.version, 3);

  const lines = [`phase=${phase}=PASS`, 'schema_version=3'];
  if (phase === 'seed') {
    assert.equal(result.migratedV2Rows, true);
    assert.deepEqual(result.initialOrder, [
      '018f4400-0001-7000-8000-000000000001',
      '018f4400-0002-7000-8000-000000000002',
    ]);
    assert.equal(result.concurrentSingleWinner, true);
    assert.equal(result.concurrentBlockedActiveLease, true);
    assert.equal(result.claimedId, '018f4400-0001-7000-8000-000000000001');
    assert.equal(result.claimedAttempts, 1);
    lines.push(
      'v2_to_v3_queue_migration=PASS',
      'uuidv7_oldest_first=PASS',
      'concurrent_claim_single_winner=PASS',
      'active_lease_blocks_parallel_worker=PASS',
      'claimed_operation_retained_for_process_crash=PASS',
    );
  } else {
    assert.equal(result.activeLeaseBlockedAfterRestart, true);
    assert.equal(result.reclaimedSameOperation, true);
    assert.equal(result.reclaimAttemptsIncremented, true);
    assert.equal(result.staleTokenRejected, true);
    assert.equal(result.retryDelayPersisted, true);
    assert.equal(result.noOvertakingBeforeRetry, true);
    assert.deepEqual(result.executionOrder, [
      '018f4400-0001-7000-8000-000000000001',
      '018f4400-0002-7000-8000-000000000002',
    ]);
    assert.equal(result.exactOncePerSuccessfulDrain, true);
    assert.equal(result.firstSettledRetained, true);
    assert.equal(result.secondSettledRetained, true);
    assert.equal(result.firstAttempts, 3);
    assert.equal(result.secondAttempts, 1);
    lines.push(
      'browser_process_restart_recovery=PASS',
      'pre_expiry_active_lease_block=PASS',
      'expired_lease_same_operation_reclaim=PASS',
      'durable_attempt_counter=PASS',
      'stale_fencing_token_refusal=PASS',
      'retry_schedule_restart_persistence=PASS',
      'retry_delay_prevents_overtaking=PASS',
      'ordered_ack_before_advance=PASS',
      'successful_drain_no_duplicate_execution=PASS',
      'terminal_rows_retained=PASS',
    );

    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    assert.equal(typeof screenshot.data, 'string');
    await writeFile(`${artifactDirectory}/restart-sync-engine.png`, Buffer.from(screenshot.data, 'base64'));
  }

  await appendFile(`${artifactDirectory}/proof.txt`, `${lines.join('\n')}\n`);
} finally {
  cdp.close();
}
