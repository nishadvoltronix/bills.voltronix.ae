# Current remaining work - 30 October 2026

The requested local manual-entry, **Save and sync** workflow, source-backed dashboard/search, complete CRM inventory and continuous incoming synchronization are implemented. Current-source original downloads are complete: **4,188 of 4,188 files**, zero pending, alongside **4,674 Books bills**. The completed backup passed an isolated 35-table restore and verified every original's bytes. Fresh source-financial totals, newest-bill search, per-company authenticated Open/Download and desktop/mobile checks passed. See [current Books evidence](docs/BOOKS_DATA_IMPORT.md#current-completion--30-october-2026) and [incoming worker evidence](docs/INCOMING_SYNC.md#verified-current-completion--30-october-2026).

Manual/dashboard lookup accepts job ID, job name and bill number. Verified project associations now connect 15 bills to nine legacy CRM deal profiles with their actual references and original Open/Download controls. Separate refresh keeps these known associations current. See [job bill history](docs/JOB_BILL_HISTORY.md). Previously unseen project bridges and historical financial allocations still require explicit source reconciliation; similar names never establish a link.

The concrete outstanding items are:

- **Requested JOB-5358 test posting:** the actual form saved one AED 1.00 / VAT 0 draft. Books posting is pending Contracting quota recovery (the observed reset was approximately 31 October at 00:02 Dubai), verified supplier/accounting mapping, fresh one-bill permission and exact worker execution. No automatic retry of this test is scheduled. Follow [the scoped local workflow](docs/LOCAL_BOOKS_TEST.md); do not create a duplicate draft or substitute another organization.
- **Source-data review:** 258 of the 412 CRM job-reference records remain read-only: 248 lack exact company assignment, nine have duplicate references within a company, and one fails customer validation. Exact source/owner evidence is required; the completed import does not justify guessed assignments or merged jobs.
- **Historical job allocations:** Books invoices have no verified canonical job links, and approved-variation evidence is incomplete. Company totals remain available; job costs/profit stay unavailable where coverage cannot be established. Source identities or documented owner mappings are required.
- **Owner-managed production setup:** hosted application/database/storage, current company/staff/accounting/supplier configuration, permanent worker supervision and reboot recovery, and actual outgoing Books posting acceptance remain unverified. Follow [the deployment runbook](docs/MANUAL_DEPLOYMENT.md); incoming reads do not enable financial writes or promote connection-check companies.
- **Ongoing operation:** the local incoming worker continues scheduled source checks and future original downloads. Keep this PC, MySQL and network available. The current source snapshot is complete; future source additions and quota changes are ongoing work, not unfinished historical downloads.

OCR/scanner/Hub enablement and broader accounting features are outside the current typed-entry scope. Historical TODOs about missing Books/CRM read authorization, absent imports or originals, company scoping, fake dashboard values, separate bill approval, and PostgreSQL as the active engine are superseded by the implemented and verified local workflows. No provider financial write or hosted deployment was performed to close this local task.

---

# Historical remaining-work milestone - 28 October 2026

The **Save and sync** workflow is implemented without separate bill approval, batch approval or live-preview confirmation. It finalizes bills as `READY` and queues the exact company destination when operational settings allow. The guarded production branch remains disabled locally. `[CONNECTION CHECK]` demo workspaces cannot become real-company accounting assignments through OAuth consent. Complete and verify each organization's browser consent while retaining disabled financial gates. Follow [setup](docs/LIVE_SYNC_SETUP.md) and [current validation/status](docs/APPROVAL_FREE_SYNC_VALIDATION.md); [the preceding live-sync report](docs/LIVE_SYNC_VALIDATION_REPORT.md) is historical. No provider financial write or hosted deployment has occurred; live bill posting is not complete.

Real MySQL provisioning, migrations, restricted runtime access, company-scoped workflows and the Hub job-billing read implementation are complete locally. See [executed results](docs/MYSQL_VALIDATION_REPORT.md).

The subsequent scanner task implements automatic folder intake, durable MySQL deduplication, existing Azure OCR handoff and human review. Live scanner acceptance still requires restored authenticated access to the verified UNC share, an explicit real-company assignment, Azure endpoint/key and a supervised sample test. No real scanner source or live Zoho writes were enabled. See [scanner setup](docs/SCANNER_IMPORT_SETUP.md) and [executed scanner validation](docs/SCANNER_IMPORT_VALIDATION_REPORT.md). Earlier entries saying scanner work was skipped are superseded by this task.

Production readiness still requires reviewed real company/user/provider assignments, operational destination/configuration verification, provider acceptance in the separately authorized target, a PostgreSQL data-conversion plan if existing records must move, operated MySQL/TLS and staging migration procedures, coordinated backup/restore proof, document malware/retention controls, HTTPS/rate limits, worker supervision, monitoring and load testing. New queue operations run without per-bill approval but retain current writer, company, source and provider checks. Historical production permission-based jobs retain exact-job execution. Hub stays disabled outside tests until its explicit bindings are provisioned. No production deployment or accounting writes were performed.

The following earlier entries are retained as history; references to independent bill/batch approval, PostgreSQL as the active engine, absence of company scoping, blanket unsupported production Books writes, provider network state or a missing Hub view are superseded. Historical provider credentials/consent observations and test results do not prove current acceptance.

---

# Remaining work and external prerequisites

Updated 27 October 2026. Local implementation continues to preserve the manual workflow and fictional development data. No live accounting writes or deployment are authorized by this document.

The follow-up [integration readiness review](INTEGRATION_READINESS.md) contains the prioritized blockers, per-control evidence, preserved check logs and exact steps for a separately authorized nonproduction test. Local safety fixes do not close the external prerequisites below. Production Books writes are now unsupported: the legacy production flag cannot enable them.

## Credentials and permissions still required

| Service                | Required configuration / evidence                                                                                                                                                                               | Current state                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| OCR                    | Approved Azure Document Intelligence resource endpoint, resource key, region/data-processing approval, supported invoice model, quota/cost limits and representative redacted invoices                          | Adapter/mock tests supplied; no live extraction verified             |
| Zoho Books             | OAuth client ID/secret and exact callback URI; verified DC; verified organization ID; scoped consent/refresh authorization; encryption key held in secret manager                                               | App authorization not established                                    |
| Books mappings         | Organization base currency/currency IDs, approved rates or same-currency policy, vendor IDs, tax IDs with verified percentages, per-category expense account IDs, optional item IDs and job/order custom fields | No organization values guessed                                       |
| Zoho CRM               | Save CRM callback in the existing client, complete separate read-only app consent/token exchange, validate approved nonproduction import cases                                                                  | Metadata/org/DC/mapping configured; OAuth-start 200, consent pending |
| CRM expense view       | Supported related list/widget or custom expense module with unique canonical bill ID, job lookup, required permissions, approved field definition and attachment authorization model                            | Not verified; posting is disabled                                    |
| Production application | Dedicated PostgreSQL roles/secret, HTTPS APP_URL, private storage location/ACLs, durable shared worker access, encryption-key backup                                                                            | Infrastructure not selected/verified                                 |
| Recovery/SSO           | Identity-provider/mail configuration and approved enrollment/recovery policy if self-service email recovery or MFA/SSO is required                                                                              | Operator recovery only                                               |

Supply secrets through an authorized environment or secret manager, never a committed file or chat. `.env.example` contains placeholders only. [INTEGRATION_MAPPING.md](INTEGRATION_MAPPING.md) lists exact OAuth scopes, mapping format and API evidence.

## Before connecting providers

1. Configure a nonproduction OCR resource and test real redacted PDFs/images, including multipage invoices, missing values, duplicate files, rounding discrepancies and low-confidence text. Validate cost/privacy requirements and retention. A PDF containing several different invoices must be split beforehand.
2. Configure an independently verified nonproduction Books organization. Verify the organization and mappings with authorized read calls. The `sandbox` label alone cannot prove isolation. Keep writes disabled until an approved test window, exact configuration digest and operator attestation are supplied. Every POST additionally rechecks organization identity/active status/base currency; production destinations are refused. See `INTEGRATION_MAPPING.md` for the required test-mode gates.
3. Authorize the app's CRM read connection and verify the user-confirmed `Deals.JobDealNumber`/`Amount` mapping on appropriate test records. Reject missing/duplicate job IDs and inconsistent currency; do not import production financial records into the development fixture database.
4. Run one authorized end-to-end Books test: approved bill, original attachment, confirmation, timeout/reconciliation, duplicate prevention, revoked OAuth and rate-limit recovery. Reconcile by canonical reference and matching financial fingerprint before declaring success.
5. Approve and configure the CRM expense display separately. Existing customer Invoices are not a supplier-expense destination.

## Production infrastructure and security blockers

- Malware scanning/quarantine and retention of invoice documents. Current signature checks and private storage do not establish that documents are malware-free.
- Operated PostgreSQL, separately scoped runtime/migration identities, backup retention, encrypted off-host database/document backups, and a demonstrated restore drill with recorded expected row counts and verified document hashes.
- HTTPS/domain/reverse proxy, secure production cookies, trusted proxy configuration and network-level rate limiting.
- Dedicated OCR and sync worker supervision, shared private storage, graceful shutdown, resource limits, queue-age/error alerts, disk/provider-cost monitoring and a deployment health check.
- Managed secret/encryption key storage and rotation; recovery copies of encryption keys must be protected separately from encrypted OAuth rows.
- Encryption-key replacement is not an automatic migration: existing encrypted tokens become unreadable under another key. A tested reauthorization or controlled re-encryption/recovery procedure remains required; provider refresh-token rotation tests do not prove encryption-key rotation. Cross-process web/worker refresh-token rotation also needs acceptance testing; current concurrency tests cover one process.
- Production access/role review, operational ownership and final user approval for deployment/DNS/real financial writes.
- Load/capacity testing and driver/adapter upgrade review. The current Prisma/pg combination emits an unsuppressed query-concurrency deprecation warning; financial transaction tests pass, but this must be reviewed before a pg major upgrade.

Use [DEPLOYMENT.md](DEPLOYMENT.md) in order. A successful local build alone does not satisfy these blockers.

## Accounting and functional boundaries

- One shared local workspace supports explicit Books destinations with separate OAuth and vendor/account/tax mappings. This is not tenant isolation or separate company ledgers: roles, reports, local invoice uniqueness and job profitability remain workspace-wide. Every canonical bill has at most one Books destination; approval does not auto-select a destination when multiple are configured. Company-specific local ledgers/access/reporting require a separately designed scope.
- One job per invoice, VAT-exclusive cost model and a single bill-level VAT rate. Credit notes, refunds/reversals, nonrecoverable VAT, reverse charge, withholding, mixed per-line taxes and multi-job splits are not implemented.
- Estimated profit is adjusted job value less recognized approved costs. It excludes unrecorded payroll/overheads and is not final accounting profit. Missing job values suppress profit estimates.
- Currency-filtered reports do not consolidate currencies. Native XLSX generation is not provided; formula-safe CSV is supplied for Excel.
- Books before-tax fixed discount mapping is unverified, so discounted local bills are blocked from synchronization. The documented singular attachment endpoint does not establish a safe multi-document/replacement contract; different existing remote bytes are never overwritten. A confirmed bill ID remains available when attachment delivery is incomplete, and the synchronization state reports the failure.
- Integration history lists the latest 100 operations, with retained attempt history in PostgreSQL. Pagination/long-term archival is not supplied in this UI.
- New queued writes bind their original DC/environment and mapping digest. Legacy queue snapshots without destination evidence fail closed; never rewrite them or erase uncertain history to force a retry. Reconcile under the original verified destination.
- Batch invoice review remains per document. Batch approval only applies to already verified/submitted bills and enforces an independent reviewer for each.
- Source-total mismatches and uncertain OCR matches require correction. Automated confidence is evidence, not user verification.
- Self-service email reset, MFA/SSO and user administration screens require a future identity/operational design; supervised CLI lifecycle operations are available now.
- Scanner ingestion is explicitly skipped by request. No Canon capabilities or network folder are assumed.

## Release evidence

See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for actual baseline/final check counts and [SECURITY_REVIEW.md](SECURITY_REVIEW.md) for the security review boundary. Preserve the test logs and migration checksums during an authorized release; do not weaken failing tests or edit already-applied migrations.

The latest local inventory confirms Zoho network access is enabled for connection setup; Books/CRM writes, test mode and OCR remain disabled. CRM's own organization/DC and confirmed field mapping are now configured from connector metadata; its app consent remains pending. A public OAuth client ID, two owner-selected Books destination identifiers and a dedicated encryption key are configured. Client settings are present privately for each product, but secret validity/rotation and token exchange have not been verified; scoped Books accounting mappings and app OAuth grants remain missing. No external prerequisite is marked complete solely because mock tests pass. Scanner ingestion remains explicitly skipped.

The owner selected both Books organizations and supplied `books.zoho.com`; the configured DC is US under Zoho's documented domain mapping. Identifiers and domain are owner-supplied, not live provider verification. Each destination now has its own Admin readiness/authorization card and scoped vendor mapping. A production account alone does not meet the nonproduction posting-test gate. Rotate the client secret previously shared in chat at the provider and supply its replacement only through the approved environment/secret manager; do not put production credentials into this fictional fixture environment. Provider consent and a separately approved environment remain required.

Migration 006 preserves but revokes any old unscoped encrypted credentials, expires old OAuth state, and does not guess vendor destinations. Existing installations must reauthorize each connection and explicitly verify scoped vendor mappings. Legacy uncertain synchronization records must be reconciled under their original destination; deleting them or repurposing their organization is not a recovery procedure.

The owner subsequently supplied the hosted homepage `https://bills.voltronix.ae/` and registered Books redirect `https://bills.voltronix.ae/api/integrations/oauth/zoho/callback`. The route matches the code for that HTTPS origin, but the running fixture app uses `http://127.0.0.1:3000`. Keep local `APP_URL` unchanged; an authorized local test-client flow needs its exact loopback callback registered, while a hosted flow needs the approved hosted app and an Admin session on that origin. See [the setup packet](docs/ZOHO_BOOKS_SETUP_ONCE.md). Registration alone does not close deployment, credential or nonproduction-account blockers.

On 27 October 2026 at 15:56 Dubai time, the requested connection attempt authenticated to the real local app and called each organization's OAuth-start endpoint. Both returned HTTP 409 `NETWORK_DISABLED`; neither created a provider request. Local login returned 200. Unauthenticated HEAD requests to the hosted `/login` and registered callback both returned 404. This establishes the current HTTP result, not the hosted deployment's identity or its future availability. The local callback differs from the supplied HTTPS registration. The temporary diagnostic session was logged out, and no flags, deployment, DNS or accounting data changed. Redacted evidence: `.local/books-connection-try-20261027.json`. Provider consent remains incomplete.

At 16:00 Dubai, after the owner showed the local callback entry, connection access was enabled and both real local OAuth-start endpoints passed with HTTP 200, the exact local callback and offline consent. A local server restart resolved a readiness runtime error. Diagnostic states/session were cleaned up without touching other users' states. No provider call or financial operation occurred. Evidence: `.local/books-oauth-start-20261027.json`. The next step is to save the Zoho client settings with UPDATE, sign into the local app as Admin, and complete each organization's Authorize flow in that browser. This will test the actual redirect/client-secret acceptance; it is not yet verified. Accounting writes remain disabled.

At 16:06 Dubai, CRM was prepared for the connector-verified VOLTRONIX organization `802911927` in US/production. Its actual local OAuth-start also returned 200 with the separate CRM callback and READ-only scopes. Add the CRM local/hosted callbacks to the existing provider registration and complete **Authorize Zoho CRM** separately. No production Deals were read/imported; the development import guard stays enforced. Full instructions and the remaining consent/provider-acceptance boundary are in [ZOHO_CRM_SETUP.md](docs/ZOHO_CRM_SETUP.md).

At 16:16 Dubai, the owner reported saving the callback setup. All three actual local OAuth-start calls returned 200; anonymous authorization-page requests returned 302 to Zoho sign-in. This does not prove callback/client acceptance after login. No app OAuth grant or completed-authorization audit was present at the status check. Complete the three **Authorize** flows from the local Admin browser and return through their callbacks; configuration and provider-console UPDATE alone do not create the application's tokens. Evidence: `.local/zoho-provider-preflight-20261027.json`. Financial reads/writes were not performed.
