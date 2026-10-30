-- Offline source-cache transfers have separate lineage from provider FULL scans.
-- A RESTORE must never seed a successful hosted provider reconciliation.
ALTER TABLE `BooksImportRun` DROP CHECK `BooksImportRun_kind_check`,
  ADD CONSTRAINT `BooksImportRun_kind_check` CHECK (`runKind` IN ('FULL','INCREMENTAL','RESTORE'));
ALTER TABLE `CrmImportRun` DROP CHECK `CrmImportRun_kind_check`,
  ADD CONSTRAINT `CrmImportRun_kind_check` CHECK (`runKind` IN ('FULL','INCREMENTAL','RESTORE'));
