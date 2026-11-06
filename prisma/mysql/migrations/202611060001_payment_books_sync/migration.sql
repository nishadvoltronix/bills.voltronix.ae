-- Additive payment metadata and independent durable accounting outbox.
-- Existing payments remain without inferred dates, methods or account identities.
ALTER TABLE `Bill` ADD UNIQUE INDEX `Bill_id_companyId_key` (`id`,`companyId`);
ALTER TABLE `Payment`
 ADD COLUMN `paymentDate` DATE NULL,
 ADD COLUMN `paymentMode` VARCHAR(50) NULL,
 ADD COLUMN `paidThroughAccountId` VARCHAR(100) NULL,
 ADD UNIQUE INDEX `Payment_id_billId_key` (`id`,`billId`),
 ADD CONSTRAINT `Payment_metadata_complete` CHECK (
  (`paymentDate` IS NULL AND `paymentMode` IS NULL AND `paidThroughAccountId` IS NULL) OR
  (`paymentDate` IS NOT NULL AND `paymentMode` IS NOT NULL AND `paidThroughAccountId` IS NOT NULL AND
   CHAR_LENGTH(TRIM(`paymentMode`)) > 0 AND `paidThroughAccountId` REGEXP '^[0-9]{1,30}$')
 );
CREATE TABLE `PaymentBooksSync` (
 `id` VARCHAR(100) NOT NULL, `paymentId` VARCHAR(100) NOT NULL, `billId` VARCHAR(100) NOT NULL,
 `companyId` VARCHAR(100) NOT NULL, `initiatedById` VARCHAR(100) NOT NULL,
 `organizationId` VARCHAR(100) NOT NULL, `dataCenter` VARCHAR(2) NOT NULL, `environment` VARCHAR(10) NOT NULL,
 `status` VARCHAR(16) NOT NULL DEFAULT 'QUEUED', `snapshot` JSON NOT NULL, `sourceHash` CHAR(64) NOT NULL,
 `externalBillId` VARCHAR(100) NULL, `externalPaymentId` VARCHAR(100) NULL,
 `attempts` INTEGER NOT NULL DEFAULT 0, `submittedAt` DATETIME(3) NULL,
 `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `leaseToken` CHAR(64) NULL, `leaseUntil` DATETIME(3) NULL,
 `errorCode` VARCHAR(80) NULL, `lastError` VARCHAR(500) NULL, `completedAt` DATETIME(3) NULL,
 `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
 PRIMARY KEY (`id`), UNIQUE INDEX `PaymentBooksSync_paymentId_key` (`paymentId`),
 UNIQUE INDEX `PaymentBooksSync_paymentId_billId_key` (`paymentId`,`billId`),
 UNIQUE INDEX `PaymentBooksSync_external_destination_key` (`organizationId`,`dataCenter`,`environment`,`externalPaymentId`),
 INDEX `PaymentBooksSync_billId_companyId_idx` (`billId`,`companyId`),
 INDEX `PaymentBooksSync_status_nextAttemptAt_leaseUntil_idx` (`status`,`nextAttemptAt`,`leaseUntil`),
 INDEX `PaymentBooksSync_initiatedById_idx` (`initiatedById`),
 CONSTRAINT `PaymentBooksSync_payment_fkey` FOREIGN KEY (`paymentId`,`billId`) REFERENCES `Payment` (`id`,`billId`) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT `PaymentBooksSync_bill_company_fkey` FOREIGN KEY (`billId`,`companyId`) REFERENCES `Bill` (`id`,`companyId`) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT `PaymentBooksSync_initiatedById_fkey` FOREIGN KEY (`initiatedById`) REFERENCES `User` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT `PaymentBooksSync_status_check` CHECK (`status` IN ('QUEUED','PROCESSING','UNKNOWN','BLOCKED','FAILED','SYNCED')),
 CONSTRAINT `PaymentBooksSync_attempts_check` CHECK (`attempts` >= 0),
 CONSTRAINT `PaymentBooksSync_snapshot_check` CHECK (JSON_TYPE(`snapshot`) = 'OBJECT')
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
