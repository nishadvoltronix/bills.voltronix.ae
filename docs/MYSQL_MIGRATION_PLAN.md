# MySQL development migration plan — 28 October 2026

This is a development migration, not a production cutover. The existing billing application uses Prisma 7.10.1 with PostgreSQL, six PostgreSQL migrations, and a local `bills_dev` database. Hub has a separate native MySQL architecture and its root environment describes an existing production target; that environment must not be used for these tests.

## Preservation boundary

- A source checkpoint and SHA-256 manifest are retained under ignored `.local/mysql-transition-baseline-20261028/`. The environment is hashed there, not printed or included in source files.
- Preserve the existing PostgreSQL database, private originals and migrations 001–006. Do not convert or reset that database in place.
- Use only the retained MySQL 8.4.11 executable from Hub with a new billing-owned data directory, loopback listener and independently created development identities. Existing Hub data directories are outside this migration.
- Keep one active `DATABASE_URL` contract. Any development switch needs a protected backup of the current environment. Never use the Hub production environment or carry live provider settings into the new fixture environment.
- Production accounting writes stay disabled. Provider tests use mocks unless a separately verified nonproduction account is available.

## Compatibility work, in order

1. Verify the executable version, start an isolated real MySQL instance, and verify the server identity. Create `voltronix_billing_dev` with utf8mb4, InnoDB and UTC. Separate a restricted runtime identity from schema migration and test provisioning identities. Verify actual grants; application accounts receive no global administrative privileges.
2. Keep Prisma and create a separate MySQL migration history. Preserve the PostgreSQL history unchanged. Use the Prisma MySQL adapter matching the installed Prisma version, with connection options derived from `DATABASE_URL`.
3. Specify text lengths, decimals, JSON, dates, collation and indexed string lengths explicitly. Reproduce financial CHECK constraints, foreign keys, invoice/payment uniqueness, approval independence, payment-term checks and the legacy remote-ID uniqueness safeguard. Verify real MySQL metadata after applying the baseline. MySQL DDL must not be treated as transactionally reversible PostgreSQL DDL.
4. Port atomic login-attempt upserts, row/queue locks, OCR owner serialization and case-insensitive searches. Exercise concurrency and rollback against MySQL; do not weaken existing safeguards or remove failing assertions to obtain a pass.
5. Adapt disposable database, seed and restore guards. Tests must pin a loopback server and known disposable database identity before any schema/reset action. Ordinary tests strip provider credentials and disable networking.
6. Verify manual draft/create/edit/submit, independent approval, partial/full payment, private attachments, permissions, exact decimal results, search/pagination, duplicate prevention and persistence across an actual application restart.
7. Retain two independently configured Books destinations, preview/explicit queue action, immutable destination, canonical reference, unknown-outcome reconciliation and history. Verify these through mocked providers and real MySQL persistence; report provider testing separately.
8. Add company authorization and a bounded Hub billing read contract before claiming cross-company isolation or CRM dashboard integration. Reuse verified Zoho CRM record IDs and job numbers. Do not infer memberships or migrate existing production company assignments from external destination labels.
9. Run lint, typecheck, unit tests, real MySQL integration tests, browser/API tests, build and release privacy checks. Record each executed result and each blocked/not-run requirement separately.

## Existing data and rollback

The new development database starts with clearly labelled fictional fixtures. Existing PostgreSQL records are preserved in place, not silently imported. Any later copy must preserve IDs and relationships and reconcile row counts, money totals per currency, immutable snapshots and document hashes before switching readers. Company assignment requires reviewed source evidence.

For a failed development conversion, stop only the new billing process, restore application sources/dependencies and the protected original environment from the checkpoint, regenerate the PostgreSQL Prisma client, and restart the existing PostgreSQL application. Keep MySQL evidence and data for diagnosis. Do not drop either source database or reuse an old migration history against a different provider.

## References

- [Prisma 7 MySQL setup](https://www.prisma.io/docs/v7/prisma-orm/quickstart/mysql) documents the MySQL adapter and required real server connection.
- [MySQL Windows installation](https://dev.mysql.com/doc/refman/8.4/en/windows-installation.html) documents executable/configuration startup requirements.
- [MySQL 8.0 release notes](https://dev.mysql.com/doc/relnotes/mysql/8.0/en/) record the 8.0 EOL boundary; the separately discovered 8.4.11 binary avoids using the installed 8.0.46 engine for this task.
