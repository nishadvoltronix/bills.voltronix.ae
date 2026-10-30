BEGIN;
CREATE TYPE "OcrStatus" AS ENUM ('QUEUED', 'PROCESSING', 'REVIEW_REQUIRED', 'FAILED', 'POSTED');
CREATE TABLE "OcrBatch" (
  "id" TEXT PRIMARY KEY, "createdById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OcrBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "OcrTemplate" (
  "id" TEXT PRIMARY KEY, "vendorId" TEXT NOT NULL, "version" INTEGER NOT NULL CHECK ("version" > 0), "name" TEXT NOT NULL,
  "mappings" JSONB NOT NULL, "active" BOOLEAN NOT NULL DEFAULT true, "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OcrTemplate_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OcrTemplate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "OcrDocument" (
  "id" TEXT PRIMARY KEY, "batchId" TEXT NOT NULL, "status" "OcrStatus" NOT NULL DEFAULT 'QUEUED',
  "storageKey" TEXT NOT NULL, "fileName" TEXT NOT NULL, "mimeType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL CHECK ("byteSize" BETWEEN 8 AND 10485760), "sha256" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0), "attempts" INTEGER NOT NULL DEFAULT 0,
  "pollCount" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3), "leaseToken" TEXT, "providerRequestId" TEXT, "extraction" JSONB, "verifiedInput" JSONB,
  "lastError" TEXT, "failureCode" TEXT, "templateId" TEXT, "reviewedById" TEXT, "reviewedAt" TIMESTAMP(3), "billId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OcrDocument_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "OcrBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OcrDocument_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OcrDocument_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "OcrTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OcrDocument_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OcrDocument_posted_review_check" CHECK ("status" <> 'POSTED' OR ("billId" IS NOT NULL AND "reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL AND "verifiedInput" IS NOT NULL))
);
CREATE INDEX "OcrBatch_createdById_createdAt_idx" ON "OcrBatch"("createdById", "createdAt");
CREATE UNIQUE INDEX "OcrTemplate_vendorId_version_key" ON "OcrTemplate"("vendorId", "version");
CREATE INDEX "OcrTemplate_vendorId_active_idx" ON "OcrTemplate"("vendorId", "active");
CREATE UNIQUE INDEX "OcrTemplate_one_active_vendor" ON "OcrTemplate"("vendorId") WHERE "active" = true;
CREATE UNIQUE INDEX "OcrDocument_storageKey_key" ON "OcrDocument"("storageKey");
CREATE UNIQUE INDEX "OcrDocument_billId_key" ON "OcrDocument"("billId");
CREATE UNIQUE INDEX "OcrDocument_batchId_sha256_key" ON "OcrDocument"("batchId", "sha256");
CREATE INDEX "OcrDocument_status_nextAttemptAt_leaseUntil_idx" ON "OcrDocument"("status", "nextAttemptAt", "leaseUntil");
CREATE INDEX "OcrDocument_sha256_idx" ON "OcrDocument"("sha256");
COMMIT;
