-- Legacy rows retain their exact header VAT formula by default.
-- Verified Books selections calculate VAT by tax ID in the financial service.
ALTER TABLE `Bill`
  ADD COLUMN `usesBooksLineTaxes` BOOLEAN NOT NULL DEFAULT FALSE,
  DROP CHECK `Bill_amounts_valid`,
  ADD CONSTRAINT `Bill_amounts_valid` CHECK (
    `subtotal` >= 0 AND `discount` >= 0 AND `discount` <= `subtotal`
    AND `vatRate` >= 0 AND `vatRate` <= 100 AND `vatAmount` >= 0
    AND `total` > 0 AND `paidAmount` >= 0 AND `paidAmount` <= `total`
    AND `total` = `subtotal` - `discount` + `vatAmount`
    AND `usesBooksLineTaxes` IN (0, 1)
    AND (
      (`usesBooksLineTaxes` = 0
        AND `vatAmount` = ROUND((`subtotal` - `discount`) * `vatRate` / 100, 2))
      OR (`usesBooksLineTaxes` = 1 AND `discount` = 0 AND `vatAmount` <= `subtotal`)
    )
    AND `version` > 0
  );
