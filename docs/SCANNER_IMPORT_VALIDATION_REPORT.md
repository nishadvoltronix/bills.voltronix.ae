# Scanner-to-Billing import: executed validation

28 October 2026. Implemented and validated locally in `G:\bills.voltronix.ae`. **The office scanner is not activated, and a live share-to-Azure acceptance test has not passed.** The current blockers are authenticated UNC access, Azure endpoint/key and explicit real-company assignment.

Subsequent owner clarification keeps this phase limited to synthetic invoices in isolated folders for both fictional companies, with no real-invoice assignment and no live Zoho writes. Company selection must be explicit or backed by a verified source assignment after real company-to-organization mapping is established. Current scanner sources each bind one configured company; a mixed-company unassigned inbox with per-invoice reassignment is not implemented. See the [confirmed development scope](SCANNER_IMPORT_SETUP.md#confirmed-development-scope). This clarification changes the operating plan, not the test results recorded below.

## Inspection before implementation

PowerShell drive metadata, Win32 logical-disk metadata and SMB mapping independently reported `Y:` as `\\192.168.60.10\Nishad_Scan`. The mapping reports **Disconnected**. TCP port 445 was reachable, but opening the UNC directory failed with `ItemNotFoundException`; file permissions and actual scanner contents were not verified. No office scanner file was read, changed, moved or deleted.

The inspected Node/Next application runs on this Windows machine at `127.0.0.1:3000`; MySQL 8.4.11 listens at `127.0.0.1:3308`. No hosted application's identity or share access was assumed. The existing Azure service, private attachment store, durable OCR worker, company authorization, human review and independent bill approval were reused. The pre-change milestone was 355 unit, 93 MySQL and 12 browser tests; see [the prior OCR report](AZURE_OCR_VALIDATION_REPORT.md) and [scanner inspection findings](SCANNER_IMPORT_FINDINGS.md).

## Implemented behavior

1. A separate Windows polling worker reads one configured folder, waits for unchanged metadata across observations, obtains a read-only Windows handle excluding writers, checks the PDF ending and rechecks metadata around its bounded read. Originals stay in place. The first successful scan skips historical files by default; intentional sample/backlog intake uses an explicit initial `--include-existing` option.
2. A protected local journal persists observations, retry times and opaque filename digests. An exclusive OS lock prevents simultaneous use and releases after a crash. A missing initialized journal, corruption or changed source binding stops processing instead of silently resetting the baseline. Network/API failures back off; late timed-out SMB results are discarded.
3. The worker sends PDF bytes and SHA-256 over a dedicated authenticated API. Its token grants intake for one fixed source/company/upload identity. It has no database password, Azure key or staff login. Requests reject browser cookies/origins, redirects, wrong host/origin, invalid hashes, inactive sources/users/companies and revoked membership. HTTPS is required outside explicit local development/test loopback.
4. New MySQL `ScannerSource` and `ScannerImport` records hold hashed credentials, source/hash uniqueness, import disposition and links to existing OCR/document records. A company-level intake lock serializes scanner/manual OCR races. The receipt and OCR handoff commit together. Repeated bytes, renamed copies and retries after a lost HTTP response do not create a second OCR document. OCR processing status remains in the existing `OcrDocument` lifecycle.
5. The existing private original and Azure OCR queue are used. Missing credentials produce visible `FAILED / NOT_CONFIGURED` OCR records, not invented extraction or automatic bills. After configuration is repaired, staff retry that retained document through the existing OCR action. Accepted files are not endlessly reuploaded by the folder worker.
6. Dashboard attention shows queued, review-required and failed OCR counts. The review queue shows scanner source labels, refreshes while idle and supports older/newer pages. Extracted invoices await human verification; confirming review creates an unpaid draft. Existing submission, independent approval and gated Zoho synchronization remain separate. Authorized, explicit failed-OCR manual recovery remains available and is audited as manual recovery.
7. A guarded local Admin CLI creates a disabled source and dedicated non-loginable `DATA_ENTRY` identity, enables/disables it and rotates its token. It writes the raw token only to an owner-protected worker configuration and stores only the hash in MySQL. No Windows account, scheduled task or service was installed.

Key files: `scripts/scanner-worker.ts`, `scripts/lib/scanner-worker.ts`, the two Windows helper scripts, `scripts/scanner-source.ts`, `src/app/api/scanner/imports/route.ts`, `src/lib/services/scanner-import.ts`, shared `src/lib/services/ocr.ts`, dashboard/OCR components, and MySQL migration `202610280003_scanner_import`. Configuration examples are in `.env.example` and `scanner-worker.env.example`.

## Actual results

| Check | Result | Boundary |
| --- | --- | --- |
| `npm test` | **411 passed**, 23 files | Includes 56 new worker tests; Azure/provider calls mocked |
| Full `npm run test:integration` with fresh native Hub fixture | **105 passed**, 9 files, **zero skipped** | Disposable real MySQL 8.4.11; includes 12 scanner integration tests; no live provider calls |
| `npm run test:e2e:isolated` | **13 passed** | Owned local server on port 3012; existing billing regression plus scanner queue/UI; simulated extraction and real local missing-configuration recovery |
| `npm run test:scanner` | **Passed**, 8 acceptance groups, **9 separate folder-worker processes**, 1 actual application restart | Real Windows filesystem/CLI, source administration, HTTP and disposable MySQL; Azure mocked |
| `npm run test:ocr:restart` | **Passed**, 2 application restarts, 3 OCR-worker processes | Existing saved Azure-operation behavior tested with injected provider; no Azure HTTP calls |
| `npm run lint` | Passed | Full repository; changed CLI/harness also checked after hardening |
| `npm run typecheck` and final `npm run build` | Passed | Final build includes framework-origin correction and CLI typing fix |
| `npm run check:release` | Passed, **947 build files** | No configured secrets or private runtime references detected |
| Original schema/migrations and `.env` | Preserved | 10 earlier schema/migration files match the checkpoint; real `.env` hash unchanged |
| Real office share / unattended service identity | **Not passed** | Current mapped share disconnected and UNC unreadable |
| Real Azure extraction | **Not run** | Endpoint/key absent; **zero real Azure requests** in this task's automated tests |
| Live Zoho / production deployment | **Not run or enabled** | No production database, hosting or accounting writes |

The Windows worker tests exercise actual file writer exclusion, state locking, current-user-only ACLs, junction rejection and lock release after process termination. Network disconnection/recovery is simulated in worker tests; the actual CLI acceptance uses an absent-then-created local folder. This does not establish real SMB reconnect or eventual service-account permissions.

The actual scanner acceptance creates only synthetic invoices. It verifies disabled-source rejection, staff-API rejection of scanner credentials, baseline behavior, incomplete-copy deferral, missing Azure configuration, lost response after a committed upload, duplicate retry after restart, renamed-file deduplication, mocked extraction, explicit unpaid draft creation, private download hash, token rotation/revocation and unchanged source bytes. It asserts zero payments and zero integration jobs.

Two early scanner acceptance attempts failed on the local origin check. The installed Next.js version normalizes `127.0.0.1`/IPv6 loopback to `localhost`; native `Request` unit fixtures did not reproduce that behavior. The correction permits the normalization only in explicit development/test loopback at the same port and requires the original `Host` to match configuration. New `NextRequest` regressions cover wrong port, foreign host, remote HTTP and production alias rejection. The final full MySQL suite and actual Windows acceptance passed after rebuilding. Review also found and corrected Windows backslash escaping in generated configuration; the final acceptance uses a `\new-scans` path and the CLI verifies exact native environment-parser round trips.

## Evidence retained locally

Evidence is under ignored `.local`; private configuration files are not publication artifacts.

- Final MySQL suite: `.local/mysql-dev/test-runs/17384_1793179884095/receipt.json` and `integration.log`.
- Fresh native Hub synthetic fixture: `.local/mysql-dev/hub-fixtures/04bfca1c-88b5-40e9-9529-d28435f1c278/acceptance-result.json`.
- Scanner acceptance: `.local/mysql-dev/test-runs/18624_1793179941977/scanner-acceptance/receipt.json`; outer `receipt.json` confirms generated database/account cleanup.
- OCR restart: `.local/mysql-dev/test-runs/20608_1793179589460/ocr-restart/receipt.json`; outer receipt confirms cleanup.
- Read-only environment/preservation inventory: `.local/scanner-validation-20261028/inventory.json`.
- Pre-change source/checksums: `.local/scanner-import-baseline-20261028/manifest.json` and `source/`.
- Local additive migration: `.local/mysql-dev/migration-receipt.json`.
- Earlier failed scanner checks remain in test runs `1704_1793179555581` and `20524_1793179656495` with safe failure stage/status records.

Migration 003 was applied only to the guarded development instance and generated test databases. The resulting schema has 26 application tables, 31 enforced CHECK constraints, 36 foreign keys and 52 unique indexes including primary keys. Runtime accounts remain unable to perform schema DDL; audit access remains SELECT/INSERT only. Existing PostgreSQL history and the first two MySQL migrations were not edited. Browser regressions add labelled fictional test records to local development; no office invoice was imported. Final development inventory contains zero scanner sources/imports and only the two existing fictional companies.

## Configuration, sample and remaining limits

Use [the Windows setup/runbook](SCANNER_IMPORT_SETUP.md) for masked Admin provisioning, source activation, worker configuration, startup, token rotation and a one-invoice synthetic sample. The repeatable local acceptance command is `npm run build` followed by `npm run test:scanner`. It needs a free port 3013 and refuses to stop an existing listener.

Office activation still requires all of: verified UNC Read/List permissions for the actual least-privilege Windows identity; the intended company and its reviewers; Azure endpoint/key on the application/OCR host; the existing OCR worker; and both scanner activation gates. The final inventory confirms scanner intake, OCR and Zoho writes remain disabled, with Azure credentials absent. No real-company assignment was guessed.

Limits include one nonrecursive folder, 10 MiB PDFs, 20,000 directory entries, 200-character server filenames and 50 unfinished OCR documents per uploader. A rescan with different bytes needs existing vendor/invoice duplicate checks and human review. PDF signature/ending checks are not malware scanning or full structural validation. Live Azure accuracy, actual scanner copy behavior, SMB reconnects, TLS/proxy configuration and unattended Windows supervision still need representative acceptance.

Private filesystem storage and a MySQL commit cannot form one atomic transaction. Known rollback failures clean up their unused private copy; uncertain commit acknowledgements retain it to avoid destroying a possibly committed original. Such failures can leave a private orphan requiring a separately designed reconciliation/retention process. Source originals are unaffected. The source administration CLI similarly retains a protected configuration on uncertain database outcomes.

For a later HTTPS deployment, the trusted proxy must preserve the configured public `Host` and provide a correctly reconstructed HTTPS request URL; this deployment path has not been exercised. Source provisioning currently intentionally supports only the guarded local development/test databases. Production operation, operational monitoring/backups, malware handling and live financial-provider acceptance remain outside this completed local implementation.
