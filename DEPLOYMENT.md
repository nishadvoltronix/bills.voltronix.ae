# Deployment and recovery status

**Current release scope — typed manual entry with Zoho Books sync (29 October 2026):** follow [the release runbook](docs/MANUAL_DEPLOYMENT.md). The production template keeps `MANUAL_ENTRY_ONLY=false`; Books authorization, operational company/accounting verification and the sync worker are required. OCR/scanner intake and CRM lookup remain optional. `web check` / `npm run check:sync` inventory the intended workflow; [current provider/host evidence](docs/BOOKS_PRODUCTION_VERIFICATION.md) records its remaining blockers. Production posting and host acceptance remain pending.

The owner confirmed **https://bills.voltronix.ae** as this project's future deployment destination on 28 October 2026. This records the intended host; it does not indicate that the billing application has been deployed there.

The hosted instance must use `APP_URL="https://bills.voltronix.ae"`. Its Zoho Books OAuth callback is `https://bills.voltronix.ae/api/integrations/oauth/zoho/callback`, which must be registered exactly with the OAuth client. The local development instance keeps `APP_URL="http://127.0.0.1:3000"` and its separate loopback callback; authorization must return to the same application origin and authenticated Admin session that initiated it. Hosting management/access and the target runtime remain to be identified before deployment.

## Current deployment check — 29 October 2026

The owner requested real Books synchronization for both VOLTRONIX CONTRACTING LLC and VOLTRONIX SWITCHGEAR LLC 1 and clarified that the application should run on their own server, with the domain connected through Cloudflare. The immediate priority is server-side Zoho authorization and refresh-token storage. A public HTTP check found the existing Coming Soon page at `/` (200) and no application login at `/login` (404). No hosting settings or provider financial records were changed.

This checkout requires a Node runtime, MySQL, persistent private invoice storage and a separately supervised synchronization worker. The [deployment package](deploy/README.md) now supplies an own-server Node deployment behind Cloudflare, with runtime secrets, verified database TLS, persistent uploads and a supervised queue worker. Linux Docker templates and native Windows service guidance are included; Docker execution, the actual production database and authenticated domain routing remain unverified. No Workers migration is required for the selected own-server architecture. See [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/).

`npm run check:sync` now inventories runtime, credential metadata, company/destination verification and supplier/job mappings without provider requests or database writes. The local check found neither organization has a stored OAuth grant or configured bootstrap token/accounting mapping. Their current workspaces are demo connection-check containers, not operating companies. Both require provider authorization, verified accounting configuration and real company records on the production backend before posting. Do not convert these local containers or development data into a live ledger.

The manual form now reports company synchronization readiness and unsupported discounts before saving, and distinguishes local saving, queued synchronization and confirmed Books results afterward. Pending status refreshes without discarding an open form. Validation for these changes: 537 unit tests, 14 focused browser checks, lint, typecheck, production build and release privacy scan passed. Provider responses in browser synchronization tests were mocked; the local manual save/attachment tests used fictional development bills. No real synchronization or deployment was completed by those checks.

The subsequent own-server/OAuth setup work adds verified MySQL TLS, disabled real-company preparation, an Admin-only authorization link, read-only accounting catalog discovery and provider-backed destination verification. Current validation: 629 unit tests; 122 database integration tests passed with one skipped; 28 isolated browser tests passed with one provider-network case skipped; all three operator authorization browser tests passed separately against localhost with consent responses mocked. Lint, typecheck, production build and a privacy scan of 977 build files passed. A separate public authorization-page preflight reached Zoho Accounts without submitting login or consent; it did not obtain a token or establish account access. Production container execution and hosting changes have not been performed. User-completed consent and actual provider/runtime acceptance remain required.

Subsequently, the owner completed separate consent for both Contracting (`828765858`) and Switchgear (`802911060`), and both encrypted scoped grants were stored. A fresh check made eight authenticated Books GET requests, verifying each active organization and retrieving its accounting catalog. No provider financial writes or production deployment occurred; [connection evidence and remaining boundaries](docs/BOOKS_OPERATIONAL_SETUP.md) distinguish these successful connections from live bill synchronization.

The active application uses MySQL. **Save and sync** finalizes bills as `READY` and queues their exact company destination without a separate approval or preview confirmation. The guarded production branch remains disabled locally; connection-check demo workspaces cannot post even after OAuth consent. See [setup](docs/LIVE_SYNC_SETUP.md) and [current validation/status](docs/APPROVAL_FREE_SYNC_VALIDATION.md); [the earlier live-sync report](docs/LIVE_SYNC_VALIDATION_REPORT.md) is historical. No deployment, DNS, hosting, HTTPS or production data change was performed, and no provider financial write has occurred.

The subsequent production-setup pass identified the owner's existing Ubuntu server and confirmed SSH reachability, but deployment authentication is still pending. The new `books:suppliers` operator command verifies exact active supplier IDs and creates local suppliers/mappings atomically, with company/currency checks, idempotence and duplicate-name protection. All 687 unit tests, full lint and TypeScript checks passed; the deployment command and Docker build allowlist include this operator. Complete read-only supplier catalogs and disabled mapping/import drafts are retained privately under `.local/books-setup`. These preparations do not mean the application or worker has been deployed or live posting enabled.

The [MySQL validation report](docs/MYSQL_VALIDATION_REPORT.md) records executed checks. The [migration plan](docs/MYSQL_MIGRATION_PLAN.md) describes preservation and development rollback. The original PostgreSQL runbook is retained as [historical documentation](docs/POSTGRES_DEPLOYMENT_ARCHIVE.md); its PostgreSQL commands must not be used for the active MySQL application.

## Reproduce local validation

Use the existing ignored environment and private provisioning files. Do not substitute a production URL.

~~~powershell
npm ci
npm run db:local
npm run db:generate
npm run db:migrate
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:e2e
npm run build
npm run check:release
node scripts/verify-mysql-restart.mjs
npm audit
~~~

The local migration/test helpers validate this workspace's server UUID, data directory and loopback listener. Integration tests provision and remove only their own disposable schemas and identities. Browser/restart checks retain clearly labelled fictional development bills. Hub acceptance uses a separate newly provisioned native MySQL fixture; see the validation report. These helpers are deliberately unsuitable for remote deployment.

## Work required before an authorized staging release

1. Select an operated MySQL service, supported runtime, persistent private storage, HTTPS reverse proxy and restricted service identities. Validate MySQL TLS/CA verification in the Prisma adapter; the current development connection parser does not accept URL overrides or implement a remote TLS configuration contract.
2. Review a target-specific migration procedure with separate schema owner/runtime/backup identities. Preserve CHECK constraints, company foreign keys, generated uniqueness keys, exact decimals and append-only application audit access. MySQL DDL is not transactionally reversible. Existing PostgreSQL data needs an explicit ID-preserving conversion with reviewed company assignments and reconciliation; no such data import occurred here.
3. Provision actual company memberships, destination assignments and Hub user bindings from approved evidence. The fictional seed must never serve as a production company map. The current release has no company-administration UI.
4. Provide managed secrets and key recovery, HTTPS/cookie/origin checks, network rate limits, malware scanning/quarantine, document retention and production ACLs. Exclude demo credentials, test data, local databases and private source files from artifacts.
5. Supervise the application and enabled OCR/sync workers. `npm run worker:sync -- --watch --limit=5` runs new queued operations, including configured production operations, with current writer/company/runtime checks before provider writes. Historical production jobs without an initiating user retain exact `--job-id` execution and their original permissions. Test resource limits, graceful shutdown, queue-age/error alerts, authentication monitoring, database/storage capacity and provider cost limits. Complete realistic load and multi-process acceptance testing.
6. Verify provider consent and accounting mappings under separately authorized acceptance. Sandbox tests retain their nonproduction authorization. Production additionally requires a restricted operational database, HTTPS production runtime, verified real company and exact destination configuration, a finalized bill, current writer access and intact source attachments. There is no separate per-bill approval/confirmation. Ordinary tests use mocks. A successful local build or OAuth consent does not satisfy these gates; see [LIVE_SYNC_SETUP.md](docs/LIVE_SYNC_SETUP.md).

## Backup and recovery acceptance still required

Database rows and private document bytes form one dataset. This includes imported `BooksBill` history, `BooksBillAttachment` metadata and every downloaded original in the private upload directory, as well as locally authored bills/documents. Choose compatible MySQL backup tooling and a protected destination, pause writers/workers/importers for a coordinated filesystem boundary, record row counts, per-currency control totals, migration identity and document hashes, then encrypt and retain an off-host copy. An earlier database-only backup predating the Books-original attachment table cannot restore those newer originals. No production backup or full MySQL backup/restore drill was run in this task.

A restore drill must use a new disposable loopback schema and separate private directory, integrations disabled, and trusted backup input. The read-only verifier supports guarded MySQL restore targets through RESTORE_DATABASE_URL, RESTORE_UPLOAD_DIR, expected counts and ALLOW_RESTORE_VERIFICATION=true. It does not create or restore a database. URL query overrides/fragments are rejected.

Supply all four expected counts from the coordinated **source** manifest: `RESTORE_EXPECTED_BILLS`, `RESTORE_EXPECTED_DOCUMENTS`, `RESTORE_EXPECTED_BOOKS_BILLS` and `RESTORE_EXPECTED_BOOKS_ATTACHMENTS`. The last two count imported history rows and downloaded-original rows respectively, not source document names awaiting download. Supply explicit `0` only when that dataset is absent from the source manifest; missing or blank counts fail verification. Never obtain the expected counts from the restored target, because that would conceal omitted tables or files.

~~~text
npm run backup:verify
~~~

Compare all financial/company relationships, totals, audit history and attachment hashes against the coordinated source manifest, record recovery time, and reconcile uncertain external operations before starting workers. Passing unit tests for the verifier is not proof of a completed restore drill.

The verifier reports `booksBills`, `downloadedBooksOriginals` and `unreadableOrAlteredBooksOriginals` separately from native bill/document checks. It verifies SHA-256 and byte length for every stored native document and Books original; a missing or changed file prevents `passed=true`. Native subtotal/payment invariants apply only to locally authored bills; imported Books balances, discounts and credits retain provider semantics. A matching backup can contain a partial provider download: restore verification does not certify that every original in Books has been downloaded.

Rollback of the development provider switch requires restoring the checkpoint source/configuration/dependencies and original environment, regenerating the PostgreSQL client, and reconnecting to the retained original database. Changing DATABASE_URL alone is insufficient. Never erase uncertain sync history or reset an existing database to force success.
