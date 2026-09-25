-- Mastermind V2-2 — make promotion RLS policy definitions replay-safe.
--
-- Migration history is append-only. The original authority migration created
-- these policies bare; this later repair establishes the repository-wide
-- contract that the latest definition of every policy first drops the old
-- identity and then recreates it with the same FORCE-RLS tenant predicate.

DROP POLICY IF EXISTS "promotions_isolation" ON "promotions";
CREATE POLICY "promotions_isolation" ON "promotions"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

DROP POLICY IF EXISTS "promotion_products_isolation" ON "promotion_products";
CREATE POLICY "promotion_products_isolation" ON "promotion_products"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

DROP POLICY IF EXISTS "coupons_isolation" ON "coupons";
CREATE POLICY "coupons_isolation" ON "coupons"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

DROP POLICY IF EXISTS "sale_promotion_applications_isolation" ON "sale_promotion_applications";
CREATE POLICY "sale_promotion_applications_isolation" ON "sale_promotion_applications"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

DROP POLICY IF EXISTS "sale_promotion_allocations_isolation" ON "sale_promotion_allocations";
CREATE POLICY "sale_promotion_allocations_isolation" ON "sale_promotion_allocations"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

DROP POLICY IF EXISTS "coupon_redemptions_isolation" ON "coupon_redemptions";
CREATE POLICY "coupon_redemptions_isolation" ON "coupon_redemptions"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());
