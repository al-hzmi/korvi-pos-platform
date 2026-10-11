-- Mastermind V2-3 — forward-only RLS policy recreation repair.
--
-- Migration history is immutable. The initial retail-packaging/price-list
-- migration created these tenant policies bare; the repository-wide SaaS
-- invariant requires the latest definition of every current policy identity to
-- be an explicit DROP IF EXISTS + CREATE pair.
BEGIN;

DROP POLICY IF EXISTS "product_packages_isolation" ON "product_packages";
CREATE POLICY "product_packages_isolation" ON "product_packages"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

DROP POLICY IF EXISTS "price_lists_isolation" ON "price_lists";
CREATE POLICY "price_lists_isolation" ON "price_lists"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

DROP POLICY IF EXISTS "price_list_entries_isolation" ON "price_list_entries";
CREATE POLICY "price_list_entries_isolation" ON "price_list_entries"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;
