import assert from 'node:assert/strict';

import {
  acceptOwnerBootstrap,
  activateTenant,
  createPrismaClient,
  issueOwnerBootstrapInvitation,
  provisionPermissionCatalogue,
  provisionTenant,
} from '../packages/database/dist/src/index.js';
import { hashPassword } from '../apps/api/dist/auth/password.js';

const databaseUrl = process.env.DATABASE_URL;
const signingKey = process.env.BOOTSTRAP_SIGNING_KEY;
const password = process.env.KORVI_BROWSER_PASSWORD;
const tenantSlug = process.env.KORVI_BROWSER_TENANT_SLUG ?? 'stage5d-browser-proof';
const ownerEmail = process.env.KORVI_BROWSER_OWNER_EMAIL ?? 'owner@stage5d-browser-proof.test';

if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error('DATABASE_URL is required.');
}
if (signingKey === undefined || signingKey.length < 32) {
  throw new Error('BOOTSTRAP_SIGNING_KEY must contain at least 32 characters.');
}
if (password === undefined || password.length < 16) {
  throw new Error('KORVI_BROWSER_PASSWORD must contain at least 16 characters.');
}

const TEST_SCRYPT = { N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16 };
const CONTROL_PLANE_ACTOR = 'github-actions-stage5d-browser-proof';

const prisma = createPrismaClient(databaseUrl);
try {
  const permissionCount = await provisionPermissionCatalogue(prisma);
  assert.ok(permissionCount > 0, 'Permission catalogue must not be empty.');

  const tenant = await provisionTenant(prisma, {
    operationId: 'stage5d-browser-provision-v1',
    slug: tenantSlug,
    name: 'متجر برهان المتصفح',
    vatNumber: null,
    vertical: 'retail',
    controlPlaneActorRef: CONTROL_PLANE_ACTOR,
  });
  assert.equal(tenant.created, true, 'Browser proof requires a fresh synthetic tenant.');

  const activation = await activateTenant(prisma, {
    tenantId: tenant.id,
    operationId: 'stage5d-browser-activate-v1',
    controlPlaneActorRef: CONTROL_PLANE_ACTOR,
  });
  assert.equal(activation.changed, true, 'Synthetic tenant was not activated.');
  assert.equal(activation.status, 'active');

  const invitation = await issueOwnerBootstrapInvitation(prisma, signingKey, {
    tenantId: tenant.id,
    operationId: 'stage5d-browser-owner-invite-v1',
    email: ownerEmail,
    displayName: 'مالك برهان المتصفح',
    controlPlaneActorRef: CONTROL_PLANE_ACTOR,
  });
  assert.equal(
    invitation.created,
    true,
    'Fresh synthetic tenant unexpectedly replayed owner invite.',
  );

  const accepted = await acceptOwnerBootstrap(
    prisma,
    signingKey,
    invitation.capability,
    (secret) => hashPassword(secret, TEST_SCRYPT),
    password,
  );
  assert.equal(accepted.tenantId, tenant.id);
  assert.equal(accepted.email, ownerEmail);

  console.log(
    `[ok] synthetic Stage 5D merchant provisioned through Korvi authorities: ${tenant.id}`,
  );
} finally {
  await prisma.$disconnect();
}
