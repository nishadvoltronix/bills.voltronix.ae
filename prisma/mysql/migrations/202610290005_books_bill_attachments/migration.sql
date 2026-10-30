-- Original source attachments are independent of native financial documents and queues.
ALTER TABLE `BooksBill` ADD UNIQUE INDEX `BooksBill_attachment_scope_key` (`id`, `companyId`, `organizationId`, `dataCenter`, `environment`);

CREATE TABLE `BooksBillAttachment` (
  `id` VARCHAR(100) NOT NULL,
  `billId` VARCHAR(100) NOT NULL,
  `companyId` VARCHAR(100) NOT NULL,
  `organizationId` VARCHAR(100) NOT NULL,
  `dataCenter` VARCHAR(2) NOT NULL,
  `environment` VARCHAR(10) NOT NULL,
  `externalDocumentId` VARCHAR(100) NOT NULL,
  `sourceMetadata` JSON NOT NULL,
  `sourceMetadataHash` CHAR(64) NOT NULL,
  `storageKey` VARCHAR(100) NOT NULL,
  `fileName` VARCHAR(200) NOT NULL,
  `mimeType` VARCHAR(100) NOT NULL,
  `byteSize` INTEGER NOT NULL,
  `sha256` CHAR(64) NOT NULL,
  `downloadedAt` DATETIME(3) NOT NULL,
  `importedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `BooksBillAttachment_billId_externalDocumentId_key` (`billId`, `externalDocumentId`),
  UNIQUE INDEX `BooksBillAttachment_storageKey_key` (`storageKey`),
  INDEX `BooksBillAttachment_scope_idx` (`billId`, `companyId`, `organizationId`, `dataCenter`, `environment`),
  INDEX `BooksBillAttachment_companyId_downloadedAt_idx` (`companyId`, `downloadedAt`),
  CONSTRAINT `BooksBillAttachment_scope_fkey` FOREIGN KEY (`billId`, `companyId`, `organizationId`, `dataCenter`, `environment`) REFERENCES `BooksBill` (`id`, `companyId`, `organizationId`, `dataCenter`, `environment`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `BooksBillAttachment_bytes_check` CHECK (`byteSize` >= 8 AND `byteSize` <= 10485760),
  CONSTRAINT `BooksBillAttachment_type_check` CHECK (`mimeType` IN ('application/pdf', 'image/jpeg', 'image/png'))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
