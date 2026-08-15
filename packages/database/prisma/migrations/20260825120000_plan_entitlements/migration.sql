
-- Korvi POS — Strike 4C: commercial plan and entitlement foundation.
--
-- Plan identity is `(planKey, planRevision)`. There is deliberately no global
-- plan catalogue and no payment-provider state in this migration: neither has
-- been commercially defined yet, so persisting one would turn a guess into
-- product truth.
--
-- Every assignment is immutable application history. The mutable account row
-- points at whichever assignment is current. A replay can therefore return the
-- exact historical result even after a later plan change.

BEGIN;

CREATE TABLE "tenant_plan_assignments" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "operationId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "planKey" TEXT NOT NULL,
  "planRevision" INTEGER NOT NULL,
  "accountState" TEXT NOT NULL,
  "controlPlaneActorRef" TEXT NOT NULL,
  "assignedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "tenant_plan_assignments_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "tenant_plan_assignments_operation_bounded"
    CHECK (
      "operationId" = btrim("operationId")
      AND char_length("operationId") BETWEEN 1 AND 120
    ),

  CONSTRAINT "tenant_plan_assignments_hash_shape"
    CHECK ("requestHash" ~ '^[A-Za-z0-9_-]{43}$'),

  CONSTRAINT "tenant_plan_assignments_plan_key_shape"
    CHECK (
      char_length("planKey") BETWEEN 1 AND 64
      AND "planKey" ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$'
    ),

  CONSTRAINT "tenant_plan_assignments_revision_positive"
    CHECK ("planRevision" >= 1),

  CONSTRAINT "tenant_plan_assignments_account_state_known"
    CHECK ("accountState" IN ('active', 'restricted')),

  CONSTRAINT "tenant_plan_assignments_actor_bounded"
    CHECK (
      "controlPlaneActorRef" = btrim("controlPlaneActorRef")
      AND char_length("controlPlaneActorRef") BETWEEN 1 AND 120
    )
);

CREATE UNIQUE INDEX "tenant_plan_assignments_tenantId_id_key"
  ON "tenant_plan_assignments"("tenantId", "id");

CREATE UNIQUE INDEX "tenant_plan_assignments_tenantId_operationId_key"
  ON "tenant_plan_assignments"("tenantId", "operationId");

CREATE INDEX "tenant_plan_assignments_tenantId_planKey_planRevision_idx"
  ON "tenant_plan_assignments"("tenantId", "planKey", "planRevision");

CREATE TABLE "tenant_plan_entitlements" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "assignmentId" UUID NOT NULL,
  "entitlementKey" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "flagValue" BOOLEAN,
  "limitValue" BIGINT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tenant_plan_entitlements_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "tenant_plan_entitlements_tenantId_assignmentId_fkey"
    FOREIGN KEY ("tenantId", "assignmentId")
    REFERENCES "tenant_plan_assignments"("tenantId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "tenant_plan_entitlements_key_shape"
    CHECK (
      char_length("entitlementKey") BETWEEN 1 AND 96
      AND "entitlementKey" ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$'
    ),

  CONSTRAINT "tenant_plan_entitlements_kind_known"
    CHECK ("kind" IN ('flag', 'limit')),

  CONSTRAINT "tenant_plan_entitlements_value_shape"
    CHECK (
      (
        "kind" = 'flag'
        AND "flagValue" IS NOT NULL
        AND "limitValue" IS NULL
      )
      OR
      (
        "kind" = 'limit'
        AND "flagValue" IS NULL
        AND "limitValue" IS NOT NULL
        AND "limitValue" >= 0
      )
    )
);

CREATE UNIQUE INDEX "tenant_plan_entitlements_assignment_entitlement_key"
  ON "tenant_plan_entitlements"("tenantId", "assignmentId", "entitlementKey");

CREATE INDEX "tenant_plan_entitlements_tenantId_assignmentId_idx"
  ON "tenant_plan_entitlements"("tenantId", "assignmentId");

CREATE TABLE "tenant_commercial_accounts" (
  "tenantId" UUID PRIMARY KEY,
  "currentAssignmentId" UUID NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "tenant_commercial_accounts_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "tenant_commercial_accounts_tenantId_currentAssignmentId_fkey"
    FOREIGN KEY ("tenantId", "currentAssignmentId")
    REFERENCES "tenant_plan_assignments"("tenantId", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE
);

-- All three tables are private merchant commercial data. They are not global
-- plan catalogue rows and are therefore inside the same RLS boundary as sales,
-- users and tenant settings (ADR-0004).

ALTER TABLE "tenant_plan_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_plan_assignments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_plan_assignments_isolation" ON "tenant_plan_assignments";
CREATE POLICY "tenant_plan_assignments_isolation" ON "tenant_plan_assignments"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "tenant_plan_entitlements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_plan_entitlements" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_plan_entitlements_isolation" ON "tenant_plan_entitlements";
CREATE POLICY "tenant_plan_entitlements_isolation" ON "tenant_plan_entitlements"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "tenant_commercial_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_commercial_accounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_commercial_accounts_isolation" ON "tenant_commercial_accounts";
CREATE POLICY "tenant_commercial_accounts_isolation" ON "tenant_commercial_accounts"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;
