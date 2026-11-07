-- A separately reviewed accounting correction may retain a cancelled bill as
-- immutable history with its original payments. Do not zero, move or delete
-- those payments. Ordinary application cancellation still rejects paid bills.
-- Replace the check in one ALTER so there is no unconstrained DDL interval.
ALTER TABLE `Bill`
  DROP CHECK `Bill_payments_only_approved`,
  ADD CONSTRAINT `Bill_payments_only_approved` CHECK (
    `paidAmount` = 0 OR `status` IN ('READY', 'APPROVED', 'CANCELLED')
  );
