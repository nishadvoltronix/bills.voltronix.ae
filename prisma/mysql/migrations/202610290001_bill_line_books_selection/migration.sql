-- Optional provider selections for future bill lines. Existing rows remain SQL NULL.
ALTER TABLE `BillLine` ADD COLUMN `booksSelection` JSON NULL;
