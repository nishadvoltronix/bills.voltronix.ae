-- Defaults preserve all existing companies and destinations as ineligible for live accounting.
ALTER TABLE `Company`
  ADD COLUMN `isDemo` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `liveAccountingEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT `Company_live_real_check` CHECK (NOT `liveAccountingEnabled` OR NOT `isDemo`);

ALTER TABLE `CompanyIntegrationDestination`
  ADD COLUMN `liveEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `verifiedAt` DATETIME(3) NULL,
  ADD COLUMN `verificationReference` VARCHAR(160) NULL,
  ADD COLUMN `verifiedConfigurationHash` CHAR(64) NULL,
  ADD CONSTRAINT `CompanyDestination_live_verified_check` CHECK (
    NOT `liveEnabled` OR (`target` = 'ZOHO' AND `environment` = 'production'
      AND `verifiedAt` IS NOT NULL AND `verificationReference` IS NOT NULL
      AND CHAR_LENGTH(TRIM(`verificationReference`)) > 0 AND `verifiedConfigurationHash` IS NOT NULL));

CREATE TABLE `LiveSyncAuthorization` (
  `id` VARCHAR(100) NOT NULL,
  `billId` VARCHAR(100) NOT NULL,
  `companyId` VARCHAR(100) NOT NULL,
  `actorId` VARCHAR(100) NOT NULL,
  `organizationId` VARCHAR(100) NOT NULL,
  `dataCenter` VARCHAR(2) NOT NULL,
  `sourceVersion` INTEGER NOT NULL,
  `challengeHash` CHAR(64) NOT NULL,
  `payloadHash` CHAR(64) NOT NULL,
  `configurationHash` CHAR(64) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `confirmedAt` DATETIME(3) NULL,
  `revokedAt` DATETIME(3) NULL,
  `canonicalJobId` VARCHAR(100) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `LiveSyncAuthorization_billId_key` (`billId`),
  UNIQUE INDEX `LiveSyncAuthorization_canonicalJobId_key` (`canonicalJobId`),
  INDEX `LiveSyncAuthorization_companyId_expiresAt_idx` (`companyId`, `expiresAt`),
  CONSTRAINT `LiveSyncAuthorization_version_check` CHECK (`sourceVersion` > 0),
  CONSTRAINT `LiveSyncAuthorization_dates_check` CHECK (`expiresAt` > `createdAt` AND (`confirmedAt` IS NULL OR `confirmedAt` < `expiresAt`)),
  CONSTRAINT `LiveSyncAuthorization_billId_fkey` FOREIGN KEY (`billId`) REFERENCES `Bill`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `LiveSyncAuthorization_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `LiveSyncAuthorization_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `LiveSyncAuthorization_canonicalJobId_fkey` FOREIGN KEY (`canonicalJobId`) REFERENCES `IntegrationJob`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin ENGINE=InnoDB;
