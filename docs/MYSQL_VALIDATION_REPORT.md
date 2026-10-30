# Real MySQL implementation and executed validation

**28 October 2026 — local development acceptance completed. Production readiness is not established.**

Billing now runs on real MySQL 8.4.11 with company-scoped financial access. Manual bill entry, private attachments, independent approval/payment, restart persistence and the Hub job-billing read connection passed executed checks. The final Billing run passed **332 unit tests, 84 real-MySQL integration tests and 9 browser tests**. Both applications compiled successfully. Zoho and OCR provider behavior was tested with mocks; no live provider acceptance, deployment or production financial operation is claimed.

## Architecture, preservation and scope

Initial inspection found Next.js 16.4.3, Prisma 7.10.1 and PostgreSQL in Billing, including six existing PostgreSQL migrations. Hub already used native MySQL through its Express API and retained that architecture. Hub's production `.env`, existing database profiles and data directories were not used for this work.

The [migration plan](MYSQL_MIGRATION_PLAN.md) was written before switching the runtime. A source/configuration checkpoint with hashes was retained under `.local/mysql-transition-baseline-20261028/`; the original environment was separately saved to owner-only `.local/mysql-dev/original-postgres.env`. All eight original PostgreSQL schema/migration/lock files and the saved environment match their checkpoint hashes. The original `.local/postgres` directory and `.local/uploads` remain present, with no file modification timestamps after the checkpoint. There was no pre-change data-content hash inventory, so bytewise verification of those data directories is not claimed.

**Existing PostgreSQL records were not imported into MySQL.** The new database contains clearly labelled fictional companies, jobs, vendors and test bills. Original IDs/data remain in the preserved source database. A later real-data transfer needs reviewed company assignment, ID-preserving conversion, count/relationship checks, currency control totals and attachment-hash reconciliation. Restoring the original environment alone will not roll back the provider: restore compatible source/dependencies and regenerate the original PostgreSQL client as well.

No Git commit/push, hosting, DNS, HTTPS, production database or production accounting change was made.

## Actual server, accounts and schema

| Item | Verified result |
| --- | --- |
| Server | MySQL Community 8.4.11, Windows x64; dedicated loopback listener `127.0.0.1:3308` |
| Executable | Existing retained 8.4.11 executable reused; a new Billing-owned data directory was initialized. No server installation or existing Hub datadir reuse |
| Database | `voltronix_billing_dev`, utf8mb4, InnoDB, UTC server/session settings |
| Runtime user | `voltronix_billing_app`; table-scoped application DML, `AuditLog` SELECT/INSERT only; schema DDL, system-account-table access and global administration denied |
| Migration user | `voltronix_billing_migrate`; separate schema-scoped migration privileges |
| Private provisioning | Credentials/configuration retained under owner-only Windows ACLs, ignored by Git; no credential-bearing URLs printed |
| Connectivity and transaction checks | Actual application connection/read/write passed; rollback and denied-privilege checks passed |
| Metadata | 25 tables including Prisma history; 24 application tables; 232 columns; 27 enforced CHECKs; 31 foreign keys; 48 unique indexes including each table's primary key |

Applied migrations:

1. `202610280001_mysql_company_baseline`
2. `202610280002_hub_bridge_nonce`

Actual table names reported by this Windows MySQL instance:

```text
_prisma_migrations, auditlog, bill, billline, company,
companyintegrationdestination, document, hubbridgenonce, hubuserbinding,
integrationattempt, integrationcredential, integrationjob,
integrationoauthstate, job, loginattempt, ocrbatch, ocrdocument,
ocrtemplate, payment, session, syncrecord, user,
usercompanymembership, vendor, vendorbooksmapping
```

The schema preserves decimal financial values, invoice/payment uniqueness, independent approval and existing financial CHECK constraints. Composite foreign keys prevent a bill from using another company's vendor/job. Generated nullable keys reproduce PostgreSQL partial uniqueness for active OCR templates and legacy unscoped remote references. Identity comparisons use binary collation; human search fields use case-insensitive collation. MySQL DDL is not treated as transactionally reversible.

Evidence: `.local/mysql-dev/provisioning-receipt.json`, `migration-receipt.json`, `preservation-review.json`. The final schema-only verification uses SELECT/SHOW and records `runtimePrivilegesChanged=false`.

## Configuration and implementation changes

- One runtime `DATABASE_URL` contract now selects MySQL. Prisma configuration selects `prisma/mysql/schema.prisma` and its separate migration history. The runtime uses matching `@prisma/adapter-mariadb@7.10.1`; provisioning/tests use `mysql2@3.24.4`. Historical PostgreSQL files/dependencies remain for preservation and reviewed rollback, not simultaneous runtime support.
- Local setup/start/migration/test helpers pin the known workspace, loopback server UUID and datadir. Runtime credentials are separate from schema/test provisioning credentials. Test schemas and users are generated per run and removed in `finally` only after server/ownership checks.
- The local adapter pins this instance's RSA public key for fresh `caching_sha2_password` accounts. It does not enable arbitrary public-key retrieval. Production TLS/CA configuration remains a separate requirement.
- Login throttling uses an atomic MySQL upsert. OCR owner serialization uses a row lock. Financial mutations keep Serializable transactions. Queue claims use explicit ReadCommitted to prevent stale snapshots when two workers serialize on the same bill.
- Active company membership is required for bills, catalogs, reports, audits, documents, OCR and integration actions, including Admin access. Lists cover authorized companies, with optional filters; multi-company creation requires a selected company. No membership is inferred from an external organization label.
- New `CompanyIntegrationDestination` and `HubUserBinding` records make destination and cross-application identity assignments explicit. The fictional seed assigns only fictional provider identities. The two owner-configured Books profiles remain present privately but are not silently bound to demo companies.
- New MySQL uploads use `.local/mysql-uploads`, preserving original private storage. Provider networking, accounting write flags, integration test mode and OCR are disabled in the active local environment. Hub's connection defaults disabled outside the isolated acceptance tests.

The complete Billing path/hash inventory is in [MYSQL_CHANGED_FILES.md](MYSQL_CHANGED_FILES.md). Key groups include MySQL schema/migrations; database/auth/restore helpers; company authorization; financial/OCR services and forms; destination checks/queue/UI confirmation; Hub verifier/service/API; and unit/database/browser fixtures. `.env` changed privately; its contents are intentionally omitted.

Hub modified tracked files (13):

```text
.env.example
server/src/cli.ts
server/src/crm/router.ts
server/src/environment.ts
server/src/runtime/composition.ts
shared/contracts/src/index.ts
src/components/crm/job-details.tsx
tests/job-source-details-layout.test.ts
tests/zoho-import-readonly-layout.test.ts
tools/hub-environment.mjs
tools/hub-environment.test.mjs
tools/run-hub.mjs
tools/run-hub.test.mjs
```

Hub added files (10):

```text
docs/billing-bridge.md
server/scripts/billing-bridge-acceptance.ts
server/src/crm/billing/config.ts
server/src/crm/billing/client.ts
server/src/crm/billing/service.ts
server/tests/billing-bridge.test.ts
shared/contracts/src/billing.ts
src/app/api/jobs/[id]/billing/route.ts
src/components/crm/job-billing.tsx
tests/job-billing-layout.test.ts
```

The pre-existing untracked Hub `docs/express-api-contracts.md` was left untouched.

## Manual workflow and attachments

The real browser workflow signed in, selected the fictional company/vendor/job, entered lines and VAT, saved a bill with a private invoice, reopened and edited it, approved it with a second user and recorded payment. Server-side decimal calculations, headers/lines, due/payment terms, discounts, currency/tax validation, duplicates, concurrent submissions, rollback, foreign keys, company isolation, search/pagination and permission failures were exercised in unit/integration suites. The form retains corrections on validation/upload errors; attachment retry does not create a second bill.

PDF/JPEG/PNG size/signature validation, private metadata/storage and authorized access passed automated tests. These checks are not malware scanning. Desktop/mobile browser checks passed; the new-bill mobile screenshot was also inspected.

`node scripts/verify-mysql-restart.mjs` ran two actual optimized Next process lifetimes on dedicated local port 3010. It saved a labelled bill with total `26.25`, one line totaling `25.00`, a company assignment and a fictional PDF; after stopping/restarting only its owned process, all values and the downloaded PDF SHA-256 matched. It stopped its own server after verification. Evidence: `.local/mysql-dev/restart-verification/receipt.json`.

## Books and CRM results

Books supports separate configured destinations, scoped OAuth/vendor/account/tax/currency mappings, destination preview and explicit confirmation. A canonical bill is permanently bound to its first queued destination. Queue history, confirmed remote ID/time, failure state, retries, attachment serialization and unknown-outcome reconciliation persist in MySQL. Company/destination checks run before queueing and again in the worker; old snapshots without company/destination evidence fail closed. Cross-company access to consent, mapping, queue, retry/history and readiness was tested.

**All Zoho and OCR provider calls in these tests used mocks.** No OAuth callback, live vendor/account/tax mapping, sandbox bill creation, actual Zoho attachment or production accounting operation was verified. Discounts remain blocked for Books until the before-tax mapping is accepted; an existing different remote attachment is not overwritten. Two configured profiles and a passing mock do not establish access to either real organization.

Hub's CRM job-detail Bills and payments panel now reads Billing through a signed, bounded server-to-server contract. It reports recognized expense, gross payable, paid/outstanding, bill status, saved Books destination/status/remote ID/last sync time, CRM link status and fixed-origin Billing links. It does not create jobs or financial records and cannot form a write-back sync loop.

The implementation verifies the existing mapping: `Deals.JobDealNumber` identifies the job; `Amount` is contract value, not supplier expense. The bridge reuses the stored active CRM Deal identity plus job number. Hub checks the current session, dashboard permission and assignment; Billing separately checks immutable user binding, active finance role, active company membership and the exact CRM destination. Thirty-second signed claims and durable nonce uniqueness reject replay. Details are capped at 100 bills with count/truncation; approved totals include all matching bills.

Actual acceptance used separate real Billing and native Hub MySQL schemas. Hub's fixture applied its existing five migrations: **42 tables and 55 triggers**, with native restricted runtime grants. Seven recorded HTTP checks passed: anonymous denied, native login/CSRF, authenticated job detail, actual Hub API to Billing API, other-assignee denied, unlinked job with no bills, and current assignment revocation. Billing additionally tested replay, wrong company/destination/deal/user, revoked memberships and bounded results.

Evidence: `.local/mysql-dev/hub-fixtures/8e1b7bef-ad62-4caf-9951-09490b609d62/acceptance-result.json`. This exclusively claimed fictional Hub fixture is retained for inspection. The full Hub browser login/navigation journey against that fixture was not run: its API journey, isolated frontend panel checks and production source compilation were tested separately. Real-host TLS, real staff mappings and provider acceptance remain unverified. See [the bridge setup](HUB_BILLING_BRIDGE.md).

## Executed checks

| Check | Final actual result |
| --- | --- |
| Billing lint | PASS, full `npm run lint` |
| Billing types | PASS, `next typegen` and `tsc --noEmit` |
| Billing unit suite | **332/332**, 21 files |
| Billing real MySQL suite, native Hub fixture enabled | **84/84**, 8 files, no skips; migrations and owned schema/account cleanup passed |
| Billing Edge browser suite | **9/9** against local MySQL; real manual workflow; Books/OCR provider flows explicitly mocked |
| Billing optimized build | PASS, Next 16.4.3 Turbopack, 35 static pages and dynamic API routes |
| Billing release privacy scan | PASS, **930 files**, no configured secrets/private runtime paths |
| Dependency audit | PASS, **0 vulnerabilities** reported by npm audit |
| Application restart | PASS, bill/line/company/attachment metadata and byte hash |
| Integration environment inventory | PASS, local fixture recognized; provider network/write/test/OCR flags disabled |
| Hub bridge unit tests | **5/5** |
| Hub launcher/environment tests | **49/49** |
| Hub layout/source tests | **3/3**: mobile billing panel, existing job source details and Zoho import read-only layout |
| Hub types/build | Contracts, server and web types PASS; server emit PASS; isolated Next webpack production build PASS, 8 static pages |
| Hub native API acceptance | **7 recorded checks passed**, included in Billing's 84-test suite |

Final database evidence: `.local/mysql-dev/test-runs/16664_1793174116710/`. Hub isolated build log: `.local/hub-build-20261028-bridge/isolated-next-build.log`. Browser screenshots are ignored under `.local/screenshots`; traces containing login details are disabled.

Errors found and resolved during execution: fresh MySQL account RSA authentication, missing destination fixtures that intercepted earlier test assertions, a stale development process still holding the old PostgreSQL client, a company-selector test locator, missing company context in unit mocks, the real concurrent-worker snapshot race, and a misleading verify-only command that previously re-granted privileges. The final runs above passed after the corresponding fixes. No failing assertion was removed to obtain a pass.

## Reproduce

From this already provisioned Billing workspace, using its existing private environment:

```powershell
cd G:\bills.voltronix.ae
npm ci
npm run db:local
npm run db:generate
npm run db:migrate
node scripts/mysql-migrate.mjs --verify-only
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:e2e
npm run build
npm run check:release
node scripts/verify-mysql-restart.mjs
npm audit --audit-level=low
npm run check:integrations
```

Ordinary integration runs skip the optional native Hub database case unless its fresh fixture path is supplied. To reproduce all 84 tests with the sibling Hub repository/dependencies present, create a **new** fixture, then use the returned fixture ID (the previously claimed one cannot be reused):

```powershell
node --import=tsx scripts/hub-mysql-fixture.mjs setup
# Replace NEW-UUID below with the fixtureId printed by setup; do not print private files.
$env:HUB_BRIDGE_MYSQL_FIXTURE = 'G:\bills.voltronix.ae\.local\mysql-dev\hub-fixtures\NEW-UUID\acceptance.json'
npm run test:integration
Remove-Item Env:HUB_BRIDGE_MYSQL_FIXTURE
```

Safe Hub checks executed directly without its environment-loading launcher:

```powershell
cd G:\hub.voltronix.ae
node node_modules/typescript/bin/tsc -p shared/contracts/tsconfig.json
node node_modules/typescript/bin/tsc -p tsconfig.server.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.server.build.json
node --import tsx --test server/tests/billing-bridge.test.ts
node --test tools/run-hub.test.mjs tools/hub-environment.test.mjs
node --import tsx --test tests/job-billing-layout.test.ts tests/job-source-details-layout.test.ts tests/zoho-import-readonly-layout.test.ts
```

Hub's normal build launcher reads its production environment, so it was not used. The actual frontend build ran in a source-only copy under Billing's ignored `.local/hub-build-20261028-bridge`, with no `.env`/private assets and explicit disabled database/provider settings. Do not run the normal Hub launcher merely to reproduce this task's source-only build.

No reusable source-copy helper was added. The retained copy's `BUILD-SNAPSHOT.json` records its source, exclusions, dependency junction and build command. The following reproduces the build of that retained snapshot with the same explicit child-process environment; it does not refresh the copy from subsequent Hub edits or load Hub's root environment:

```powershell
cd G:\bills.voltronix.ae
@'
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
const target = String.raw`G:\bills.voltronix.ae\.local\hub-build-20261028-bridge`;
const snapshot = JSON.parse(readFileSync(target + '/BUILD-SNAPSHOT.json', 'utf8'));
if (snapshot.owner !== 'billing-bridge-isolated-build' ||
    readdirSync(target).some(name => name.toLowerCase().startsWith('.env'))) {
  throw new Error('Expected the retained isolated source snapshot without environment files.');
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|HOME|USERPROFILE)$/i.test(key)));
Object.assign(env, {
  NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
  CRM_FRONTEND_BACKEND: 'express', CRM_EXPRESS_ORIGIN: 'http://127.0.0.1:39989',
  APP_ORIGIN: 'http://127.0.0.1:39990', CRM_API_INSTANCE_ID: 'hub-build-fixture',
  CRM_DATABASE_MODE: 'disabled', CRM_MYSQL_NETWORK_DISABLED: '1',
  ZOHO_ENABLED: 'false', ZOHO_SYNC_ENABLED: 'false', ZOHO_NETWORK_DISABLED: '1',
  BILLING_BRIDGE_ENABLED: 'false', BILLING_BRIDGE_SECRET: '',
});
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'build', '--webpack'],
  { cwd: target, env, windowsHide: true, stdio: 'inherit' });
child.on('error', () => { process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
'@ | node --input-type=module
```

## Remaining blockers and limits

1. **Real provider acceptance:** reviewed nonproduction Books account, per-company organization/vendor/account/tax/currency mappings, OAuth consent, separately authorized write window and reconciliation/attachment acceptance. OCR also needs approved provider credentials and representative redacted invoices.
2. **Real company and Hub provisioning:** reviewed memberships, destination assignments, immutable Hub user bindings and matched CRM observations. The connection is implemented and tested but disabled outside fixtures; company administration UI is not supplied.
3. **Existing-data conversion, if required:** the PostgreSQL dataset is preserved, not migrated. No production data cutover is authorized or tested.
4. **Production operations:** operated MySQL with tested TLS/CA handling, staging migration procedure, HTTPS/rate limits, private durable storage, malware/quarantine/retention, managed secrets, supervised workers, monitoring and load/multi-process acceptance.
5. **Recovery:** a coordinated MySQL/private-file backup and full restore drill has not been performed. Restart persistence and verifier tests do not substitute for that drill.
6. **Accounting limits retained:** one job/currency per bill, one bill-level VAT rate, no credit notes/reversals/FX consolidation or payment export; Books discounted-bill and different-attachment behavior remain gated.

These are deployment/provider/data acceptance requirements, not hidden test passes. See [current deployment status](../DEPLOYMENT.md). Production hosting and production data were not modified.
