-- New isolated MySQL baseline. PostgreSQL migrations are retained unchanged.
-- MySQL DDL commits implicitly; never apply this to an existing PostgreSQL or production database.
-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(100) NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `role` ENUM('ADMIN', 'ACCOUNTS', 'DATA_ENTRY', 'MANAGEMENT') NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `User_email_key`(`email`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `Session` (
    `id` VARCHAR(100) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `userId` VARCHAR(100) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Session_tokenHash_key`(`tokenHash`),
    INDEX `Session_userId_idx`(`userId`),
    INDEX `Session_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `LoginAttempt` (
    `key` VARCHAR(64) NOT NULL,
    `count` INTEGER NOT NULL DEFAULT 0,
    `windowStart` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lockedUntil` DATETIME(3) NULL,

    PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `Vendor` (
    `companyId` VARCHAR(100) NOT NULL,
    `id` VARCHAR(100) NOT NULL,
    `name` VARCHAR(200) COLLATE utf8mb4_0900_as_ci NOT NULL,
    `email` VARCHAR(254) NULL,
    `trn` VARCHAR(40) NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'AED',
    `externalCrmId` VARCHAR(100) NULL,
    `externalZohoId` VARCHAR(100) NULL,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Vendor_name_idx`(`name`),
    INDEX `Vendor_companyId_idx`(`companyId`),
    UNIQUE INDEX `Vendor_id_companyId_key`(`id`, `companyId`),
    UNIQUE INDEX `Vendor_companyId_externalCrmId_key`(`companyId`, `externalCrmId`),
    UNIQUE INDEX `Vendor_companyId_externalZohoId_key`(`companyId`, `externalZohoId`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `VendorBooksMapping` (
    `id` VARCHAR(100) NOT NULL,
    `vendorId` VARCHAR(100) NOT NULL,
    `organizationId` VARCHAR(100) NOT NULL,
    `dataCenter` VARCHAR(2) NOT NULL,
    `environment` VARCHAR(10) NOT NULL,
    `externalVendorId` VARCHAR(100) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `VendorBooksMapping_organizationId_dataCenter_environment_idx`(`organizationId`, `dataCenter`, `environment`),
    UNIQUE INDEX `VendorBooksMapping_vendor_destination_key`(`vendorId`, `organizationId`, `dataCenter`, `environment`),
    UNIQUE INDEX `VendorBooksMapping_destination_external_key`(`organizationId`, `dataCenter`, `environment`, `externalVendorId`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `Job` (
    `companyId` VARCHAR(100) NOT NULL,
    `id` VARCHAR(100) NOT NULL,
    `jobNumber` VARCHAR(80) COLLATE utf8mb4_0900_as_ci NOT NULL,
    `name` VARCHAR(200) COLLATE utf8mb4_0900_as_ci NOT NULL,
    `customer` VARCHAR(200) COLLATE utf8mb4_0900_as_ci NOT NULL,
    `contractValue` DECIMAL(18, 2) NULL,
    `approvedVariations` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `currency` CHAR(3) NOT NULL DEFAULT 'AED',
    `externalCrmId` VARCHAR(100) NULL,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Job_name_idx`(`name`),
    INDEX `Job_companyId_idx`(`companyId`),
    UNIQUE INDEX `Job_id_companyId_key`(`id`, `companyId`),
    UNIQUE INDEX `Job_companyId_externalCrmId_key`(`companyId`, `externalCrmId`),
    UNIQUE INDEX `Job_companyId_jobNumber_key`(`companyId`, `jobNumber`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `Bill` (
    `companyId` VARCHAR(100) NOT NULL,
    `id` VARCHAR(100) NOT NULL,
    `vendorId` VARCHAR(100) NOT NULL,
    `jobId` VARCHAR(100) NOT NULL,
    `invoiceNumber` VARCHAR(120) COLLATE utf8mb4_0900_as_ci NOT NULL,
    `orderNumber` VARCHAR(120) NULL,
    `paymentTerms` ENUM('CUSTOM', 'DUE_ON_RECEIPT', 'NET_7', 'NET_15', 'NET_30', 'NET_45', 'NET_60') NOT NULL DEFAULT 'CUSTOM',
    `normalizedInvoiceNumber` VARCHAR(360) NOT NULL,
    `invoiceDate` DATE NOT NULL,
    `dueDate` DATE NULL,
    `category` VARCHAR(30) NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `description` TEXT NULL,
    `notes` TEXT NULL,
    `status` ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `subtotal` DECIMAL(18, 2) NOT NULL,
    `discount` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `vatRate` DECIMAL(5, 2) NOT NULL DEFAULT 0,
    `vatAmount` DECIMAL(18, 2) NOT NULL,
    `total` DECIMAL(18, 2) NOT NULL,
    `paidAmount` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdById` VARCHAR(100) NOT NULL,
    `approvedById` VARCHAR(100) NULL,
    `approvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Bill_companyId_status_invoiceDate_idx`(`companyId`, `status`, `invoiceDate`),
    INDEX `Bill_jobId_status_idx`(`jobId`, `status`),
    INDEX `Bill_createdById_idx`(`createdById`),
    INDEX `Bill_status_invoiceDate_idx`(`status`, `invoiceDate`),
    INDEX `Bill_invoiceDate_idx`(`invoiceDate`),
    UNIQUE INDEX `Bill_vendorId_normalizedInvoiceNumber_key`(`vendorId`, `normalizedInvoiceNumber`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `BillLine` (
    `id` VARCHAR(100) NOT NULL,
    `billId` VARCHAR(100) NOT NULL,
    `description` TEXT NOT NULL,
    `quantity` DECIMAL(14, 3) NOT NULL,
    `unitPrice` DECIMAL(18, 2) NOT NULL,
    `lineTotal` DECIMAL(18, 2) NOT NULL,

    INDEX `BillLine_billId_idx`(`billId`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `Payment` (
    `id` VARCHAR(100) NOT NULL,
    `billId` VARCHAR(100) NOT NULL,
    `amount` DECIMAL(18, 2) NOT NULL,
    `reference` VARCHAR(200) NOT NULL,
    `createdById` VARCHAR(100) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Payment_billId_idx`(`billId`),
    UNIQUE INDEX `Payment_billId_reference_key`(`billId`, `reference`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `Document` (
    `id` VARCHAR(100) NOT NULL,
    `billId` VARCHAR(100) NOT NULL,
    `storageKey` VARCHAR(100) NOT NULL,
    `fileName` VARCHAR(200) NOT NULL,
    `mimeType` VARCHAR(100) NOT NULL,
    `byteSize` INTEGER NOT NULL,
    `sha256` CHAR(64) NOT NULL,
    `uploadedById` VARCHAR(100) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Document_storageKey_key`(`storageKey`),
    INDEX `Document_billId_idx`(`billId`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `SyncRecord` (
    `id` VARCHAR(100) NOT NULL,
    `billId` VARCHAR(100) NOT NULL,
    `target` ENUM('ZOHO', 'CRM') NOT NULL,
    `status` ENUM('NOT_CONFIGURED', 'PENDING', 'SYNCED', 'FAILED', 'UNKNOWN') NOT NULL DEFAULT 'NOT_CONFIGURED',
    `externalId` VARCHAR(100) NULL,
    `lastError` TEXT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `organizationId` VARCHAR(100) NULL,
    `lastSyncedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SyncRecord_billId_target_key`(`billId`, `target`),
    UNIQUE INDEX `SyncRecord_target_organizationId_externalId_key`(`target`, `organizationId`, `externalId`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `IntegrationJob` (
    `id` VARCHAR(100) NOT NULL,
    `billId` VARCHAR(100) NOT NULL,
    `target` ENUM('ZOHO', 'CRM') NOT NULL,
    `operation` ENUM('CREATE_BILL', 'ATTACH_DOCUMENT', 'CREATE_EXPENSE') NOT NULL,
    `status` ENUM('QUEUED', 'PROCESSING', 'RETRY', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `idempotencyKey` VARCHAR(255) NOT NULL,
    `organizationId` VARCHAR(100) NOT NULL,
    `sourceVersion` INTEGER NOT NULL,
    `snapshot` JSON NOT NULL,
    `payloadHash` CHAR(64) NOT NULL,
    `externalId` VARCHAR(100) NULL,
    `documentId` VARCHAR(100) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `reconciliationAttempts` INTEGER NOT NULL DEFAULT 0,
    `needsReconciliation` BOOLEAN NOT NULL DEFAULT false,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `leaseToken` VARCHAR(100) NULL,
    `leaseUntil` DATETIME(3) NULL,
    `lastAttemptAt` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `errorCode` VARCHAR(100) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `IntegrationJob_idempotencyKey_key`(`idempotencyKey`),
    INDEX `IntegrationJob_status_nextAttemptAt_leaseUntil_idx`(`status`, `nextAttemptAt`, `leaseUntil`),
    INDEX `IntegrationJob_billId_target_idx`(`billId`, `target`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `IntegrationAttempt` (
    `id` VARCHAR(100) NOT NULL,
    `jobId` VARCHAR(100) NOT NULL,
    `operation` VARCHAR(100) NOT NULL,
    `outcome` VARCHAR(100) NOT NULL,
    `errorCode` VARCHAR(100) NULL,
    `safeError` TEXT NULL,
    `externalId` VARCHAR(100) NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `finishedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `IntegrationAttempt_jobId_startedAt_idx`(`jobId`, `startedAt`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `IntegrationCredential` (
    `target` ENUM('ZOHO', 'CRM') NOT NULL,
    `organizationId` VARCHAR(100) NOT NULL,
    `dataCenter` VARCHAR(2) NOT NULL,
    `connectionFingerprint` CHAR(64) NOT NULL,
    `refreshTokenEncrypted` LONGTEXT NOT NULL,
    `accessTokenEncrypted` LONGTEXT NULL,
    `accessExpiresAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`target`, `organizationId`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `IntegrationOAuthState` (
    `tokenHash` CHAR(64) NOT NULL,
    `target` ENUM('ZOHO', 'CRM') NOT NULL,
    `organizationId` VARCHAR(100) NOT NULL,
    `userId` VARCHAR(100) NOT NULL,
    `dataCenter` VARCHAR(2) NOT NULL,
    `connectionFingerprint` CHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `IntegrationOAuthState_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`tokenHash`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `AuditLog` (
    `companyId` VARCHAR(100) NULL,
    `id` VARCHAR(100) NOT NULL,
    `actorId` VARCHAR(100) NULL,
    `action` VARCHAR(100) NOT NULL,
    `entityType` VARCHAR(100) NOT NULL,
    `entityId` VARCHAR(100) NOT NULL,
    `details` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuditLog_companyId_createdAt_idx`(`companyId`, `createdAt`),
    INDEX `AuditLog_entityType_entityId_createdAt_idx`(`entityType`, `entityId`, `createdAt`),
    INDEX `AuditLog_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `OcrBatch` (
    `companyId` VARCHAR(100) NOT NULL,
    `id` VARCHAR(100) NOT NULL,
    `createdById` VARCHAR(100) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OcrBatch_companyId_createdById_createdAt_idx`(`companyId`, `createdById`, `createdAt`),
    INDEX `OcrBatch_createdById_createdAt_idx`(`createdById`, `createdAt`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `OcrDocument` (
    `id` VARCHAR(100) NOT NULL,
    `batchId` VARCHAR(100) NOT NULL,
    `status` ENUM('QUEUED', 'PROCESSING', 'REVIEW_REQUIRED', 'FAILED', 'POSTED') NOT NULL DEFAULT 'QUEUED',
    `storageKey` VARCHAR(100) NOT NULL,
    `fileName` VARCHAR(200) NOT NULL,
    `mimeType` VARCHAR(100) NOT NULL,
    `byteSize` INTEGER NOT NULL,
    `sha256` CHAR(64) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `pollCount` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `leaseUntil` DATETIME(3) NULL,
    `leaseToken` VARCHAR(100) NULL,
    `providerRequestId` VARCHAR(200) NULL,
    `extraction` JSON NULL,
    `verifiedInput` JSON NULL,
    `lastError` TEXT NULL,
    `failureCode` VARCHAR(100) NULL,
    `templateId` VARCHAR(100) NULL,
    `reviewedById` VARCHAR(100) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `billId` VARCHAR(100) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `OcrDocument_storageKey_key`(`storageKey`),
    UNIQUE INDEX `OcrDocument_billId_key`(`billId`),
    INDEX `OcrDocument_status_nextAttemptAt_leaseUntil_idx`(`status`, `nextAttemptAt`, `leaseUntil`),
    INDEX `OcrDocument_sha256_idx`(`sha256`),
    UNIQUE INDEX `OcrDocument_batchId_sha256_key`(`batchId`, `sha256`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `OcrTemplate` (
    `id` VARCHAR(100) NOT NULL,
    `vendorId` VARCHAR(100) NOT NULL,
    `version` INTEGER NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `mappings` JSON NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdById` VARCHAR(100) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OcrTemplate_vendorId_active_idx`(`vendorId`, `active`),
    UNIQUE INDEX `OcrTemplate_vendorId_version_key`(`vendorId`, `version`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `Company` (
    `id` VARCHAR(100) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `UserCompanyMembership` (
    `userId` VARCHAR(100) NOT NULL,
    `companyId` VARCHAR(100) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `UserCompanyMembership_companyId_active_idx`(`companyId`, `active`),
    PRIMARY KEY (`userId`, `companyId`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `CompanyIntegrationDestination` (
    `companyId` VARCHAR(100) NOT NULL,
    `target` ENUM('ZOHO', 'CRM') NOT NULL,
    `organizationId` VARCHAR(100) NOT NULL,
    `dataCenter` VARCHAR(2) NOT NULL,
    `environment` VARCHAR(10) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `CompanyIntegrationDestination_destination_key`(`target`, `organizationId`, `dataCenter`, `environment`),
    PRIMARY KEY (`companyId`, `target`, `organizationId`, `dataCenter`, `environment`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- CreateTable
CREATE TABLE `HubUserBinding` (
    `issuer` VARCHAR(191) NOT NULL,
    `subject` VARCHAR(191) NOT NULL,
    `billingUserId` VARCHAR(100) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `HubUserBinding_billingUserId_idx`(`billingUserId`),
    PRIMARY KEY (`issuer`, `subject`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

-- AddForeignKey
ALTER TABLE `Session` ADD CONSTRAINT `Session_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Vendor` ADD CONSTRAINT `Vendor_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `VendorBooksMapping` ADD CONSTRAINT `VendorBooksMapping_vendorId_fkey` FOREIGN KEY (`vendorId`) REFERENCES `Vendor`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Job` ADD CONSTRAINT `Job_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_vendorId_companyId_fkey` FOREIGN KEY (`vendorId`, `companyId`) REFERENCES `Vendor`(`id`, `companyId`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_jobId_companyId_fkey` FOREIGN KEY (`jobId`, `companyId`) REFERENCES `Job`(`id`, `companyId`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_approvedById_fkey` FOREIGN KEY (`approvedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `BillLine` ADD CONSTRAINT `BillLine_billId_fkey` FOREIGN KEY (`billId`) REFERENCES `Bill`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_billId_fkey` FOREIGN KEY (`billId`) REFERENCES `Bill`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Document` ADD CONSTRAINT `Document_billId_fkey` FOREIGN KEY (`billId`) REFERENCES `Bill`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Document` ADD CONSTRAINT `Document_uploadedById_fkey` FOREIGN KEY (`uploadedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `SyncRecord` ADD CONSTRAINT `SyncRecord_billId_fkey` FOREIGN KEY (`billId`) REFERENCES `Bill`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `IntegrationJob` ADD CONSTRAINT `IntegrationJob_billId_fkey` FOREIGN KEY (`billId`) REFERENCES `Bill`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `IntegrationAttempt` ADD CONSTRAINT `IntegrationAttempt_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `IntegrationJob`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `AuditLog` ADD CONSTRAINT `AuditLog_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `AuditLog` ADD CONSTRAINT `AuditLog_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `OcrBatch` ADD CONSTRAINT `OcrBatch_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `OcrBatch` ADD CONSTRAINT `OcrBatch_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `OcrDocument` ADD CONSTRAINT `OcrDocument_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `OcrBatch`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `OcrDocument` ADD CONSTRAINT `OcrDocument_reviewedById_fkey` FOREIGN KEY (`reviewedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `OcrDocument` ADD CONSTRAINT `OcrDocument_billId_fkey` FOREIGN KEY (`billId`) REFERENCES `Bill`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `OcrDocument` ADD CONSTRAINT `OcrDocument_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `OcrTemplate`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `OcrTemplate` ADD CONSTRAINT `OcrTemplate_vendorId_fkey` FOREIGN KEY (`vendorId`) REFERENCES `Vendor`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `OcrTemplate` ADD CONSTRAINT `OcrTemplate_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `UserCompanyMembership` ADD CONSTRAINT `UserCompanyMembership_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `UserCompanyMembership` ADD CONSTRAINT `UserCompanyMembership_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `CompanyIntegrationDestination` ADD CONSTRAINT `CompanyIntegrationDestination_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `HubUserBinding` ADD CONSTRAINT `HubUserBinding_billingUserId_fkey` FOREIGN KEY (`billingUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Preserve all PostgreSQL financial invariants under MySQL CHECK enforcement.

-- Defense in depth: financial invariants hold even outside the HTTP services.
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_amounts_valid` CHECK (
  `subtotal` >= 0 AND `discount` >= 0 AND `discount` <= `subtotal`
  AND `vatRate` >= 0 AND `vatRate` <= 100 AND `vatAmount` >= 0
  AND `total` > 0 AND `paidAmount` >= 0 AND `paidAmount` <= `total`
  AND `total` = `subtotal` - `discount` + `vatAmount`
  AND `vatAmount` = ROUND((`subtotal` - `discount`) * `vatRate` / 100, 2)
  AND `version` > 0
);
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_dates_valid` CHECK (`dueDate` IS NULL OR `dueDate` >= `invoiceDate`);
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_currency_supported` CHECK (`currency` IN ('AED', 'USD', 'EUR', 'GBP', 'SAR'));
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_approval_complete` CHECK (
  `status` <> 'APPROVED' OR (`approvedById` IS NOT NULL AND `approvedAt` IS NOT NULL AND `approvedById` <> `createdById`)
);
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_payments_only_approved` CHECK (`paidAmount` = 0 OR `status` = 'APPROVED');
ALTER TABLE `BillLine` ADD CONSTRAINT `BillLine_amounts_valid` CHECK (
  `quantity` > 0 AND `unitPrice` >= 0 AND `lineTotal` >= 0
  AND `lineTotal` = ROUND(`quantity` * `unitPrice`, 2)
);
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_amount_positive` CHECK (`amount` > 0);
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_reference_present` CHECK (LENGTH(TRIM(`reference`)) > 0);
ALTER TABLE `Job` ADD CONSTRAINT `Job_values_valid` CHECK (
  `contractValue` IS NULL OR (`contractValue` >= 0 AND `contractValue` + `approvedVariations` >= 0)
);
ALTER TABLE `Job` ADD CONSTRAINT `Job_currency_supported` CHECK (`currency` IN ('AED', 'USD', 'EUR', 'GBP', 'SAR'));
ALTER TABLE `Vendor` ADD CONSTRAINT `Vendor_currency_supported` CHECK (`currency` IN ('AED', 'USD', 'EUR', 'GBP', 'SAR'));
ALTER TABLE `Document` ADD CONSTRAINT `Document_size_positive` CHECK (`byteSize` > 0);
ALTER TABLE `SyncRecord` ADD CONSTRAINT `SyncRecord_attempts_valid` CHECK (`attempts` >= 0);
ALTER TABLE `SyncRecord` ADD CONSTRAINT `SyncRecord_confirmation_required` CHECK (`status` <> 'SYNCED' OR (`externalId` IS NOT NULL AND LENGTH(`externalId`) > 0));


ALTER TABLE `Bill` ADD CONSTRAINT `Bill_payment_terms_due_date` CHECK (
  `paymentTerms` = 'CUSTOM' OR (
    `dueDate` IS NOT NULL AND `dueDate` = DATE_ADD(`invoiceDate`, INTERVAL CASE `paymentTerms`
      WHEN 'DUE_ON_RECEIPT' THEN 0 WHEN 'NET_7' THEN 7 WHEN 'NET_15' THEN 15
      WHEN 'NET_30' THEN 30 WHEN 'NET_45' THEN 45 WHEN 'NET_60' THEN 60 ELSE 0
    END DAY)
  )
);

ALTER TABLE `OcrTemplate` ADD CONSTRAINT `OcrTemplate_version_positive` CHECK (`version` > 0);
ALTER TABLE `OcrDocument` ADD CONSTRAINT `OcrDocument_size_valid` CHECK (`byteSize` BETWEEN 8 AND 10485760);
ALTER TABLE `OcrDocument` ADD CONSTRAINT `OcrDocument_version_positive` CHECK (`version` > 0);
ALTER TABLE `OcrDocument` ADD CONSTRAINT `OcrDocument_posted_review_check` CHECK (`status` <> 'POSTED' OR (`billId` IS NOT NULL AND `reviewedById` IS NOT NULL AND `reviewedAt` IS NOT NULL AND `verifiedInput` IS NOT NULL));
ALTER TABLE `IntegrationJob` ADD CONSTRAINT `IntegrationJob_attempts_nonnegative` CHECK (`attempts` >= 0 AND `reconciliationAttempts` >= 0);
ALTER TABLE `IntegrationJob` ADD CONSTRAINT `IntegrationJob_sourceVersion_positive` CHECK (`sourceVersion` > 0);
ALTER TABLE `VendorBooksMapping` ADD CONSTRAINT `VendorBooksMapping_numeric_ids` CHECK (REGEXP_LIKE(`organizationId`, '^[0-9]{1,30}$', 'c') AND REGEXP_LIKE(`externalVendorId`, '^[0-9]{1,30}$', 'c'));
ALTER TABLE `VendorBooksMapping` ADD CONSTRAINT `VendorBooksMapping_environment` CHECK (`environment` IN ('sandbox', 'production'));
ALTER TABLE `VendorBooksMapping` ADD CONSTRAINT `VendorBooksMapping_data_center` CHECK (`dataCenter` IN ('US', 'EU', 'IN', 'AU', 'JP', 'CA', 'CN', 'SA', 'AE'));
ALTER TABLE `CompanyIntegrationDestination` ADD CONSTRAINT `CompanyIntegrationDestination_numeric_id` CHECK (REGEXP_LIKE(`organizationId`, '^[0-9]{1,30}$', 'c'));
ALTER TABLE `CompanyIntegrationDestination` ADD CONSTRAINT `CompanyIntegrationDestination_environment` CHECK (`environment` IN ('sandbox', 'production'));
ALTER TABLE `CompanyIntegrationDestination` ADD CONSTRAINT `CompanyIntegrationDestination_data_center` CHECK (`dataCenter` IN ('US', 'EU', 'IN', 'AU', 'JP', 'CA', 'CN', 'SA', 'AE'));

-- Nullable generated columns retain PostgreSQL partial-unique guarantees.
-- These generated implementation columns are deliberately absent from Prisma inputs.
ALTER TABLE `SyncRecord` ADD COLUMN `legacyExternalId` VARCHAR(100) GENERATED ALWAYS AS (CASE WHEN `organizationId` IS NULL THEN `externalId` ELSE NULL END) VIRTUAL;
CREATE UNIQUE INDEX `SyncRecord_legacy_target_externalId_key` ON `SyncRecord` (`target`, `legacyExternalId`);
ALTER TABLE `OcrTemplate` ADD COLUMN `activeVendorId` VARCHAR(100) GENERATED ALWAYS AS (CASE WHEN `active` = true THEN `vendorId` ELSE NULL END) VIRTUAL;
CREATE UNIQUE INDEX `OcrTemplate_one_active_vendor` ON `OcrTemplate` (`activeVendorId`);
