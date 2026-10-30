BEGIN;

-- Additive metadata only: existing bills keep their original dates and amounts.
CREATE TYPE "PaymentTerm" AS ENUM ('CUSTOM', 'DUE_ON_RECEIPT', 'NET_7', 'NET_15', 'NET_30', 'NET_45', 'NET_60');

ALTER TABLE "Bill"
  ADD COLUMN "orderNumber" VARCHAR(120),
  ADD COLUMN "paymentTerms" "PaymentTerm" NOT NULL DEFAULT 'CUSTOM';

ALTER TABLE "Bill" ADD CONSTRAINT "Bill_payment_terms_due_date" CHECK (
  "paymentTerms" = 'CUSTOM'
  OR (
    "dueDate" IS NOT NULL
    AND "dueDate" = "invoiceDate" + CASE "paymentTerms"
      WHEN 'DUE_ON_RECEIPT' THEN 0
      WHEN 'NET_7' THEN 7
      WHEN 'NET_15' THEN 15
      WHEN 'NET_30' THEN 30
      WHEN 'NET_45' THEN 45
      WHEN 'NET_60' THEN 60
      ELSE 0
    END
  )
);

COMMIT;
