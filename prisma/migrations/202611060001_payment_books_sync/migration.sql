ALTER TABLE "Payment" ADD COLUMN "paymentDate" DATE, ADD COLUMN "paymentMode" TEXT, ADD COLUMN "paidThroughAccountId" TEXT;
CREATE UNIQUE INDEX "Bill_id_companyId_key" ON "Bill"("id","companyId");
CREATE UNIQUE INDEX "Payment_id_billId_key" ON "Payment"("id","billId");
CREATE TABLE "PaymentBooksSync" (
 "id" TEXT PRIMARY KEY, "paymentId" TEXT NOT NULL UNIQUE, "billId" TEXT NOT NULL, "companyId" TEXT NOT NULL,
 "initiatedById" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
 "organizationId" TEXT NOT NULL, "dataCenter" TEXT NOT NULL, "environment" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'QUEUED', "snapshot" JSONB NOT NULL, "sourceHash" TEXT NOT NULL,
 "externalBillId" TEXT, "externalPaymentId" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0,
 "submittedAt" TIMESTAMP(3), "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "leaseToken" TEXT, "leaseUntil" TIMESTAMP(3), "errorCode" TEXT, "lastError" TEXT,
 "completedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 FOREIGN KEY ("paymentId","billId") REFERENCES "Payment"("id","billId") ON DELETE RESTRICT,
 FOREIGN KEY ("billId","companyId") REFERENCES "Bill"("id","companyId") ON DELETE RESTRICT,
 CONSTRAINT "PaymentBooksSync_status_check" CHECK ("status" IN ('QUEUED','PROCESSING','UNKNOWN','BLOCKED','FAILED','SYNCED')),
 CONSTRAINT "PaymentBooksSync_attempts_check" CHECK ("attempts" >= 0)
);
CREATE UNIQUE INDEX "PaymentBooksSync_external_destination_key" ON "PaymentBooksSync"("organizationId","dataCenter","environment","externalPaymentId");
CREATE UNIQUE INDEX "PaymentBooksSync_paymentId_billId_key" ON "PaymentBooksSync"("paymentId","billId");
CREATE INDEX "PaymentBooksSync_billId_companyId_idx" ON "PaymentBooksSync"("billId","companyId");
CREATE INDEX "PaymentBooksSync_status_nextAttemptAt_leaseUntil_idx" ON "PaymentBooksSync"("status","nextAttemptAt","leaseUntil");
CREATE INDEX "PaymentBooksSync_initiatedById_idx" ON "PaymentBooksSync"("initiatedById");
