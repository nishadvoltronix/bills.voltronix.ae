BEGIN;

-- Defense in depth: financial invariants hold even outside the HTTP services.
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_amounts_valid" CHECK (
  "subtotal" >= 0 AND "discount" >= 0 AND "discount" <= "subtotal"
  AND "vatRate" >= 0 AND "vatRate" <= 100 AND "vatAmount" >= 0
  AND "total" > 0 AND "paidAmount" >= 0 AND "paidAmount" <= "total"
  AND "total" = "subtotal" - "discount" + "vatAmount"
  AND "vatAmount" = ROUND(("subtotal" - "discount") * "vatRate" / 100, 2)
  AND "version" > 0
);
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_dates_valid" CHECK ("dueDate" IS NULL OR "dueDate" >= "invoiceDate");
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_currency_supported" CHECK ("currency" IN ('AED', 'USD', 'EUR', 'GBP', 'SAR'));
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_approval_complete" CHECK (
  "status" <> 'APPROVED' OR ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "approvedById" <> "createdById")
);
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_payments_only_approved" CHECK ("paidAmount" = 0 OR "status" = 'APPROVED');
ALTER TABLE "BillLine" ADD CONSTRAINT "BillLine_amounts_valid" CHECK (
  "quantity" > 0 AND "unitPrice" >= 0 AND "lineTotal" >= 0
  AND "lineTotal" = ROUND("quantity" * "unitPrice", 2)
);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_reference_present" CHECK (LENGTH(TRIM("reference")) > 0);
ALTER TABLE "Job" ADD CONSTRAINT "Job_values_valid" CHECK (
  "contractValue" IS NULL OR ("contractValue" >= 0 AND "contractValue" + "approvedVariations" >= 0)
);
ALTER TABLE "Job" ADD CONSTRAINT "Job_currency_supported" CHECK ("currency" IN ('AED', 'USD', 'EUR', 'GBP', 'SAR'));
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_currency_supported" CHECK ("currency" IN ('AED', 'USD', 'EUR', 'GBP', 'SAR'));
ALTER TABLE "Document" ADD CONSTRAINT "Document_size_positive" CHECK ("byteSize" > 0);
ALTER TABLE "SyncRecord" ADD CONSTRAINT "SyncRecord_attempts_valid" CHECK ("attempts" >= 0);
ALTER TABLE "SyncRecord" ADD CONSTRAINT "SyncRecord_confirmation_required" CHECK ("status" <> 'SYNCED' OR ("externalId" IS NOT NULL AND LENGTH("externalId") > 0));

COMMIT;
