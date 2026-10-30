-- Additive integration schema. No production records are modified.
CREATE TYPE "IntegrationJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'RETRY', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED');
CREATE TYPE "IntegrationOperation" AS ENUM ('CREATE_BILL', 'ATTACH_DOCUMENT', 'CREATE_EXPENSE');
ALTER TABLE "SyncRecord" ADD COLUMN "organizationId" TEXT, ADD COLUMN "lastSyncedAt" TIMESTAMP(3);
CREATE TABLE "IntegrationJob" (
  "id" TEXT NOT NULL, "billId" TEXT NOT NULL, "target" "SyncTarget" NOT NULL,
  "operation" "IntegrationOperation" NOT NULL, "status" "IntegrationJobStatus" NOT NULL DEFAULT 'QUEUED',
  "idempotencyKey" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "sourceVersion" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL, "payloadHash" TEXT NOT NULL, "externalId" TEXT, "documentId" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0, "reconciliationAttempts" INTEGER NOT NULL DEFAULT 0,
  "needsReconciliation" BOOLEAN NOT NULL DEFAULT false, "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT, "leaseUntil" TIMESTAMP(3), "lastAttemptAt" TIMESTAMP(3), "lastError" TEXT, "errorCode" TEXT,
  "completedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IntegrationJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IntegrationJob_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "IntegrationJob_attempts_nonnegative" CHECK ("attempts" >= 0 AND "reconciliationAttempts" >= 0),
  CONSTRAINT "IntegrationJob_sourceVersion_positive" CHECK ("sourceVersion" > 0)
);
CREATE UNIQUE INDEX "IntegrationJob_idempotencyKey_key" ON "IntegrationJob"("idempotencyKey");
CREATE INDEX "IntegrationJob_status_nextAttemptAt_leaseUntil_idx" ON "IntegrationJob"("status", "nextAttemptAt", "leaseUntil");
CREATE INDEX "IntegrationJob_billId_target_idx" ON "IntegrationJob"("billId", "target");
CREATE TABLE "IntegrationAttempt" (
  "id" TEXT NOT NULL, "jobId" TEXT NOT NULL, "operation" TEXT NOT NULL, "outcome" TEXT NOT NULL,
  "errorCode" TEXT, "safeError" TEXT, "externalId" TEXT, "startedAt" TIMESTAMP(3) NOT NULL,
  "finishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntegrationAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IntegrationAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "IntegrationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "IntegrationAttempt_jobId_startedAt_idx" ON "IntegrationAttempt"("jobId", "startedAt");
CREATE TABLE "IntegrationCredential" (
  "target" "SyncTarget" NOT NULL, "dataCenter" TEXT NOT NULL, "connectionFingerprint" TEXT NOT NULL, "refreshTokenEncrypted" TEXT NOT NULL,
  "accessTokenEncrypted" TEXT, "accessExpiresAt" TIMESTAMP(3), "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IntegrationCredential_pkey" PRIMARY KEY ("target")
);
CREATE TABLE "IntegrationOAuthState" (
  "tokenHash" TEXT NOT NULL, "target" "SyncTarget" NOT NULL, "userId" TEXT NOT NULL, "dataCenter" TEXT NOT NULL, "connectionFingerprint" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntegrationOAuthState_pkey" PRIMARY KEY ("tokenHash")
);
CREATE INDEX "IntegrationOAuthState_expiresAt_idx" ON "IntegrationOAuthState"("expiresAt");
