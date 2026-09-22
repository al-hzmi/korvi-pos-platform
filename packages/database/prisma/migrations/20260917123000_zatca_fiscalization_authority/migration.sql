-- Korvi POS — durable ZATCA fiscalization authority.
--
-- This migration owns the sequence facts that cannot live in checkout request
-- data: the per-EGS ICV, PIH, immutable seller fiscal snapshot and the exact
-- sealed XML/hash/QR/signature evidence. A terminal can have only one unsealed
-- reservation because invoice N's hash is invoice N+1's PIH.

BEGIN;

CREATE TABLE "zatca_seller_fiscal_profiles" (
  "tenantId" UUID PRIMARY KEY,
  "registrationName" TEXT NOT NULL,
  "vatRegistrationNumber" TEXT NOT NULL,
  "legalId" TEXT NOT NULL,
  "legalIdScheme" TEXT NOT NULL,
  "streetName" TEXT NOT NULL,
  "buildingNumber" TEXT NOT NULL,
  "citySubdivisionName" TEXT NOT NULL,
  "cityName" TEXT NOT NULL,
  "postalZone" TEXT NOT NULL,
  "countryCode" TEXT NOT NULL DEFAULT 'SA',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "zatca_seller_fiscal_profiles_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "zatca_seller_fiscal_profiles_vat_check"
    CHECK ("vatRegistrationNumber" ~ '^3[0-9]{13}3$'),
  CONSTRAINT "zatca_seller_fiscal_profiles_legal_id_check"
    CHECK ("legalId" ~ '^[A-Za-z0-9]+$'),
  CONSTRAINT "zatca_seller_fiscal_profiles_legal_scheme_check"
    CHECK ("legalIdScheme" IN ('CRN', 'MOM', 'MLS', '700', 'SAG', 'OTH')),
  CONSTRAINT "zatca_seller_fiscal_profiles_building_check"
    CHECK ("buildingNumber" ~ '^[0-9]{4}$'),
  CONSTRAINT "zatca_seller_fiscal_profiles_postal_check"
    CHECK ("postalZone" ~ '^[0-9]{5}$'),
  CONSTRAINT "zatca_seller_fiscal_profiles_country_check"
    CHECK ("countryCode" = 'SA'),
  CONSTRAINT "zatca_seller_fiscal_profiles_text_bounds_check"
    CHECK (
      char_length(btrim("registrationName")) BETWEEN 1 AND 500 AND
      char_length(btrim("streetName")) BETWEEN 1 AND 500 AND
      char_length(btrim("citySubdivisionName")) BETWEEN 1 AND 500 AND
      char_length(btrim("cityName")) BETWEEN 1 AND 500
    )
);

CREATE TABLE "zatca_terminal_fiscal_chains" (
  "tenantId" UUID NOT NULL,
  "terminalId" UUID NOT NULL,
  "nextIcv" BIGINT NOT NULL DEFAULT 1,
  "previousInvoiceHash" TEXT NOT NULL
    DEFAULT 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  PRIMARY KEY ("tenantId", "terminalId"),
  CONSTRAINT "zatca_terminal_fiscal_chains_terminal_fkey"
    FOREIGN KEY ("tenantId", "terminalId")
    REFERENCES "terminals"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "zatca_terminal_fiscal_chains_icv_check" CHECK ("nextIcv" > 0),
  CONSTRAINT "zatca_terminal_fiscal_chains_pih_check"
    CHECK (
      char_length("previousInvoiceHash") BETWEEN 4 AND 512 AND
      "previousInvoiceHash" ~ '^[A-Za-z0-9+/]+={0,2}$'
    )
);

CREATE TABLE "zatca_invoice_fiscalizations" (
  "tenantId" UUID NOT NULL,
  "invoiceId" UUID NOT NULL,
  "terminalId" UUID NOT NULL,
  "invoiceCounterValue" BIGINT NOT NULL,
  "previousInvoiceHash" TEXT NOT NULL,
  "sellerRegistrationName" TEXT NOT NULL,
  "sellerVatRegistrationNumber" TEXT NOT NULL,
  "sellerLegalId" TEXT NOT NULL,
  "sellerLegalIdScheme" TEXT NOT NULL,
  "sellerStreetName" TEXT NOT NULL,
  "sellerBuildingNumber" TEXT NOT NULL,
  "sellerCitySubdivisionName" TEXT NOT NULL,
  "sellerCityName" TEXT NOT NULL,
  "sellerPostalZone" TEXT NOT NULL,
  "sellerCountryCode" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'reserved',
  "invoiceHash" BYTEA,
  "sealedInvoiceXml" BYTEA,
  "qrCodeBase64" TEXT,
  "signatureValueBase64" TEXT,
  "reservedAt" TIMESTAMP(3) NOT NULL,
  "sealedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  PRIMARY KEY ("tenantId", "invoiceId"),
  CONSTRAINT "zatca_invoice_fiscalizations_invoice_fkey"
    FOREIGN KEY ("tenantId", "invoiceId")
    REFERENCES "invoices"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "zatca_invoice_fiscalizations_terminal_fkey"
    FOREIGN KEY ("tenantId", "terminalId")
    REFERENCES "terminals"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "zatca_invoice_fiscalizations_icv_check" CHECK ("invoiceCounterValue" > 0),
  CONSTRAINT "zatca_invoice_fiscalizations_pih_check"
    CHECK (
      char_length("previousInvoiceHash") BETWEEN 4 AND 512 AND
      "previousInvoiceHash" ~ '^[A-Za-z0-9+/]+={0,2}$'
    ),
  CONSTRAINT "zatca_invoice_fiscalizations_state_check" CHECK ("state" IN ('reserved', 'sealed')),
  CONSTRAINT "zatca_invoice_fiscalizations_hash_check"
    CHECK ("invoiceHash" IS NULL OR octet_length("invoiceHash") = 32),
  CONSTRAINT "zatca_invoice_fiscalizations_xml_check"
    CHECK ("sealedInvoiceXml" IS NULL OR octet_length("sealedInvoiceXml") BETWEEN 16 AND 3145728),
  CONSTRAINT "zatca_invoice_fiscalizations_state_shape_check"
    CHECK (
      (
        "state" = 'reserved' AND
        "invoiceHash" IS NULL AND "sealedInvoiceXml" IS NULL AND
        "qrCodeBase64" IS NULL AND "signatureValueBase64" IS NULL AND "sealedAt" IS NULL
      ) OR (
        "state" = 'sealed' AND
        octet_length("invoiceHash") = 32 AND
        octet_length("sealedInvoiceXml") BETWEEN 16 AND 3145728 AND
        char_length("qrCodeBase64") BETWEEN 4 AND 32768 AND
        char_length("signatureValueBase64") BETWEEN 4 AND 4096 AND
        "sealedAt" IS NOT NULL
      )
    ),
  CONSTRAINT "zatca_invoice_fiscalizations_time_check"
    CHECK (
      date_trunc('second', "reservedAt") = "reservedAt" AND
      ("sealedAt" IS NULL OR (
        date_trunc('second', "sealedAt") = "sealedAt" AND "sealedAt" >= "reservedAt"
      ))
    )
);

CREATE UNIQUE INDEX "zatca_invoice_fiscalizations_terminal_icv_key"
  ON "zatca_invoice_fiscalizations"("tenantId", "terminalId", "invoiceCounterValue");
CREATE UNIQUE INDEX "zatca_invoice_fiscalizations_one_reserved_per_terminal"
  ON "zatca_invoice_fiscalizations"("tenantId", "terminalId") WHERE "state" = 'reserved';
CREATE INDEX "zatca_invoice_fiscalizations_terminal_state_idx"
  ON "zatca_invoice_fiscalizations"("tenantId", "terminalId", "state", "reservedAt");

ALTER TABLE "zatca_seller_fiscal_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "zatca_seller_fiscal_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "zatca_seller_fiscal_profiles_isolation" ON "zatca_seller_fiscal_profiles"
  USING ("tenantId" = current_tenant_id()) WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "zatca_terminal_fiscal_chains" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "zatca_terminal_fiscal_chains" FORCE ROW LEVEL SECURITY;
CREATE POLICY "zatca_terminal_fiscal_chains_isolation" ON "zatca_terminal_fiscal_chains"
  USING ("tenantId" = current_tenant_id()) WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "zatca_invoice_fiscalizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "zatca_invoice_fiscalizations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "zatca_invoice_fiscalizations_isolation" ON "zatca_invoice_fiscalizations"
  USING ("tenantId" = current_tenant_id()) WITH CHECK ("tenantId" = current_tenant_id());

CREATE FUNCTION guard_zatca_invoice_fiscalization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invoice_type TEXT;
  sale_terminal_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ZATCA fiscalization evidence cannot be deleted' USING ERRCODE = '23514';
  END IF;

  SELECT i."invoiceType", s."terminalId"
    INTO invoice_type, sale_terminal_id
    FROM "invoices" i
    JOIN "sales" s ON s."tenantId" = i."tenantId" AND s."id" = i."saleId"
   WHERE i."tenantId" = NEW."tenantId" AND i."id" = NEW."invoiceId";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ZATCA fiscalization invoice authority is missing' USING ERRCODE = '23514';
  END IF;
  IF invoice_type <> 'simplified' THEN
    RAISE EXCEPTION 'This fiscalization authority only accepts simplified invoices' USING ERRCODE = '23514';
  END IF;
  IF sale_terminal_id <> NEW."terminalId" THEN
    RAISE EXCEPTION 'ZATCA fiscalization terminal must match the immutable sale terminal' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'reserved' THEN
      RAISE EXCEPTION 'ZATCA fiscalization must begin reserved' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."tenantId" IS DISTINCT FROM NEW."tenantId" OR
     OLD."invoiceId" IS DISTINCT FROM NEW."invoiceId" OR
     OLD."terminalId" IS DISTINCT FROM NEW."terminalId" OR
     OLD."invoiceCounterValue" IS DISTINCT FROM NEW."invoiceCounterValue" OR
     OLD."previousInvoiceHash" IS DISTINCT FROM NEW."previousInvoiceHash" OR
     OLD."sellerRegistrationName" IS DISTINCT FROM NEW."sellerRegistrationName" OR
     OLD."sellerVatRegistrationNumber" IS DISTINCT FROM NEW."sellerVatRegistrationNumber" OR
     OLD."sellerLegalId" IS DISTINCT FROM NEW."sellerLegalId" OR
     OLD."sellerLegalIdScheme" IS DISTINCT FROM NEW."sellerLegalIdScheme" OR
     OLD."sellerStreetName" IS DISTINCT FROM NEW."sellerStreetName" OR
     OLD."sellerBuildingNumber" IS DISTINCT FROM NEW."sellerBuildingNumber" OR
     OLD."sellerCitySubdivisionName" IS DISTINCT FROM NEW."sellerCitySubdivisionName" OR
     OLD."sellerCityName" IS DISTINCT FROM NEW."sellerCityName" OR
     OLD."sellerPostalZone" IS DISTINCT FROM NEW."sellerPostalZone" OR
     OLD."sellerCountryCode" IS DISTINCT FROM NEW."sellerCountryCode" OR
     OLD."reservedAt" IS DISTINCT FROM NEW."reservedAt" OR
     OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
    RAISE EXCEPTION 'ZATCA fiscalization immutable reservation cannot be changed' USING ERRCODE = '23514';
  END IF;

  IF NOT (OLD."state" = 'reserved' AND NEW."state" = 'sealed') THEN
    RAISE EXCEPTION 'illegal ZATCA fiscalization state transition: % -> %', OLD."state", NEW."state"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "zatca_invoice_fiscalization_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "zatca_invoice_fiscalizations"
FOR EACH ROW EXECUTE FUNCTION guard_zatca_invoice_fiscalization();

COMMIT;
