import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const baseUrl = required('KORVI_PROVISIONING_API_URL').replace(/\/$/, '');
const appOrigin = required('KORVI_PROVISIONING_APP_ORIGIN');
const platformAccessKey = required('KORVI_PROVISIONING_PLATFORM_ACCESS_KEY');
const ownerPassword = required('KORVI_PROVISIONING_OWNER_PASSWORD');
const expectedPlatformActorRef = required('KORVI_PROVISIONING_PLATFORM_ACTOR_REF');
const artifactPath = resolve(
  process.env['KORVI_PROVISIONING_PROOF_PATH'] ?? 'artifacts/platform-provisioning/proof.json',
);

const nonce = randomUUID().replaceAll('-', '').slice(0, 16);
const tenantSlug = `e2e-${nonce}`;
const ownerEmail = `owner-${nonce}@korvi-e2e.invalid`;
const branchCode = `BR-${nonce.slice(0, 8)}`.toUpperCase();
const terminalCode = `POS-${nonce.slice(0, 8)}`.toUpperCase();
const sku = `E2E-${nonce}`.toUpperCase();
const operations = {
  tenant: randomUUID(),
  plan: randomUUID(),
  operational: randomUUID(),
  operationalInjection: randomUUID(),
  owner: randomUUID(),
  activate: randomUUID(),
  product: randomUUID(),
  shift: randomUUID(),
  sale: randomUUID(),
  suspendedOperational: randomUUID(),
  suspend: randomUUID(),
};

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`);
  return value;
}

function cookiePair(response, expectedName) {
  const raw = response.headers.get('set-cookie');
  assert.ok(raw, `expected ${expectedName} cookie`);
  const pair = raw.split(';', 1)[0];
  assert.ok(pair.startsWith(`${expectedName}=`), `expected ${expectedName} cookie`);
  return pair;
}

async function jsonOrNull(response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return null;
  return response.json();
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...((options.method ?? 'GET') === 'GET' ? {} : { origin: appOrigin }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(options.headers ?? {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const body = await jsonOrNull(response);
  return { response, body };
}

function errorCode(body) {
  return body !== null && typeof body === 'object' && typeof body.error === 'string'
    ? body.error
    : null;
}

function expectStatus(result, expected, label) {
  if (result.response.status !== expected) {
    const code = errorCode(result.body);
    throw new Error(
      `${label} returned HTTP ${String(result.response.status)}${code === null ? '' : ` (${code})`}`,
    );
  }
}

function objectBody(result, label) {
  assert.ok(result.body !== null && typeof result.body === 'object', `${label} returned JSON object`);
  return result.body;
}

function findAudit(items, eventType) {
  return items.find((item) => item !== null && typeof item === 'object' && item.eventType === eventType);
}

function assertPlatformAudit(items, eventType) {
  const event = findAudit(items, eventType);
  assert.ok(event, `audit contains ${eventType}`);
  assert.equal(event.actorUserId, null, `${eventType} must not impersonate a merchant user`);
  assert.ok(event.metadata !== null && typeof event.metadata === 'object', `${eventType} metadata exists`);
  assert.equal(
    event.metadata.controlPlaneActorRef,
    expectedPlatformActorRef,
    `${eventType} records the authenticated platform actor`,
  );
}

console.log(`[provisioning-e2e] start commit=${process.env['GITHUB_SHA'] ?? 'local'}`);

// 1. Independent platform realm.
const platformLogin = await request('/v1/platform/session', {
  method: 'POST',
  body: { accessKey: platformAccessKey },
});
expectStatus(platformLogin, 200, 'platform login');
const platformCookie = cookiePair(platformLogin.response, 'korvi_platform_session');

// 2. Create merchant identity/business facts from the supported Platform surface.
const tenantCreate = await request('/v1/platform/tenants', {
  method: 'POST',
  cookie: platformCookie,
  body: {
    operationId: operations.tenant,
    slug: tenantSlug,
    name: `Korvi E2E ${nonce}`,
    vatNumber: '310000000000003',
    vertical: 'grocery',
  },
});
expectStatus(tenantCreate, 201, 'tenant creation');
const tenant = objectBody(tenantCreate, 'tenant creation');
assert.equal(tenant.slug, tenantSlug);
assert.equal(tenant.status, 'provisioning');
assert.equal(tenant.created, true);
assert.equal(typeof tenant.id, 'string');
const tenantId = tenant.id;

// 3. Assign commercial plan/entitlements before trading admission.
const plan = await request(`/v1/platform/tenants/${tenantId}/plan`, {
  method: 'POST',
  cookie: platformCookie,
  body: {
    operationId: operations.plan,
    planKey: 'commercial-v1-e2e',
    planRevision: 1,
    accountState: 'active',
    entitlements: [
      { key: 'core.pos', kind: 'flag', enabled: true },
      { key: 'limits.branches', kind: 'limit', limit: '5' },
    ],
  },
});
expectStatus(plan, 200, 'plan assignment');
assert.equal(objectBody(plan, 'plan assignment').changed, true);

// 4. Prove request-body authority injection fails before business work.
const injection = await request(`/v1/platform/tenants/${tenantId}/operational-bootstrap`, {
  method: 'POST',
  cookie: platformCookie,
  body: {
    operationId: operations.operationalInjection,
    controlPlaneActorRef: 'platform:attacker',
    branch: { code: `${branchCode}-X`, nameAr: 'فرع حقن', nameEn: null },
    terminal: { code: `${terminalCode}-X`, label: 'نقطة حقن' },
  },
});
expectStatus(injection, 400, 'platform actor injection refusal');
assert.equal(errorCode(injection.body), 'invalid_body');

// 5. Create active branch + register atomically through Platform Admin authority.
const operationalPayload = {
  operationId: operations.operational,
  branch: { code: branchCode, nameAr: 'الفرع الرئيسي', nameEn: 'Main Branch' },
  terminal: { code: terminalCode, label: 'الكاشير الرئيسي' },
};
const operational = await request(`/v1/platform/tenants/${tenantId}/operational-bootstrap`, {
  method: 'POST',
  cookie: platformCookie,
  body: operationalPayload,
});
expectStatus(operational, 201, 'operational bootstrap');
const operationalResult = objectBody(operational, 'operational bootstrap');
assert.equal(operationalResult.replayed, false);
assert.equal(operationalResult.branch.isActive, true);
assert.equal(operationalResult.terminal.isActive, true);
assert.equal(operationalResult.terminal.branchId, operationalResult.branch.id);
const branchId = operationalResult.branch.id;
const terminalId = operationalResult.terminal.id;

// Exact replay must be the same logical result, not a duplicate.
const replay = await request(`/v1/platform/tenants/${tenantId}/operational-bootstrap`, {
  method: 'POST',
  cookie: platformCookie,
  body: operationalPayload,
});
expectStatus(replay, 200, 'operational bootstrap replay');
const replayResult = objectBody(replay, 'operational bootstrap replay');
assert.equal(replayResult.replayed, true);
assert.equal(replayResult.branch.id, branchId);
assert.equal(replayResult.terminal.id, terminalId);

// Same idempotency key with changed intent must conflict.
const conflict = await request(`/v1/platform/tenants/${tenantId}/operational-bootstrap`, {
  method: 'POST',
  cookie: platformCookie,
  body: {
    ...operationalPayload,
    terminal: { ...operationalPayload.terminal, label: 'تغيير غير مسموح تحت نفس العملية' },
  },
});
expectStatus(conflict, 409, 'operational bootstrap idempotency conflict');
assert.equal(errorCode(conflict.body), 'idempotency_conflict');

// 6. Issue the first-owner one-time capability. Keep it memory-only.
const ownerInvite = await request(`/v1/platform/tenants/${tenantId}/owner-bootstrap`, {
  method: 'POST',
  cookie: platformCookie,
  body: {
    operationId: operations.owner,
    email: ownerEmail,
    displayName: 'مالك تجربة كورفي',
  },
});
expectStatus(ownerInvite, 201, 'owner bootstrap issue');
assert.equal(ownerInvite.response.headers.get('cache-control'), 'no-store');
const invitation = objectBody(ownerInvite, 'owner bootstrap issue');
assert.equal(invitation.created, true);
assert.equal(invitation.tenantId, tenantId);
assert.equal(invitation.email, ownerEmail);
assert.equal(typeof invitation.capability, 'string');
const capability = invitation.capability;

// Replay re-derives the identical capability without persisting it.
const ownerReplay = await request(`/v1/platform/tenants/${tenantId}/owner-bootstrap`, {
  method: 'POST',
  cookie: platformCookie,
  body: {
    operationId: operations.owner,
    email: ownerEmail,
    displayName: 'مالك تجربة كورفي',
  },
});
expectStatus(ownerReplay, 200, 'owner bootstrap replay');
const invitationReplay = objectBody(ownerReplay, 'owner bootstrap replay');
assert.equal(invitationReplay.created, false);
assert.equal(invitationReplay.capability, capability);

// 7. Explicit lifecycle admission; owner bootstrap itself never activates a tenant.
const activation = await request(`/v1/platform/tenants/${tenantId}/activate`, {
  method: 'POST',
  cookie: platformCookie,
  body: { operationId: operations.activate },
});
expectStatus(activation, 200, 'tenant activation');
assert.equal(objectBody(activation, 'tenant activation').status, 'active');

// 8. Owner consumes capability once and chooses a temporary runtime credential.
const acceptance = await request('/v1/bootstrap/owner', {
  method: 'POST',
  body: { capability, password: ownerPassword },
});
expectStatus(acceptance, 201, 'owner bootstrap acceptance');
const acceptedOwner = objectBody(acceptance, 'owner bootstrap acceptance');
assert.equal(acceptedOwner.tenantId, tenantId);
assert.equal(acceptedOwner.email, ownerEmail);
assert.equal(typeof acceptedOwner.userId, 'string');
const ownerUserId = acceptedOwner.userId;

const consumedReplay = await request('/v1/bootstrap/owner', {
  method: 'POST',
  body: { capability, password: ownerPassword },
});
expectStatus(consumedReplay, 409, 'consumed owner capability refusal');

// 9. Merchant login is a different cookie/realm.
const merchantLogin = await request('/v1/auth/login', {
  method: 'POST',
  body: { tenantSlug, email: ownerEmail, password: ownerPassword },
});
expectStatus(merchantLogin, 200, 'merchant login');
const merchantCookie = cookiePair(merchantLogin.response, 'korvi_session');
const merchantPrincipal = objectBody(merchantLogin, 'merchant login');
assert.equal(merchantPrincipal.userId, ownerUserId);
assert.equal(merchantPrincipal.tenantId, tenantId);

// A merchant session never authenticates into Platform Admin.
const merchantPlatformAttempt = await request(`/v1/platform/tenants/${tenantId}`, {
  cookie: merchantCookie,
});
expectStatus(merchantPlatformAttempt, 401, 'merchant-to-platform escalation refusal');
assert.equal(errorCode(merchantPlatformAttempt.body), 'platform_unauthenticated');

// 10. Complete merchant-side branch binding through supported Merchant Admin.
const bindOwner = await request(`/v1/admin/members/${ownerUserId}`, {
  method: 'PATCH',
  cookie: merchantCookie,
  body: { defaultBranchId: branchId },
});
expectStatus(bindOwner, 200, 'owner branch binding');
const boundMember = objectBody(bindOwner, 'owner branch binding');
assert.equal(boundMember.defaultBranchId, branchId);

// The pre-binding session was minted with no branch. Re-login to derive current branch truth.
const merchantRelogin = await request('/v1/auth/login', {
  method: 'POST',
  body: { tenantSlug, email: ownerEmail, password: ownerPassword },
});
expectStatus(merchantRelogin, 200, 'merchant re-login after branch binding');
const merchantBranchCookie = cookiePair(merchantRelogin.response, 'korvi_session');
const branchPrincipal = objectBody(merchantRelogin, 'merchant re-login after branch binding');
assert.equal(branchPrincipal.branchId, branchId);

// Use a merchant-supported setting for this control-plane provisioning proof so the first sale
// does not invent stock. Inventory truth is proven independently by the stock/purchasing gates.
const settings = await request('/v1/admin/settings', {
  method: 'PATCH',
  cookie: merchantBranchCookie,
  body: { trackInventory: false },
});
expectStatus(settings, 200, 'merchant settings update');
assert.equal(objectBody(settings, 'merchant settings update').trackInventory, false);

// 11. Create the minimum sellable catalogue from the supported merchant product surface.
const productCreate = await request('/v1/admin/catalog/products', {
  method: 'POST',
  cookie: merchantBranchCookie,
  body: {
    operationId: operations.product,
    sku,
    barcode: `629${nonce.replace(/\D/g, '').padEnd(10, '0').slice(0, 10)}`.slice(0, 13),
    nameAr: 'منتج إثبات التجهيز',
    nameEn: 'Provisioning Proof Item',
    unit: 'unit',
    priceMinor: '1000',
    vatBasisPoints: 1500,
  },
});
expectStatus(productCreate, 201, 'catalog product creation');
const productResult = objectBody(productCreate, 'catalog product creation');
assert.equal(productResult.replayed, false);
assert.equal(typeof productResult.product?.id, 'string');
const productId = productResult.product.id;

// 12. Readiness is evidence-derived; no one writes an "onboarding complete" flag.
const readiness = await request('/v1/onboarding/readiness', { cookie: merchantBranchCookie });
expectStatus(readiness, 200, 'onboarding readiness');
const readinessBody = objectBody(readiness, 'onboarding readiness');
assert.equal(readinessBody.ready, true);

// 13. Cashier path: discover own-branch terminal, open shift, make real sale.
const terminals = await request('/v1/terminals', { cookie: merchantBranchCookie });
expectStatus(terminals, 200, 'terminal discovery');
const terminalBody = objectBody(terminals, 'terminal discovery');
assert.equal(terminalBody.branchId, branchId);
assert.ok(Array.isArray(terminalBody.terminals));
assert.ok(terminalBody.terminals.some((item) => item.id === terminalId));

const shiftOpen = await request('/v1/shifts/open', {
  method: 'POST',
  cookie: merchantBranchCookie,
  body: {
    operationId: operations.shift,
    terminalId,
    openingFloatMinor: '0',
  },
});
expectStatus(shiftOpen, 201, 'shift open');
const shift = objectBody(shiftOpen, 'shift open').shift;
assert.equal(shift.terminalId, terminalId);
assert.equal(shift.branchId, branchId);
assert.equal(shift.userId, ownerUserId);
const shiftId = shift.id;

const salePayload = {
  operationId: operations.sale,
  terminalId,
  expectedShiftId: shiftId,
  lines: [{ productId, quantityMilli: '1000' }],
  tenders: [{ method: 'cash', amountMinor: '1000' }],
};
const sale = await request('/v1/sales', {
  method: 'POST',
  cookie: merchantBranchCookie,
  body: salePayload,
});
expectStatus(sale, 201, 'cashier sale');
const saleResult = objectBody(sale, 'cashier sale');
assert.equal(saleResult.replayed, false);
assert.equal(saleResult.sale.totalMinor, '1000');
assert.equal(typeof saleResult.sale.id, 'string');
const saleId = saleResult.sale.id;

const saleReplay = await request('/v1/sales', {
  method: 'POST',
  cookie: merchantBranchCookie,
  body: salePayload,
});
expectStatus(saleReplay, 200, 'cashier sale replay');
const saleReplayResult = objectBody(saleReplay, 'cashier sale replay');
assert.equal(saleReplayResult.replayed, true);
assert.equal(saleReplayResult.sale.id, saleId);

// 14. Platform audit proves privileged actions record the Platform actor, not a merchant identity.
const audit = await request(`/v1/platform/tenants/${tenantId}/audit?limit=100`, {
  cookie: platformCookie,
});
expectStatus(audit, 200, 'platform audit read');
const auditBody = objectBody(audit, 'platform audit read');
assert.ok(Array.isArray(auditBody.items));
for (const eventType of [
  'tenant.provisioned',
  'commercial.plan-assigned',
  'platform.branch-provisioned',
  'platform.terminal-provisioned',
  'owner-bootstrap.invited',
  'tenant.activated',
]) {
  assertPlatformAudit(auditBody.items, eventType);
}

// 15. Suspended merchants cannot receive a new operational pair.
const suspension = await request(`/v1/platform/tenants/${tenantId}/suspend`, {
  method: 'POST',
  cookie: platformCookie,
  body: { operationId: operations.suspend, reason: 'e2e suspension refusal proof' },
});
expectStatus(suspension, 200, 'tenant suspension');
assert.equal(objectBody(suspension, 'tenant suspension').status, 'suspended');

const suspendedOperational = await request(`/v1/platform/tenants/${tenantId}/operational-bootstrap`, {
  method: 'POST',
  cookie: platformCookie,
  body: {
    operationId: operations.suspendedOperational,
    branch: { code: `${branchCode}-2`, nameAr: 'فرع مرفوض أثناء الإيقاف', nameEn: null },
    terminal: { code: `${terminalCode}-2`, label: 'نقطة مرفوضة أثناء الإيقاف' },
  },
});
expectStatus(suspendedOperational, 409, 'suspended tenant operational refusal');
assert.equal(errorCode(suspendedOperational.body), 'tenant_suspended');

const proof = {
  schema: 'korvi.platform-provisioning-e2e.v1',
  commit: process.env['GITHUB_SHA'] ?? 'local',
  generatedAt: new Date().toISOString(),
  tenantId,
  tenantSlug,
  ownerUserId,
  branchId,
  terminalId,
  productId,
  shiftId,
  saleId,
  assertions: {
    supportedPlatformTenantCreate: true,
    planAssigned: true,
    platformActorInjectionRefused: true,
    branchTerminalAtomicProvisioning: true,
    operationalReplayExact: true,
    changedIntentConflict: true,
    ownerOneTimeBootstrap: true,
    merchantRealmCannotReachPlatformRealm: true,
    merchantBranchBinding: true,
    onboardingReady: true,
    shiftOpened: true,
    saleCreated: true,
    saleReplayExact: true,
    platformAuditActorCorrect: true,
    suspendedTenantProvisioningRefused: true,
  },
};

await mkdir(dirname(artifactPath), { recursive: true });
await writeFile(artifactPath, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
console.log(`[provisioning-e2e] PASS tenant=${tenantId} sale=${saleId}`);
