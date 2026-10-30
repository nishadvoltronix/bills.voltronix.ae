-- Preserve existing draft/pending/approved records. READY represents an explicit
-- completed entry, not an approval, and retains no fabricated approver metadata.
ALTER TABLE `Bill` MODIFY `status` ENUM('DRAFT', 'READY', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT';
ALTER TABLE `Bill` DROP CHECK `Bill_payments_only_approved`;
-- Keep the historical constraint name so older schema diagnostics remain valid.
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_payments_only_approved` CHECK (`paidAmount` = 0 OR `status` IN ('READY', 'APPROVED'));
ALTER TABLE `Bill` ADD CONSTRAINT `Bill_ready_without_approval` CHECK (
  `status` <> 'READY' OR (`approvedById` IS NULL AND `approvedAt` IS NULL)
);

-- New automatic work binds the initiating staff member. Existing queue rows are
-- preserved with NULL; they do not acquire automatic authority by migration.
ALTER TABLE `IntegrationJob` ADD COLUMN `initiatedById` VARCHAR(100) NULL;
CREATE INDEX `IntegrationJob_initiatedById_idx` ON `IntegrationJob`(`initiatedById`);
ALTER TABLE `IntegrationJob` ADD CONSTRAINT `IntegrationJob_initiatedById_fkey`
  FOREIGN KEY (`initiatedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
