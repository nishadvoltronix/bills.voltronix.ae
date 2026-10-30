# Manual bill entry and automatic Zoho updates — 30 October 2026

The release includes typed invoice entry followed by **Save and sync** to the selected company's Zoho Books organization, plus a separate incoming worker for Books bills and CRM jobs. OCR and scanner intake remain disabled. Keep `MANUAL_ENTRY_ONLY=false`; `true` intentionally disables provider synchronization and is only for a separate local-ledger deployment.

**Prepared existing-data handoff:** use [DATA_TRANSFER.md](DATA_TRANSFER.md) and [the current deployment handoff](../deploy/README.md) for the prepared MySQL credentials, scoped Zoho bootstrap grants, fresh Admin and validated business-data import. The initial provisioning steps below describe a new installation without that bundle; do not repeat them over an imported target. Accounting and posting-acceptance requirements still apply.

Prepared profiles use AED and `lineSelectionRequired: true`: select a valid Books expense account and tax for every line, and the real supplier for that company. This replaces section 3's global-default mapping workflow for the prepared handoff. Use its separate `.env.accounting` and `books:activate` command for hosted organization/currency/destination verification; offline import stays isolated from the enabled runtime.

Saving persists the draft and original attachment, then finalizes the bill and queues the verified Books destination. The supervised sync worker must complete the provider operation. Verify the confirmed Books ID and attachment completion; saved or queued status is not provider acceptance. Payment recording remains separate.

Current provider evidence and remaining host blockers are recorded in [Books production verification](BOOKS_PRODUCTION_VERIFICATION.md) and [incoming synchronization](INCOMING_SYNC.md). The local incoming worker has been validated and started; hosted production provisioning, supervision, and acceptance remain manual and unverified.

## 1. Prepare the production host

Use the [deployment package](../deploy/README.md) for operational MySQL, separate migration/runtime identities, verified TLS, persistent private storage and HTTPS routing. The origin is `https://bills.voltronix.ae`. Docker execution and actual host acceptance have not been performed by the local tests.

On the target host, run `npm run deploy:prepare` to create protected `deploy/.env.production` and `deploy/.env.migration` without overwriting existing files. It generates a fresh encryption key and reports missing inputs without printing secrets. Fill the production database identities, Zoho credentials/profiles and incoming operator privately, then run `npm run check:deploy`. Do not change the local `.env` URL to the hosted domain: the hosted services read their separate production file. Its setup phase selects:

```dotenv
MANUAL_ENTRY_ONLY=false
INTEGRATION_NETWORK_ENABLED=true
ZOHO_BOOKS_NETWORK_ENABLED=true
ZOHO_CRM_NETWORK_ENABLED=true
ZOHO_BOOKS_WRITE_ENABLED=false
ZOHO_BOOKS_LIVE_ENABLED=false
ALLOW_PRODUCTION_ACCOUNTING_WRITES=false
INTEGRATION_TEST_MODE=false
OCR_PROVIDER=disabled
SCANNER_IMPORT_ENABLED=false
HUB_BRIDGE_ENABLED=false
INCOMING_SYNC_ENABLED=true
INCOMING_SYNC_INTERVAL_SECONDS=60
INCOMING_SYNC_RECONCILE_SECONDS=86400
INCOMING_SYNC_MAX_REQUESTS=40
INCOMING_SYNC_ATTACHMENTS_ENABLED=true
```

Configure the exact Books data center, OAuth client, dedicated encryption key and separate organization profiles privately. CRM reads additionally require `ZOHO_CRM_DC`, `ZOHO_CRM_ORGANIZATION_ID`, `ZOHO_CRM_ENVIRONMENT=production`, its client credentials, read authorization and verified `ZOHO_CRM_MAPPING_JSON`. Configure a protected active Admin account for the incoming worker through `INCOMING_SYNC_OPERATOR_EMAIL` / `INCOMING_SYNC_OPERATOR_PASSWORD`. The template supplies no real credentials, source assignments or accounting choices. Do not copy development `.env`, seed credentials, demo records or connection-check workspaces into production. Both Books write flags stay false during setup; the legacy `ALLOW_PRODUCTION_ACCOUNTING_WRITES` deny switch always stays false.

If an older attachment downloader is still active, keep `INCOMING_SYNC_ATTACHMENTS_ENABLED=false` until its coordinated handoff. Preserve known source cooldowns and the private progress-file configuration described in [INCOMING_SYNC.md](INCOMING_SYNC.md#original-files-and-quota-coordination).

Build and migrate using the separate migration credentials described in the package, then start web/proxy for controlled setup:

```sh
docker compose -f deploy/compose.yaml config --quiet
docker compose -f deploy/compose.yaml build web
docker compose -f deploy/compose.yaml --profile tools build migrate
docker compose -f deploy/compose.yaml --profile tools run --rm --no-deps migrate
docker compose -f deploy/compose.yaml up -d web proxy
```

Use the private-CA override on every invocation when required, including all workers. Outgoing sync, incoming sync and job history are normal deployment services; defer their startup until the respective setup steps are complete. OCR remains an opt-in profile. Preserve existing databases and invoice volumes.

## 2. Prepare each exact company and authorization

Create the initial Admin through `web operator user:create` with the protected `ALLOW_USER_PROVISIONING` / `NEW_USER_*` contract in the deployment package. Remove temporary credentials after every operation.

For each organization, run the operational `company:prepare` workflow. Privately supply `ALLOW_OPERATIONAL_COMPANY_SETUP=true`, active Admin `ACCOUNT_OPERATOR_EMAIL` / `ACCOUNT_OPERATOR_PASSWORD`, and exact `COMPANY_SETUP_NAME`, `COMPANY_SETUP_ORGANIZATION_ID` and reviewed `COMPANY_SETUP_REFERENCE`.

```sh
docker compose -f deploy/compose.yaml run --rm --no-deps web operator company:prepare
```

The name must match the configured organization profile. This creates the real company, operator membership and disabled Books destination. For each existing active staff account, additionally supply `COMPANY_SETUP_MEMBER_EMAIL` and rerun the same command: it grants or reactivates that exact company's membership with an audit record and preserves the user's role and destination verification. The operator must already have access when reusing a company. `company:prepare-manual` creates a separate local-ledger company and must not be used for this Books setup.

Authorize every organization through `/account/books-authorization` or the protected `books:authorize` operator. Register exactly `https://bills.voltronix.ae/api/integrations/oauth/zoho/callback`, returning to the same hosted Admin session. Local encrypted grants do not establish grants in a fresh production database. Organization-scoped bootstrap refresh tokens follow [server integration setup](SERVER_INTEGRATION_SETUP.md).

## 3. Verify accounting and suppliers with writes disabled

Follow [Books operational setup](BOOKS_OPERATIONAL_SETUP.md). Each command requires its explicit temporary enablement, Admin credentials and exact company/organization inputs:

```sh
docker compose -f deploy/compose.yaml run --rm --no-deps web operator books:catalog
docker compose -f deploy/compose.yaml run --rm --no-deps web operator books:suppliers
docker compose -f deploy/compose.yaml run --rm --no-deps web operator books:verify-live
```

The catalog reads organization, account, currency and tax metadata. The accounting owner must review and select the mapping for each company. Supplier setup rereads explicitly selected supplier IDs and creates their exact local mappings. `books:verify-live` verifies provider metadata and records local destination proof; it makes no supplier-bill POST and changes no global write flags. Its success does not prove invoice acceptance.

Use verified CRM jobs or actual local jobs with matching currencies. CRM incoming reads require the separately verified source and company bindings in the next step. Demo jobs/vendors cannot be used for live posting. Nonzero discounts and unsupported tax/accounting cases remain blocked from Books synchronization even when local saving is possible.

Run `docker compose -f deploy/compose.yaml run --rm --no-deps web check`. Both `web check` and `web check:sync` run the sync-readiness inventory. `LIVE_WRITES_DISABLED` is expected during setup; resolve the other runtime, OAuth, mapping, company, supplier and job blockers. `CONFIGURATION_PRESENT_UNVERIFIED` means inventory checks passed, not provider acceptance. This inventory makes no provider request or financial write.

## 4. Start incoming Books and CRM reads

Follow [CRM source setup](ZOHO_CRM_SETUP.md) and [incoming worker configuration](INCOMING_SYNC.md). With writes still disabled, run `web operator crm:prepare` once for each operational company using the exact `CRM_SETUP_COMPANY_ID`, `CRM_SETUP_BOOKS_ORGANIZATION_ID`, `CRM_SETUP_ORGANIZATION_ID`, reviewed `CRM_SETUP_REFERENCE`, and temporary `ALLOW_CRM_OPERATIONAL_SOURCE_SETUP=true`. This creates the company source binding; it does not verify provider access. Authorize the exact CRM organization through `/account/crm-authorization` with the hosted callback `https://bills.voltronix.ae/api/integrations/oauth/crm/callback`. The active Admin worker account needs current membership in each Books company and every active company sharing a CRM source. Hosted source bindings and grants must be established in the hosted database; local verification does not provision them there.

`web check:sync` now includes incoming configuration, the configured worker Admin/password and memberships, Books destination identity, shared CRM source bindings and the separate CRM grant metadata. Both worker statuses remain `NOT_CHECKED`: this read-only inventory does not start workers or prove provider scopes, token decryption or successful delivery.

With the source read gates and `INCOMING_SYNC_ENABLED=true`, start the incoming supervisor. Books financial-write flags may remain false during this acceptance:

```sh
docker compose -f deploy/compose.yaml up -d --force-recreate web proxy incoming
docker compose -f deploy/compose.yaml logs --tail=50 incoming
```

Check the dashboard's **Incoming Zoho updates** panel as an authorized reader. Confirm a recent worker heartbeat, correct company-scoped sources, and a successful automatic check for each source that is currently permitted to run. A source waiting for quota must retain its pending state and earliest retry; do not bypass it or treat the scheduled retry as completion. Original-file coverage is separate. The default cadence is 60 seconds between completed checks, with daily reconciliation and provider backoff retained. The visible dashboard reads saved status every five seconds without calling providers.

Before starting job history, apply the project-association migration, verify its required source permissions and import the initial complete verified association evidence as described in [automatic verified project history](../deploy/README.md#automatic-verified-project-history). It uses the protected incoming operator account and refreshes existing associations; it does not discover missing relationships. Once those prerequisites are complete, start it and check its refresh status:

```sh
docker compose -f deploy/compose.yaml up -d job-history
docker compose -f deploy/compose.yaml logs --tail=50 job-history
```

## 5. Enable the verified Save and sync workflow

After destination verification and removal of temporary setup inputs, change these enablement values in the protected production environment:

```dotenv
ZOHO_BOOKS_WRITE_ENABLED=true
ZOHO_BOOKS_LIVE_ENABLED=true
```

Keep `MANUAL_ENTRY_ONLY=false`, the Books and CRM read gates true, `ALLOW_PRODUCTION_ACCOUNTING_WRITES=false` and test mode false. Incoming synchronization does not change these outgoing write requirements. Restart the services and start the outgoing worker with the same verified configuration:

```sh
docker compose -f deploy/compose.yaml up -d --force-recreate web proxy sync incoming job-history
docker compose -f deploy/compose.yaml run --rm --no-deps web check
docker compose -f deploy/compose.yaml ps
```

Run `npm run check:deploy:posting` on the host to check the completed files and both posting flags without changing configuration. A successful offline check means configuration is present, not that a bill was accepted by Zoho.

Native Windows hosting must supervise web, `scripts/integration-worker.ts --watch --limit=5`, `scripts/incoming-sync-worker.ts --watch` and `scripts/job-history-worker.ts --watch` with the protected production environment. A browser request does not start these workers. Follow the exact Node commands in the [deployment package](../deploy/README.md#existing-windows-server).

## 6. Accept the actual production workflow

1. Verify login/logout and company/record/document access for the intended users.
2. Enter a real authorized invoice for the correct company, verified supplier and actual job. Check dates, currency, payment terms, account/tax mapping and original before **Save and sync**.
3. Confirm one canonical operation, its confirmed bill ID in the correct Books organization, and attachment completion. `READY`, `PENDING`, local save success or OAuth consent alone do not prove posting.
4. Retry interrupted uploads on the same draft. Bill detail now exposes recovery for Admin/Accounts users: **Retry Zoho Books sync** requeues an eligible failed operation, while an uncertain outcome offers **Reconcile Zoho Books outcome** for reconciliation. Reconcile an unknown provider outcome before retrying; never create a replacement bill or switch its destination. Attachment operation status is reported separately from bill creation.
5. Restart web and all three workers; verify records, originals, incoming checkpoints, project-association evidence and outgoing queue state persist, with no duplicate provider bill or unintended payment. Verify scoped incoming last-success/backoff and job-history refresh status separately from outgoing delivery.
6. Verify coordinated database/document backups and a separate restore drill. Include imported Books history, `BooksBillAttachment` rows and their private original bytes; an older database-only backup cannot restore newer downloads. Supply `RESTORE_EXPECTED_BILLS`, `RESTORE_EXPECTED_DOCUMENTS`, `RESTORE_EXPECTED_BOOKS_BILLS` and `RESTORE_EXPECTED_BOOKS_ATTACHMENTS` from the coordinated source manifest to `npm run backup:verify`. All four counts are required; use explicit zero only for a source dataset with no records. The verifier checks every stored original's SHA-256 and byte length, reports Books originals separately, and fails for missing/changed bytes or count mismatches. A partial provider download can still be backed up correctly; this check does not claim complete provider coverage. See [the recovery contract](../DEPLOYMENT.md#backup-and-recovery-acceptance-still-required). Retain image/migration identity and rollback instructions; monitor failed/uncertain operations, worker health and queue age.

## Validation boundary

Earlier local-only checks passed 1,093 unit/route tests, 167 MySQL integration tests (1 skipped), two browser workflows, an optimized build, release privacy scan and a real application-restart persistence check. Those browser workflows used `MANUAL_ENTRY_ONLY=true` and fictional data: they prove local recording only, not Zoho posting or production-host acceptance.

The incoming release subsequently passed **1,270 unit tests, 229 disposable-MySQL integration tests with one skip, 23 isolated browser checks, and the 50-page production build**. Its first live incoming check completed for Switchgear and CRM while respecting Contracting's known quota pause. A hidden local watch process now owns the original-file continuation after a verified handoff. See [the dated incoming receipt](INCOMING_SYNC.md#verified-local-run--29-october-2026) for source counts and pending coverage. This evidence does not establish hosted deployment, service recovery after reboot, or outgoing financial posting acceptance.

`npm run check:manual` / `web check:manual` remain available only for a deliberately separate local-ledger deployment. They cannot approve this Save and sync release. Development credentials, write settings and historical company/provider records are preserved; the local `MANUAL_ENTRY_ONLY=false` setting is now explicit.
