# Books account, tax and customer selections

Validated locally on 29 October 2026. The existing bill-entry form now supports searchable company-specific account, tax and optional customer selections on each line. The earlier vendor autocomplete remains in place.

## Behavior

- The server derives the unique Books destination from the selected internal company ID. Options and saved identities are scoped to that organization, data center and environment. Current writer access, company membership, destination and authorization are checked before/after lookups and again during persistence.
- Account/tax catalogs use the existing Zoho transport and catalog parser. A bounded, short-lived server cache retains only sanitized options. Customer searches use bounded provider GET requests; exact customer IDs can be hydrated. There is no duplicate vendor/customer database or separate company setup.
- Active supported purchase, expense and asset accounts are selectable. Unsupported/inactive accounts and taxes are unavailable for selection. Both `Active`/`Inactive` status capitalization and `is_active` are handled. Only simple percentage taxes supported by the current calculations are selectable.
- Saving verifies the selected IDs against fresh provider metadata. Labels are normalized. A changed tax percentage rejects the save for review, rather than silently changing the displayed invoice totals. Provider errors, empty search, retries and late responses are handled without replacing another company's selection.
- Each line retains its account, tax and optional customer identity. Existing saved choices remain visible even outside current search results. Explicit clearing sends null; an older caller cannot accidentally erase saved choices by omitting them.
- All lines must either have complete Books selections or use the existing category/header-VAT workflow. Selected lines group tax by exact tax ID before rounding, including mixed rates. Nonzero discounts with selected line taxes are rejected because that calculation is not supported. Existing local bills without line selections retain their previous discount and VAT behavior.
- The adapter uses the documented per-line account, tax and customer fields, with customer attribution non-billable. It rechecks selected metadata before a future financial POST and confirms the returned allocations and totals. These paths follow the [Zoho Books bill API](https://www.zoho.com/books/api/v3/bills/); account options come from the [chart of accounts API](https://www.zoho.com/books/api/v3/chart-of-accounts/). No live financial POST was performed during this task.
- Existing Materials/Other mappings were preserved. An unmapped LABOUR bill still cannot fall back to another category. A per-line LABOUR account is used only when the user explicitly selects and the server verifies it.
- Company switches clear dependent selections while preserving entered invoice text and amounts. Popovers support keyboard selection, reopening after Escape, grouped account names and bounded desktop/mobile placement. The banner distinguishes read access from live posting readiness.

## Explicitly approved local schema changes

The user approved both additions, separately. A private SQL backup and financial-record baseline were captured first.

1. `202610290001_bill_line_books_selection`: nullable `BillLine.booksSelection` JSON; all existing lines remain null.
2. `202610290002_book_line_tax_mode`: `Bill.usesBooksLineTaxes`, default false, and an updated VAT check. Existing bills retain the exact original header-VAT formula. Selected mode retains the amount/payment/total bounds and requires zero discount; exact grouped VAT is verified by the financial service. Clients cannot set the mode. Finalization, audit snapshots and queueing reject inconsistent mode/line data.

Both migrations were applied only to the guarded local development MySQL instance. Previously applied migrations and the archived PostgreSQL schema were preserved. The resulting schema has seven applied migrations, 274 columns and all 36 enforced checks. Existing snapshot hashes keep their legacy shape.

## Validation results

- **831 unit tests passed.**
- **144 MySQL integration tests passed**, including 14 new selection/persistence/constraint cases. One optional Hub fixture test was skipped. The disposable test database was cleaned up successfully.
- **54 distinct browser checks passed across the full run and focused reruns.** This includes all 12 new line-selection cases, both companies, existing vendor autocomplete, attachments, duplicate handling, OCR, bill editing and mocked synchronization. One consent check was skipped because the isolated browser server disables provider networking. A readiness-copy assertion was updated to the new wording and rerun successfully.
- Full lint, TypeScript checking and production build passed. Release validation checked 1,027 build files without finding configured secrets or private runtime paths.
- Actual read-only metadata checks passed for Contracting (`828765858`: 82 accounts, two taxes, first 25 customers) and Switchgear (`802911060`: 64 accounts, two taxes, first 25 customers). Both have further customer results accessible by search. Fresh selected-account/tax/customer preflight GETs also passed for both organizations. These checks created no local supplier or bill records.
- The real local form was inspected on desktop and at 390px mobile width; the page fits the viewport. The local development app was restarted to load the new Prisma model.
- Before/after comparisons found no changes to pre-existing values in 34 bills, 34 bill lines, three vendors, four companies, four destinations, four jobs, 28 attachment records and 15 payments. All 28 original attachment files matched their recorded SHA256 and byte sizes. Existing lines remain null and existing bills remain in legacy tax mode. `.env` is unchanged by checksum. The existing browser regression suite added its normal fictional test bills/attachments; no old bill was recreated or migrated.

## Files changed

Form and display:

- `src/components/books-line-picker.tsx`
- `src/components/bill-form.tsx`
- `src/components/bill-detail.tsx`
- `src/components/types.ts`
- `src/app/globals.css`

Options, validation and persistence:

- `src/app/api/bills/options/route.ts`
- `src/lib/books-selection.ts`
- `src/lib/services/bill-books-options.ts`
- `src/lib/services/books-accounting-catalog.ts`
- `src/lib/validation.ts`
- `src/lib/finance.ts`
- `src/lib/services/bills.ts`
- `src/lib/services/ocr.ts`
- `src/lib/integrations/books.ts`
- `src/lib/integrations/source-snapshot.ts`
- `src/lib/integrations/queue.ts`
- `prisma/mysql/schema.prisma`
- `prisma/mysql/migrations/202610290001_bill_line_books_selection/migration.sql`
- `prisma/mysql/migrations/202610290002_book_line_tax_mode/migration.sql`

Tests:

- `tests/bill-books-options.test.ts`
- `tests/bill-books-options-routes.test.ts`
- `tests/books-accounting-catalog.test.ts`
- `tests/books-selection.test.ts`
- `tests/books-selected-payload.test.ts`
- `tests/books-line-selections.integration.test.ts`
- `tests/e2e/books-line-selection.spec.ts`
- `tests/e2e/manual-readiness.spec.ts`

## Remaining operational setup

The form implementation is complete. Both actual Books organizations are still attached to the existing local connection-check companies, each with zero local jobs/projects. The existing job requirement remains: a real job/project must be created or imported through the existing workflow before entering a bill for either company. Customer attribution is optional and does not create or replace that job.

Live bill posting remains disabled. Operational company/destination verification, deployment/runtime setup, reviewed accounting/currency configuration and worker readiness still require the separate production setup. No production settings, company configuration or live-write flags were changed; no deployment, GitHub push or live Zoho bill posting occurred.
