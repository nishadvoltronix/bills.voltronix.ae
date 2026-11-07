BEGIN;

-- Preserve original payments on cancelled accounting history. The historical
-- PostgreSQL status enum has no READY value; its existing APPROVED allowance
-- remains unchanged. Application cancellation continues to reject paid bills.
ALTER TABLE "Bill"
  DROP CONSTRAINT "Bill_payments_only_approved",
  ADD CONSTRAINT "Bill_payments_only_approved" CHECK (
    "paidAmount" = 0 OR "status" IN ('APPROVED', 'CANCELLED')
  );

COMMIT;
