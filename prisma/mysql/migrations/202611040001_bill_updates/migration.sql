-- Additive operation only. Existing creation and attachment history is retained.
ALTER TABLE `IntegrationJob`
  MODIFY COLUMN `operation` ENUM('CREATE_BILL', 'ATTACH_DOCUMENT', 'CREATE_EXPENSE', 'UPDATE_BILL') NOT NULL;
