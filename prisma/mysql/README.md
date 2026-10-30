# MySQL schema and migration history

This is the billing-owned MySQL schema. The original PostgreSQL schema and migrations in the parent directory are preserved for rollback and historical inspection. This baseline was applied only to the new loopback `voltronix_billing_dev` database on MySQL 8.4.11. It does not import or alter PostgreSQL financial records.

Use the configured Prisma migration deployment command with the billing migration identity. The runtime identity must not have DDL privileges. Do not run `db push`, reset a populated database, or regenerate an applied migration from the Prisma model: MySQL DDL commits implicitly, and the SQL contains financial controls beyond Prisma's schema representation.

The baseline contains 23 application tables, 27 enforced CHECK constraints, explicit InnoDB/utf8mb4 storage, exact existing decimal precision, DATE invoice dates, DATETIME(3) timestamps, and bounded string/index lengths. Foreign keys use immutable identifiers with ON UPDATE RESTRICT; this is required where MySQL CHECK expressions refer to those keys. Existing delete restrictions remain, with only sessions and bill lines retaining their original delete cascades.

The 24 original PostgreSQL CHECK controls remain: financial amounts/rounding, supported currencies, independent approval, payment state/reference, due dates/payment terms, OCR reviewed-posting requirements, counters and provider mapping values. Three additional CHECKs validate explicit company destination organization IDs, data centers and environments. Table defaults use `utf8mb4_0900_bin`; searchable invoice numbers, vendor names and job names/numbers/customers use `utf8mb4_0900_as_ci`. Identifier, payment-reference and normalized-invoice uniqueness remain case sensitive.

MySQL implements the two original partial unique indexes with nullable generated columns:

- `OcrTemplate.activeVendorId` is the vendor only when the template is active. `OcrTemplate_one_active_vendor` permits one active template per vendor.
- `SyncRecord.legacyExternalId` is the external ID only when the organization is absent. `SyncRecord_legacy_target_externalId_key` retains unscoped legacy identity uniqueness, alongside the normal organization-scoped unique index.

These implementation columns are intentionally absent from Prisma input models. Preserve their expressions and indexes when preparing later migrations, and verify database metadata and negative writes after any schema change.

Migration 002 adds `HubBridgeNonce` for durable 30-second signed-request replay protection. The current schema therefore has 24 application tables; the baseline and its 27 CHECK constraints remain unchanged.

Company ownership is explicit. Vendors, jobs, bills and OCR batches require a company; bill-to-vendor and bill-to-job composite foreign keys prevent mixing company IDs. Job numbers and legacy provider IDs are unique within a company. User membership is separate from the user's role and from external organization configuration. `CompanyIntegrationDestination` binds a complete provider destination tuple to exactly one company. `HubUserBinding` maps a verified issuer/subject to a billing user; it does not grant company membership.

Run SQL and application acceptance tests against disposable billing MySQL databases. Query `information_schema.TABLE_CONSTRAINTS`, `STATISTICS`, `COLUMNS` and `REFERENTIAL_CONSTRAINTS` to verify actual controls. Windows MySQL may lowercase table names in metadata; compare those names case insensitively. Do not treat a generated Prisma client or a successful schema application as evidence of completed workflow, authorization, provider, restart or restore testing.

References: [MySQL CHECK constraints](https://dev.mysql.com/doc/refman/8.4/en/create-table-check-constraints.html), [foreign key restrictions](https://dev.mysql.com/doc/refman/8.4/en/create-table-foreign-keys.html), and [generated columns](https://dev.mysql.com/doc/refman/8.4/en/create-table-generated-columns.html).
