-- Korvi POS — Platform control-plane tenant discovery.
--
-- The SaaS operator must be able to enumerate tenant identities without
-- disabling RLS or connecting as a BYPASSRLS role. This opens one SELECT-only
-- door on `tenants`, keyed by a transaction-local control-plane actor setting.
-- Every tenant-owned child table remains protected by the existing tenant
-- policy; platform detail reads establish that tenant's ordinary RLS context.
--
-- The application sets `app.control_plane_actor` only after platform-session
-- authentication. The setting is LOCAL to the transaction and therefore cannot
-- leak through the connection pool.

CREATE OR REPLACE FUNCTION current_control_plane_actor() RETURNS TEXT AS $$
  SELECT NULLIF(current_setting('app.control_plane_actor', TRUE), '');
$$ LANGUAGE SQL STABLE;

DROP POLICY IF EXISTS "tenants_control_plane_read" ON "tenants";
CREATE POLICY "tenants_control_plane_read" ON "tenants"
  FOR SELECT
  USING (current_control_plane_actor() IS NOT NULL);
