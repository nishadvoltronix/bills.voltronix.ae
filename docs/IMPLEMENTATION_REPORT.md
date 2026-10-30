# MVP implementation report

Historical milestone report. The master-specification follow-up, current test results, live-integration boundaries and release blockers are tracked in [IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md), [INTEGRATION_MAPPING.md](../INTEGRATION_MAPPING.md) and [REMAINING_WORK.md](../REMAINING_WORK.md).

Date: 27 October 2026, Asia/Dubai. Scope: the first working local MVP specified in the follow-up instruction. Advanced OCR automation and live integrations are deferred until this milestone is accepted and providers/infrastructure are available.

## 1. Existing functionality discovered

- `G:\bills.voltronix.ae` initially contained no files, Git repository, database schema, application code, environment configuration, or deployment manifest. Searches of the connected GitHub installation for `voltronix` and `bills` returned no matching repositories; this is not proof that no private repository exists elsewhere.
- The public [bills.voltronix.ae landing page](https://bills.voltronix.ae/) returned HTTP 200 and a coming-soon page, with no landing-page login/form. `/_next/` and Turbopack assets suggested Next.js. Its internal routes, authentication, database, and deployment origin were not established from public HTML.
- During the originally requested inspection, read-only Zoho metadata identified a VOLTRONIX production **Zoho CRM** organization. No business record contents, passwords, financial records, or credential values were read or changed. Discovery stopped when the scope changed to a disconnected new MVP.
- Metadata identified candidate `Deals.JobDealNumber`, `DealNumber`, `Amount`, and account links, plus Vendors, Purchase Orders, customer-linked Invoices, and Books-related deal fields. These are potential future mapping leads, not verified active integrations. Supplier bills must not be assumed to belong in CRM customer Invoices. The `Projects` module reported `api_supported=false`.
- The existing custom user module had role/status metadata and a text field named `password`; no values were read and no storage/hashing conclusion can be drawn. Its authentication was not reused.
- The follow-up instruction explicitly authorized a new Next.js/TypeScript/PostgreSQL/Prisma MVP. No existing production source or data was overwritten.

## 2. Implemented changes

The app now includes secure login, four server-enforced roles, a responsive navigation/layout, manual bill creation/editing, vendor/job selection and creation permissions, bill filtering/search/sorting/pagination/current-page CSV export, private invoice attachments, bill details/audit history, independent approval/rejection, unpaid cancellation, partial/full payment records, job summaries, budget alerts, and management views.

Money calculations use decimal arithmetic on the server and for browser previews/formatting. Financial totals are recalculated server-side. Strict schemas, database constraints, optimistic versions, transactional writes, and duplicate references protect bill workflows. The reviewed security fixes also protect resolved private-storage paths, include full edited financial snapshots in audits, require HTTPS for production authentication, and exclude runtime secrets/documents from build tracing.

The source includes a local environment generator, an isolated persistent development PostgreSQL helper, a guarded fictional seed, trusted user-provisioning CLI, automated tests, and a release privacy check. A local Git repository was initialized; no commit, remote, or push was created.

## 3. Database changes and migrations

Prisma models: User, Session, LoginAttempt, Vendor, Job, Bill, BillLine, Payment, Document, SyncRecord, AuditLog.

Supplied SQL migrations (no Git commit has been created):

- `202610270001_initial`: tables, enums, relations, uniqueness, and indexes.
- `202610270002_financial_invariants`: amount bounds, total/VAT consistency, paid-status constraints, independent approval, and external-success identity requirements.
- `202610270003_bill_order_and_payment_terms`: nullable order number, payment-term enum/default, and preset due-date consistency. Existing bills default to Custom without changes to amounts or dates.

All three migrations were successfully applied to the loopback `bills_dev` database and fresh disposable test databases; the third was added during the follow-up below. No production database was accessed. Future application: `npm run db:migrate`, only with the explicitly authorized target configuration. No reset or destructive down-migration is supplied. Never change the checksums of already applied migrations.

## 4. OCR engine and AI provider

No engine/provider is selected or connected. The server-only `OcrProvider` contract carries structured fields, per-field confidence, warnings, request identity, and a mandatory human-review flag. The disconnected implementation raises `NOT_CONFIGURED` and does not produce fake extracted data. Single/batch UI screens explain the deferred capability. Manual entry with secure attachments works now.

## 5. Scanner requirements

Scanner ingestion is not implemented. Required evidence: exact scanner model, scan-to-folder/email/service capabilities, authorized ingestion destination, network/service identity, document size/page limits, retention, malware scanning, and worker infrastructure. No printer/OCR/API compatibility was assumed.

## 6. Zoho and CRM synchronization status

**Both remain NOT_CONFIGURED.** Each bill has independent external sync metadata, reserved IDs, and a canonical local identity. Typed server-only interfaces model confirmed success, failure, unknown outcomes, idempotency references, and reconciliation; disconnected adapters fail explicitly without network requests. No bill has been externally created, updated, or reported synchronized.

Missing before live implementation: verified supplier-bill destination, source-of-truth jobs/vendors, exact CRM endpoints, OAuth application/data-center/scopes, approved field mappings, sandbox records, durable outbox/worker infrastructure, retry/reconciliation tests, and explicit authorization for any live test.

## 7. Original MVP verification

These results record the original milestone. The later Zoho form follow-up and its verification are recorded in section 11.

- ESLint: passed with no warnings/errors in the final source checks.
- TypeScript: passed; the typecheck command generates Next route types for fresh checkouts.
- Unit tests: **69 passed**, covering decimal calculations, rounding, VAT, recognition, duplicate normalization, validation, permissions, password hashing, request bounds, and same-origin checks.
- PostgreSQL integration tests: **14 passed**, using real migrations/transactions in newly generated disposable local databases. Coverage includes bill creation/editing/duplicates, role/ownership restrictions, independent approval, optimistic concurrency, payment limits and duplicate references, cancellation, aggregate correctness, audits, private documents, sessions/HTTPS guards, unauthorized HTTP requests, and disconnected provider behavior.
- Browser tests: **3 passed** in Microsoft Edge against both the development server and the optimized production build served locally. Coverage includes protected/cross-origin endpoints, live desktop/mobile dashboards, and manual bill creation → private attachment → edit → submit → independent approval → payment → searchable bill record.
- All 12 principal UI routes were additionally checked at 390 px width with no page overflow; large tables retain their own horizontal scrolling. Drawer focus, Escape, hidden navigation, and focus restoration were checked.
- Production build: passed. Release privacy check found no configured secrets or private runtime paths in the checked build files.
- Dependency audit: zero reported vulnerabilities after upgrading Prisma to patched 7.10.1. Dependencies are locked. This is an automated package audit, not a penetration test.

During validation, the PostgreSQL driver emitted a deprecation notice about queries queued on a busy connection. The locked driver/adapter combination passed the workflow and concurrency checks; review adapter compatibility before upgrading to pg 9. This notice was not suppressed.

Earlier UI contract mismatches and mobile overflow discovered during checks were corrected; the final checks above passed. Tests use fictional data only. Browser acceptance tests leave additional clearly labelled `DEMO-E2E` records in the development database; integration tests remove only their own newly created test database.

## 8. Security and accounting limits

Read [ACCOUNTING.md](ACCOUNTING.md) and the README security section. The operating policy recognizes only approved bills, excludes VAT from costs, includes VAT in payables/payments, separates approval/payment/sync state, and labels profit provisional. Missing/invalid contract values suppress profit percentages and incomplete aggregate profit. Currency conversion, credit notes, reversals, refunds, prepayments, recoverability-specific VAT, overhead allocation, multi-job splits, and final statutory accounting are outside the MVP.

This is a single-organization authorization model: Management/Admin/Accounts have organization-wide permitted read access; Data Entry has own-bill scope and hidden contract values. There is no branch/multi-tenant/individual job membership model. Password recovery, MFA/SSO, user-admin UI, antivirus/quarantine, immutable external audit archival, backup/restore operations, and production network controls remain operational follow-up work. Direct privileged database writes can bypass service-level cross-record invariants.

The local embedded database is development tooling, not the selected production database service. Runtime error responses are deliberately sanitized. A crash between file creation and metadata commit may leave an unreferenced private file; a future reviewed orphan-reconciliation task is required for production operations.

## 9. Remaining blockers

No external credential or provider is needed to run and test the implemented local MVP. For a production launch, the hosting/database/storage/backup arrangements, identity provisioning policy, tax/accounting policy review, malware protection, network controls, and deployment authorization are still required. For advanced automation, provider credentials and supported mappings remain unavailable. The app has not been represented as an already connected or deployed production system.

## 10. Manual deployment instructions

See [DEPLOYMENT.md](DEPLOYMENT.md) for exact local release checks, authorized staging configuration, build/migration/start commands, first-user provisioning, smoke checks, and rollback constraints. No production environment variables, services, DNS, existing data, or GitHub repositories were changed. Publishing and production deployment require explicit approval.

## 11. Zoho Books New Bill follow-up — 27 October 2026

The manual form now follows the core [Zoho Books New Bill layout](https://www.zoho.com/ae/books/help/bills/basic-functions.html): vendor and bill details, item rows, notes/attachments, totals, and draft/approval actions. Order numbers and payment terms persist with audit history. Due on Receipt and Net 7/15/30/45/60 calculate due dates from the bill date, including calendar rollovers; Custom retains a chosen date or none. Server validation rejects contradictory preset dates. Existing job preselection, description create/detail/edit behavior, decimal calculations, private attachments, and independent approval remain covered.

Follow-up verification: **92 unit tests, 16 PostgreSQL integration tests, and 2 targeted browser tests passed**. The browser checks cover desktop/mobile layout and bill save, details, edit, submission, and independent approval. ESLint, TypeScript, and the production build passed; the release privacy check passed across 606 build files. These targeted browser results supplement the historical MVP results above.

This is the local core entry workflow, without full Zoho ledger/tax controls or a live Zoho connection. No production deployment, external synchronization, or Git commit/push was performed.
