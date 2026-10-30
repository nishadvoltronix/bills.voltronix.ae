-- Additive read-source bindings only. Existing company/accounting data is untouched.
CREATE TABLE `CompanyCrmSource` (
    `companyId` VARCHAR(100) NOT NULL,
    `organizationId` VARCHAR(100) NOT NULL,
    `dataCenter` VARCHAR(2) NOT NULL,
    `environment` VARCHAR(10) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CompanyCrmSource_organizationId_dataCenter_environment_idx` (`organizationId`, `dataCenter`, `environment`),
    PRIMARY KEY (`companyId`),
    CONSTRAINT `CompanyCrmSource_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `Company` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;
