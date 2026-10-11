-- Korvi POS — repair the fiscalization RLS policy definitions without rewriting history.
--
-- The fiscalization authority migration created these policies bare. Korvi's migration
-- contract requires the latest definition of every policy identity to be replay-safe:
-- DROP IF EXISTS immediately followed by CREATE. This forward-only repair changes no
-- table, data, constraint, trigger, or fiscal fact.

BEGIN;

DROP POLICY IF EXISTS "zatca_seller_fiscal_profiles_isolation" ON "zatca_seller_fiscal_profiles";
CREATE POLICY "zatca_seller_fiscal_profiles_isolation" ON "zatca_seller_fiscal_profiles"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

DROP POLICY IF EXISTS "zatca_terminal_fiscal_chains_isolation" ON "zatca_terminal_fiscal_chains";
CREATE POLICY "zatca_terminal_fiscal_chains_isolation" ON "zatca_terminal_fiscal_chains"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

DROP POLICY IF EXISTS "zatca_invoice_fiscalizations_isolation" ON "zatca_invoice_fiscalizations";
CREATE POLICY "zatca_invoice_fiscalizations_isolation" ON "zatca_invoice_fiscalizations"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

COMMIT;
