-- Preserve legacy authorization without guessing its accounting organization.
ALTER TABLE "IntegrationCredential" ADD COLUMN "organizationId" TEXT;
UPDATE "IntegrationCredential" SET "organizationId" = '__legacy_unscoped__', "revokedAt" = COALESCE("revokedAt", CURRENT_TIMESTAMP);
ALTER TABLE "IntegrationCredential" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "IntegrationCredential" DROP CONSTRAINT "IntegrationCredential_pkey";
ALTER TABLE "IntegrationCredential" ADD CONSTRAINT "IntegrationCredential_pkey" PRIMARY KEY ("target", "organizationId");

ALTER TABLE "IntegrationOAuthState" ADD COLUMN "organizationId" TEXT;
UPDATE "IntegrationOAuthState" SET "organizationId" = '__legacy_unscoped__', "expiresAt" = LEAST("expiresAt", CURRENT_TIMESTAMP);
ALTER TABLE "IntegrationOAuthState" ALTER COLUMN "organizationId" SET NOT NULL;

CREATE TABLE "VendorBooksMapping" (
  "id" TEXT NOT NULL,
  "vendorId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "dataCenter" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "externalVendorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VendorBooksMapping_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VendorBooksMapping_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "VendorBooksMapping_numeric_ids" CHECK ("organizationId" ~ '^[0-9]{1,30}$' AND "externalVendorId" ~ '^[0-9]{1,30}$'),
  CONSTRAINT "VendorBooksMapping_environment" CHECK ("environment" IN ('sandbox', 'production')),
  CONSTRAINT "VendorBooksMapping_data_center" CHECK ("dataCenter" IN ('US', 'EU', 'IN', 'AU', 'JP', 'CA', 'CN', 'SA', 'AE'))
);
CREATE UNIQUE INDEX "VendorBooksMapping_vendor_destination_key" ON "VendorBooksMapping"("vendorId", "organizationId", "dataCenter", "environment");
CREATE UNIQUE INDEX "VendorBooksMapping_destination_external_key" ON "VendorBooksMapping"("organizationId", "dataCenter", "environment", "externalVendorId");
CREATE INDEX "VendorBooksMapping_organizationId_dataCenter_environment_idx" ON "VendorBooksMapping"("organizationId", "dataCenter", "environment");

-- Known organizations may legitimately use the same provider numeric record ID.
-- Keep legacy unscoped IDs unique; workers also refuse known-ID collisions with
-- unresolved legacy rows instead of silently assigning those rows to an org.
DROP INDEX "SyncRecord_target_externalId_key";
CREATE UNIQUE INDEX "SyncRecord_target_organizationId_externalId_key" ON "SyncRecord"("target", "organizationId", "externalId");
CREATE UNIQUE INDEX "SyncRecord_legacy_target_externalId_key" ON "SyncRecord"("target", "externalId") WHERE "organizationId" IS NULL AND "externalId" IS NOT NULL;
