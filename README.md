# VOLTRONIX Bills Entry Platform

**Current release scope — manual entry and automatic Zoho updates:** keep `MANUAL_ENTRY_ONLY=false` so typed bills retain **Save and sync**. A separate incoming worker reads Zoho Books bills and CRM jobs into the app; Books and CRM read configuration is required for those sources. The outgoing Books worker retains its existing financial-write gates and company verification. OCR/scanner intake remains disabled in the production template. Follow [the deployment runbook](docs/MANUAL_DEPLOYMENT.md), [incoming sync setup and evidence](docs/INCOMING_SYNC.md), and `npm run check:sync`. Local saving, incoming read success and queued status do not establish production posting acceptance.

A local business application for invoice entry, OCR review, direct Books synchronization, private documents, payment recording, integration work queues, and provisional job profitability. Built with Next.js App Router, TypeScript, Tailwind CSS, shadcn-style Radix/CVA UI primitives, MySQL, Prisma, Zod, and automated tests.

**Current workflow — 30 October 2026:** **Save and sync** finalizes a bill as `READY` and queues its exact configured company destination when operational settings allow it. There is no separate bill approval or live-preview confirmation; OCR fields still require verification against the original, and payment remains a separate action. The guarded production branch remains disabled locally. Separate `[CONNECTION CHECK]` demo workspaces cannot post bills. See [setup](docs/LIVE_SYNC_SETUP.md) and [current validation/status](docs/APPROVAL_FREE_SYNC_VALIDATION.md). The [earlier live-sync report](docs/LIVE_SYNC_VALIDATION_REPORT.md) is historical. No provider financial write or hosted deployment has occurred; OAuth readiness or consent is not live-posting acceptance.

The active development database is MySQL 8.4.11. At **08:43 Dubai on 30 October**, **4,674 real Zoho Books bills and all 4,188 current source originals** were available, with **zero pending originals**. The incoming worker picked up three new bills overnight. Authenticated original Open/Download checks passed for both companies, and a coordinated backup passed an isolated 35-table restore plus verification of every original file. The five dashboard financial totals independently matched raw source data. See [current coverage and recovery evidence](docs/BOOKS_DATA_IMPORT.md#current-completion--30-october-2026). This is complete coverage of the current source snapshot; future additions continue through the worker. Do not run `db:seed` to prepare this populated workspace. The original PostgreSQL database and migration history remain preserved; their records were not copied into MySQL.

The complete CRM inventory now retains all 412 records with real job references. Of these, 154 are usable billing jobs; 258 have read-only profiles pending source-company or data review. Dashboard search opens jobs and bills by reference and starts bill entry with the selected usable job. Dashboard totals use actual source amounts, distinguish cash payments from credits, and show unavailable values when evidence is incomplete. Historical Books bills currently have no verified job links, so their job expenses and profit are unavailable. See [CRM import and dashboard evidence](docs/CRM_JOB_IMPORT.md).

Incoming synchronization now defaults to 60-second source checks and daily reconciliation, preserving daily API quota. The visible dashboard reads saved status every five seconds and shows timestamps with seconds; provider backoff and in-progress source checks still take precedence. All three sources had successful checks with no quota/error state at the historical morning coverage verification; later provider quota delays remain visible in the dashboard. It reports authorized source status, last success, earliest next check and stale data. See [incoming configuration and historical validation](docs/INCOMING_SYNC.md). Hosted production setup, permanent supervision and reboot acceptance remain manual and unverified.

**Integration configuration is managed on the server.** There is no Integrations menu or setup page; `/integrations` redirects to Bills. Operators configure credentials, organization profiles and accounting mappings in the private server environment and protected backend services. `ZOHO_BOOKS_REFRESH_TOKENS_JSON` supports a separate bootstrap token for each configured Books organization; stored encrypted grants retain precedence. See [server integration setup](docs/SERVER_INTEGRATION_SETUP.md). Configuration does not establish provider acceptance or enable local financial writes.

Automatic scanner-folder intake is implemented as a separate Windows worker using the existing private-storage, Azure OCR and human-review workflow. See the [Windows setup and sample guide](docs/SCANNER_IMPORT_SETUP.md) and [scanner validation report](docs/SCANNER_IMPORT_VALIDATION_REPORT.md). The verified `Y:` mapping is `\\192.168.60.10\Nishad_Scan`, but authenticated share access and live Azure extraction remain unverified. Real scanner intake is not enabled.

**No hosted production deployment, GitHub push, hosted database change, or provider financial write has been performed.** The live incoming read results are identified in [incoming sync evidence](docs/INCOMING_SYNC.md); automated provider contract tests use fictional responses. Read [implementation status](IMPLEMENTATION_STATUS.md), [verified mappings](INTEGRATION_MAPPING.md), [remaining work](REMAINING_WORK.md), [security review](SECURITY_REVIEW.md), and [deployment procedures](DEPLOYMENT.md).

## Run locally

Requires Node.js 22.12+ (validated on Node 24), npm, and MySQL 8.4. The supplied local helper is specific to this Windows workspace and the verified retained MySQL 8.4.11 binary; it listens only on `127.0.0.1:3308` and persists its separate data under ignored `.local/mysql-dev/data`. It does not download or install a server, use Hub's existing data directory, or manage production databases.

```powershell
cd G:\bills.voltronix.ae
npm ci
npm run db:local
npm run db:generate
npm run db:migrate
npm run dev
```

This workspace is already provisioned with imported business data. MySQL starts in the background. Use these diagnostic commands if needed:

```powershell
cd G:\bills.voltronix.ae
npm run mysql:status
node scripts/mysql-migrate.mjs --verify-only
```

Open **http://127.0.0.1:3000**. Use the Admin or Accounts email and password in your local, ignored `.env`. There is no public registration route or universal default password. Use the exact `127.0.0.1` origin; `localhost` is a different origin for CSRF and cookies. Private database provisioning credentials are separate from the application's `DATABASE_URL` and have owner-only Windows ACLs.

For this workspace, setup and migrations have already been performed. Fictional business records were removed before the real imports; retained login accounts remain available. Start the database and app if they are no longer running, and preserve `.env` and `.local` between sessions. Do not reseed this populated database.

`local:setup` now provisions only the guarded, workspace-specific MySQL instance; it does not overwrite an existing environment or perform a PostgreSQL data conversion. This checkout runs one MySQL provider. Rollback to PostgreSQL requires restoring the saved source/configuration and regenerating its original client, as described in the migration plan. Never point this development checkout at production databases or enable fixture accounting writes. Configure integrations through [server integration setup](docs/SERVER_INTEGRATION_SETUP.md); [LIVE_SYNC_SETUP.md](docs/LIVE_SYNC_SETUP.md) explains runtime and company requirements. `db:seed` requires explicit development/demo settings, a guarded loopback database and explicit seed credentials. All seeded companies, jobs, vendors and bills are fictional and marked `DEMO`. Existing seed records and passwords are preserved on repeated runs.

## Working features

- Responsive login, sidebar, overview, and management screens with loading, empty, success, and error states.
- Database-backed opaque sessions, scrypt password hashes, session revocation, expiry, active-user checks, login throttling, and server authorization.
- Manual invoice entry and draft/rejected editing with searchable job selection, vendor selection, line items, discounts, VAT, currency, dates, description, notes, and attachments.
- Persisted order numbers and payment terms: Due on Receipt and Net 7/15/30/45/60 calculate the due date from the bill date; Custom allows a chosen due date or none. Server validation rejects conflicting preset due dates, and edits retain existing values.
- Search, pagination, sorting, bill-status/payment/job/vendor/category/date filters, and CSV export of the **current bill-list page**. CSV cells neutralize spreadsheet formulas.
- Bill detail with line items, payment history, private downloads, Save and sync, synchronization readiness, and financial audit history.
- Admin job creation and Admin/Accounts vendor creation. Local IDs are separate from reserved external CRM/Zoho mappings; no automatic creation of remote jobs.
- Direct finalization by an authorized bill writer, optional drafts, cancellation of unpaid bills, and separate partial/full payment recording with unique references.
- Dashboard job-ID/bill-number search, scoped source profiles, and prefilled manual entry. Source-backed expenses, cash payments, credits and outstanding balances; job profit and budget signals are shown only with sufficient verified coverage.
- Management currency/job filters, lifetime totals, monthly finalized expense trends, vendor expense breakdowns, budget watch, high-expense jobs, and OCR/synchronization attention counts.
- Separate expense reports filter by invoice date, vendor, category, bill status, job and currency. CSV export includes all matching records up to 10,000, with a 100-row on-screen preview. CSV opens in Excel; a native XLSX export is not supplied.
- Single/batch PDF, JPEG and PNG uploads, mobile capture input, private originals, bounded durable OCR processing, per-field confidence, matching/duplicate warnings, immutable extraction evidence, editable review, and idempotent verified draft creation. Multipage PDFs must contain one invoice.
- Versioned vendor templates and per-document field verification before Save and sync or optional draft save. OCR uses Azure Document Intelligence's prebuilt invoice model; no extraction is fabricated when unconfigured.
- Read-only scanner-folder polling with stable-copy checks, Windows file locks, private restart state, scoped machine credentials, durable MySQL file-hash receipts and duplicate-safe retries. Scanner arrivals appear in dashboard OCR attention and the paginated review queue. Human field verification remains required; a second approver is not required.
- Zoho Books supplier-bill mapping, encrypted OAuth/refresh rotation, finalized snapshots, durable synchronization and serialized attachment jobs, bounded retries, unknown-outcome reconciliation, and history. Sandbox writes retain their separate test authorization. The disabled-by-default production branch requires an operational HTTPS/database environment, verified real-company routing and current writer permissions. New jobs can run through the supervised queue worker without per-bill confirmation. Local connection-check workspaces cannot post.
- Books synchronization currently blocks discounted bills and refuses to overwrite a different remote attachment; verified API mappings and authorized acceptance tests are needed for those cases. See [INTEGRATION_MAPPING.md](INTEGRATION_MAPPING.md).
- Confirmed CRM field mapping: Deals.JobDealNumber for job ID, Amount for contract value, Deal_Name, Account_Name and Currency. The mapped import reads an existing CRM record and prevents local identifier collisions; no remote job is created. CRM supplier-expense posting requires an additional verified module/related-list design.
- Self-service password changes revoke all sessions. Trusted operator account recovery/deactivation/reactivation/session-revocation commands are audited.

The manual form follows the core layout of [Zoho Books New Bill](https://www.zoho.com/ae/books/help/bills/basic-functions.html). Save and sync replaces the former independent approval step. Reverse charge, per-line mixed tax and full Zoho ledger controls require additional accounting design.

## Roles and authorization

All financial access now requires an active company membership, including Admin access. The role table below applies only inside authorized companies. Lists/reports use the authorized company union with an optional company filter. Creating a bill, job, vendor or OCR batch requires explicit company selection when the user belongs to more than one company. A bill cannot reference another company's vendor/job. Hub additionally enforces its own current job/task access. Branch and general Billing per-job assignments are not implemented.

| Action                              | Admin | Accounts | Data Entry                | Management |
| ----------------------------------- | ----- | -------- | ------------------------- | ---------- |
| Read bills/documents                | All   | All      | Own bills only            | All        |
| Create bills                        | Yes   | Yes      | Yes                       | No         |
| Edit draft/rejected bills           | All   | All      | Own                       | No         |
| Save and sync / queue Books         | All   | All      | Own                       | No         |
| Record payments/cancel unpaid bills | Yes   | Yes      | No                        | No         |
| Create vendors                      | Yes   | Yes      | No                        | No         |
| Create local jobs                   | Yes   | No       | No                        | No         |
| Contract values/profitability       | All   | All      | Hidden; own expenses only | All        |
| Organization audit log              | Yes   | Yes      | No                        | No         |

Checks run on every API request and on document downloads. UI visibility is only a convenience. Data Entry users see available job/vendor selectors, but not contract values or other staff's bill records. Writers may finalize their own bills; no separate reviewer approval is required. Historical approval records remain preserved.

To provision another user through the trusted operator CLI, supply `ALLOW_USER_PROVISIONING=true`, `NEW_USER_EMAIL`, `NEW_USER_NAME`, `NEW_USER_ROLE`, and a unique `NEW_USER_PASSWORD` of at least 14 characters in your secure local environment, then run `npm run user:create`. No password is accepted through a public API, emitted to output, or substituted into command arguments. Clear these provisioning variables afterward. Existing users are never overwritten by this command.

Use `/account` for a password change with current-password verification. For supervised recovery or deactivation, use `npm run user:manage` with the short-lived operator variables described in [SECURITY_REVIEW.md](SECURITY_REVIEW.md). There is no unauthenticated password-reset shortcut or email delivery service.

## Accounting policy

See [ACCOUNTING.md](docs/ACCOUNTING.md) for examples, limits, state transitions, and rounding.

1. Costs are **VAT-exclusive**, calculated as `subtotal - discount`. Contract values and approved variations must use the same VAT-exclusive basis.
2. `READY` and historical `APPROVED` bills contribute recognized costs. `DRAFT`, legacy `PENDING_APPROVAL`, `REJECTED`, and `CANCELLED` contribute zero.
3. Finalization and payment are separate dimensions. Finalized bills may be `UNPAID`, `PARTIALLY_PAID`, or `PAID`. Payments do not recognize a second expense.
4. Gross payable = total including VAT. Outstanding is recognized only for finalized bills and equals gross total less payments.
5. Provisional job profit = contract value + approved variations - recognized costs. Missing, zero, or invalid adjusted job values suppress profit/percentage. An incomplete portfolio suppresses aggregate profit rather than silently treating an unknown contract as zero.
6. A currency must match the selected vendor and job. AED, USD, EUR, GBP, and SAR are supported; currencies are never silently converted or combined.
7. All calculations use decimal arithmetic, with line values and tax rounded half-up to two decimals. Database values use `DECIMAL`, and API money inputs/outputs use strings.

## Security and storage

- Session tokens are random, stored only as SHA-256 hashes in MySQL, and expire after eight hours. Cookies are HttpOnly/SameSite=Lax and Secure with an HTTPS origin. Production authentication fails closed without HTTPS configuration.
- Mutations require the exact configured `APP_URL` origin. JSON and multipart requests have bounded size. Zod validates inputs again on the server; submitted totals are recalculated.
- Private documents accept PDF, JPEG, and PNG content signatures, up to 10 MB. Filenames are generated, hashes verified on download, and access is inherited from the bill. Documents are downloaded with attachment/no-store/nosniff headers. Storage rejects public/Next build directories and unsafe resolved paths.
- Documents are immutable after bill finalization/cancellation. A failed attachment upload preserves the draft and exposes a retry; it cannot finalize or queue that draft. Retries reuse the original bill/document, with exact-version checks before finalization.
- Financial mutations, payments, state changes, and audit entries commit in database transactions. Optimistic versions and serializable transactions prevent silent concurrent overwrites.
- Duplicate normalized vendor/invoice numbers and duplicate bill/payment references are database constrained. External records reference the canonical bill; synchronization tables are not counted as expenses.
- `.env`, uploads, database files, screenshots, test output, and build artifacts are ignored. Provider credentials and encryption keys are never sent to browser components. The retired live-preview endpoint cannot issue new confirmation challenges.

Before production, provide malware scanning/quarantine and retention for uploaded financial documents, backup and tested restore for MySQL **and** private storage, network-level rate limiting, HTTPS termination and restricted storage permissions. The separate runtime/migration identities and append-only application access to audit rows were tested locally. An operated production MySQL service, verified TLS/CA adapter configuration and deployment procedures still require separate implementation and acceptance. The current CSP permits Next's inline scripts/styles; nonce-based CSP is a future hardening task.

Self-service email recovery, MFA/SSO, user/company administration screens, credit notes, reversals, foreign-exchange conversion, automated bank reconciliation, and recoverability-specific VAT accounting remain outside this release. Operator recovery and explicit company membership checks are implemented. Financial records must not be treated as final statutory accounts.

## Database and validation

Additive MySQL migrations cover the financial/company schema, durable Hub request nonces, scanner receipts and guarded live-sync permissions. The original six PostgreSQL migrations remain unchanged in their separate history. The active Prisma configuration selects only `prisma/mysql/schema.prisma` and its migrations. `npm run db:migrate` is restricted to this recognized development MySQL instance and uses its separate migrator. No Git commit, destructive source reset or production import was performed. Do not modify applied migration files.

Executed check counts, schema/grant evidence and exact commands are in the [MySQL validation report](docs/MYSQL_VALIDATION_REPORT.md). Earlier PostgreSQL/provider setup results remain dated historical evidence in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md); they do not establish current live provider acceptance.

```powershell
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:e2e
npm run build
npm run check:release
npm audit
npm run check:integrations
```

Integration tests create and drop **only their own newly generated loopback `bills_test_<pid>_<timestamp>` database and dedicated test identities**. They apply the real MySQL migrations, use real transactions, verify server identity and deny runtime DDL/audit deletion. Development records are preserved. Browser tests require seeded local data and Microsoft Edge (or set `E2E_BROWSER_CHANNEL=chrome`); they create clearly labelled additional `DEMO-E2E` invoices in the development database and save previews under ignored `.local/screenshots`. Credential traces are disabled.

Unit/database test setup strips inherited Zoho/Azure credentials, profiles and provider flags before loading fixtures. Provider requests in contract tests are mocked. Tests explicitly configure fictional destinations; live server `.env` settings are not test credentials.

## Integration and optional OCR workers

The current release uses typed entry, the outgoing Books queue, and incoming Books/CRM reads. Azure invoice OCR remains optional and disabled in the production template. Follow the [Azure OCR setup and verification guide](docs/AZURE_OCR_SETUP.md) before separately enabling it.

Configure the protected environment and supervise the two synchronization processes separately:

```powershell
npm run worker:sync -- --watch --limit=5
npm run worker:incoming -- --watch
```

The outgoing worker processes due **Save and sync** operations only when the existing writer, company, mapping and financial-write checks pass. Its batch limit defaults to five (supported range 1–25); without `--watch` it exits after one batch. Historical permission-based operations still require exact-operation execution. Incoming sync reads provider changes into local mirrors, respects persisted source backoff, and never enables outgoing financial writes. Its default source check interval is 60 seconds between completed checks, with a full reconciliation every 24 hours. See [incoming worker configuration](docs/INCOMING_SYNC.md) for its protected Admin account, Books/CRM authorization, original-file handoff and status interpretation.

Both workers use durable MySQL state and the same private storage as the web application. The web process does not start them. Production service supervision, reboot recovery and host acceptance remain required. If OCR is separately enabled, `npm run worker:ocr` runs its bounded loop and supports `-- --once` for a diagnostic tick. See [the deployment package](deploy/README.md).

The [integration mapping](INTEGRATION_MAPPING.md) records confirmed CRM metadata and the exact Books tax/account/currency/vendor prerequisites. A timed-out remote create has an unknown outcome and must be reconciled before retrying. CRM customer invoices are never used as supplier bills. The separately authorized [scanner worker](docs/SCANNER_IMPORT_SETUP.md) uses a private worker-only configuration and sends PDFs to Billing; it receives no database or Azure credentials. The existing OCR worker remains necessary on the application side.

`check:integrations` is a read-only environment inventory: it prints presence/disabled booleans, never credentials or provider responses, and refuses unexamined additional `.env.*` overrides. It does not contact providers or prove authorization/isolation. Current incoming synchronization uses authorized Books and CRM reads. Outgoing accounting-write flags remain unchanged by incoming enablement; keep the legacy `ALLOW_PRODUCTION_ACCOUNTING_WRITES` deny switch false. Current incoming evidence is recorded in [INCOMING_SYNC.md](docs/INCOMING_SYNC.md); earlier provider reports remain dated historical evidence.

Integration settings remain server-managed. Admin authorization/recovery pages are `/account/books-authorization` and `/account/crm-authorization`; there is no Integrations settings menu. Accounting mappings and operational live-company verification remain separate requirements; consent alone does not enable accounting writes. Credentials belong only in the protected server environment.

For one scheduled Zoho setup session, use the [complete Books setup packet](docs/ZOHO_BOOKS_SETUP_ONCE.md). It groups client registration, exact callback/scopes, organization/DC, all required accounting mappings and secure credential handoff so prerequisites can be collected together.

The [CRM setup packet](docs/ZOHO_CRM_SETUP.md) describes its separate callback, read-only consent and exact company source bindings. Configure the verified CRM organization, data center, OAuth grant and mapping for incoming updates. `Deals.JobDealNumber` supplies the job reference and `Amount` supplies recorded contract value, never bill expense. The approved incoming worker retains all source inventory while only actual job references appear as jobs. The legacy import endpoint's restrictions remain separate from this authorized incoming flow.

Multiple Books destinations use `ZOHO_BOOKS_ORGANIZATIONS_JSON`, with a separate `mapping` and optional approved `testAuthorization` in each profile. The protected authorization flow identifies each organization and its prerequisites. Vendor mapping and synchronization use the exact company-bound destination. Save and sync queues only a uniquely configured destination; missing or ambiguous setup remains visible on the saved bill. The first queue operation permanently binds that canonical bill to one organization, including retries and uncertain outcomes. The static callback stays the same; each organization requires its own consent flow and encrypted credential row. Existing unscoped credentials require reauthorization after migration 006; legacy supplier IDs are not guessed into scoped mappings.

Each external destination must be explicitly assigned to an authorized company. The fictional seed binds only fictional Books destinations. The guarded local connection helper uses separate `[CONNECTION CHECK]` demo workspaces for configured real Books profiles; these are not verified accounting-company assignments and remain unable to post. Authorization services, mapping, queue, retries, history and workers enforce company binding. Outgoing production synchronization requires current writer access and operational permission; incoming read enablement does not change those requirements.

Hub's job detail has a bounded, signed Billing read connection with independent authorization in both applications. It reuses verified CRM Deal identity and job number, reports saved bill/Books status and supplies safe Billing links. The [bridge setup](docs/HUB_BILLING_BRIDGE.md) describes explicit user/company bindings and the isolated native-MySQL acceptance test. The bridge remains disabled outside tests until actual assignments and environment settings are reviewed.

The [original implementation report](docs/IMPLEMENTATION_REPORT.md) preserves historical milestones; [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) is the current status. Dependency versions are locked in `package-lock.json`.
