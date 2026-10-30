-- Additive scanner intake only. Existing OCR/financial tables and records are retained.
CREATE TABLE `ScannerSource` (
  `id` VARCHAR(100) NOT NULL,
  `companyId` VARCHAR(100) NOT NULL,
  `uploadedById` VARCHAR(100) NOT NULL,
  `name` VARCHAR(200) COLLATE utf8mb4_0900_as_ci NOT NULL,
  `active` BOOLEAN NOT NULL DEFAULT false,
  `tokenHash` CHAR(64) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `ScannerSource_tokenHash_key` (`tokenHash`),
  INDEX `ScannerSource_companyId_active_idx` (`companyId`, `active`),
  INDEX `ScannerSource_uploadedById_idx` (`uploadedById`),
  CONSTRAINT `ScannerSource_tokenHash_check` CHECK (`tokenHash` REGEXP '^[a-f0-9]{64}$'),
  CONSTRAINT `ScannerSource_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `ScannerSource_uploadedById_fkey` FOREIGN KEY (`uploadedById`) REFERENCES `User` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;

CREATE TABLE `ScannerImport` (
  `id` VARCHAR(100) NOT NULL,
  `sourceId` VARCHAR(100) NOT NULL,
  `sha256` CHAR(64) NOT NULL,
  `byteSize` INTEGER NOT NULL,
  `status` ENUM('IMPORTED', 'DUPLICATE', 'REJECTED') NOT NULL,
  `ocrDocumentId` VARCHAR(100) NULL,
  `documentId` VARCHAR(100) NULL,
  `failureCode` VARCHAR(100) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `ScannerImport_sourceId_sha256_key` (`sourceId`, `sha256`),
  INDEX `ScannerImport_sourceId_createdAt_idx` (`sourceId`, `createdAt`),
  INDEX `ScannerImport_ocrDocumentId_idx` (`ocrDocumentId`),
  INDEX `ScannerImport_documentId_idx` (`documentId`),
  CONSTRAINT `ScannerImport_sha256_check` CHECK (`sha256` REGEXP '^[a-f0-9]{64}$'),
  CONSTRAINT `ScannerImport_byteSize_check` CHECK (`byteSize` >= 8 AND `byteSize` <= 10485760),
  CONSTRAINT `ScannerImport_link_check` CHECK (
    (`status` = 'IMPORTED' AND `ocrDocumentId` IS NOT NULL AND `documentId` IS NULL AND `failureCode` IS NULL) OR
    (`status` = 'DUPLICATE' AND (`ocrDocumentId` IS NOT NULL OR `documentId` IS NOT NULL) AND `failureCode` IS NULL) OR
    (`status` = 'REJECTED' AND `ocrDocumentId` IS NULL AND `documentId` IS NULL AND `failureCode` IS NOT NULL)
  ),
  CONSTRAINT `ScannerImport_sourceId_fkey` FOREIGN KEY (`sourceId`) REFERENCES `ScannerSource` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `ScannerImport_ocrDocumentId_fkey` FOREIGN KEY (`ocrDocumentId`) REFERENCES `OcrDocument` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `ScannerImport_documentId_fkey` FOREIGN KEY (`documentId`) REFERENCES `Document` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
