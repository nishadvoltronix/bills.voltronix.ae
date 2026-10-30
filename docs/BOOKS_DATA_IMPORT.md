# Zoho Books bill history and originals

## Current completion — 30 October 2026

At **04:43:13 UTC / 08:43:13 Dubai**, the local app contained **4,674 Books bills and all 4,188 current source originals, with zero pending files**. Incoming synchronization imported three new bills overnight. All three incoming sources had successful current checks, no quota/error state, and a healthy continuous worker. The earlier Contracting quota pause is cleared. Coverage is complete for the source snapshot verified at this time; the worker continues to collect future source changes.

The completed recovery set is `.local/mysql-dev/backups/after-current-originals-complete-20261030T044152Z-7b4fa5/`. Its isolated restore verified all **35 tables**, matching data, DDL and column hashes. Every one of the **4,188 original files** passed byte-length and SHA-256 verification; pending, invalid-metadata and invalid-byte counts were all zero. The verification database/account cleanup passed. The original-completion monitor exited successfully; the continuous incoming worker remains active.

Fresh authenticated checks opened and downloaded one actual original from each company, matching stored SHA-256, byte length, MIME type, disposition and no-store headers. Anonymous access returned 401. Newest-bill search passed. Independent raw-source calculations over **4,672 financial bills**, excluding two nonrecognized records, matched all five dashboard totals: invoice value, recognized expense, cash paid, outstanding balance and credits. Desktop/mobile checks found no horizontal overflow or page errors. These checks performed no financial writes.

The CRM inventory remains 6,048 records with 154 canonical jobs. The 258 source-data review jobs and unverified historical bill-to-job links remain unresolved; original-file completion does not establish those mappings. Hosted deployment and outgoing production acceptance remain owner-managed and unverified. See [incoming synchronization](INCOMING_SYNC.md) and [the deployment runbook](MANUAL_DEPLOYMENT.md).

## Historical initial import — 29 October 2026

The dated counts and one-off-worker observations below are preserved as historical evidence. Current incoming synchronization owns future downloads; the former downloader and its initial completion monitor were handed over on 29 October. Use the current completion section above for coverage and backup status.

The local app displays imported history at **`/bills/books`**. Sign in with an active Admin, Accounts or Management account assigned to the source company. Search, company/currency/status filters and bill details use the downloaded Books records. New manual entries retain the existing **Save and sync** workflow.

The complete Books listings contain **4,391 Contracting bills** (organization `828765858`) and **280 Switchgear bills** (`802911060`), totaling **4,671**. **All 4,671 full bill details are downloaded, imported and independently verified.** Both import runs are `COMPLETE`, with zero missing details or mismatches. All source summaries and complete bill JSON match their stored copies, and 65,394 native-field checks and exact decimal reconciliations passed. A fresh provider listing at 12:02 UTC on 29 October 2026 returned the same bill IDs, amounts, statuses and other checked bill fields, with no additions or removals. The private `validation.json` and `final-source-comparison.json` retain the evidence.

Imported history is stored in `BooksBill` and tracked by `BooksImportRun`. Native statuses, currencies, dates, totals, balances, payments made and applied vendor credits are retained. Full provider bill JSON is private; the app exposes the relevant bill fields. The import creates no local accounting bills, jobs, payment ledger entries or outgoing sync jobs. It does not repost historical bills to Zoho. Provider requests read source data and original attachments; attachment downloads have separate coverage from the completed bill-detail import.

Downloaded records include discounts, adjustments and bills assigned to multiple source projects. Those fields remain in the original snapshots without being forced into the simpler local bill model. Books history is shown separately from reports calculated from locally authored bills.

## Original attachments

The bill detail page supports **Open** and **Download** for original PDF, JPEG and PNG attachments imported from Zoho Books. Files retain their original bytes; scanned images are not converted into generated PDFs. The filename shown is the saved filename, normalized for safe download. Source filenames and document IDs remain in the private bill snapshot.

Each file is recorded in `BooksBillAttachment`, bound to its exact bill, company, organization, data center and environment. File bytes are stored under a generated private storage key in `UPLOAD_DIR`. Import verifies the current source document metadata, declared size and detected file type, and records SHA-256. Downloads check the file's size/hash, current source membership and the reader's active role/company access. Browser links use the authenticated app route; provider URLs and private storage paths are not exposed.

The attachment panel reports the number of imported originals for that bill. **Not downloaded yet** means the source document is known but its original file is not available in this app. A source filename or a `COMPLETE` bill-detail import is not evidence that its attachments were downloaded. Provider rate limits can leave attachment work pending while already imported originals remain usable. The page reports saved coverage when loaded or refreshed; it does not claim that pending downloads are running or automatically complete.

**Attachment coverage verified at 12:36 UTC on 29 October 2026:** 100 of 4,185 source originals are imported and available locally; 4,085 remain pending. The available originals contain 92 JPEG and eight PNG scans. Source PDFs are still pending, so PDF source download completion has not been verified.

| Organization | Source originals | Available locally | Pending |
| ------------ | ---------------: | ----------------: | ------: |
| Contracting  |            3,912 |                49 |   3,863 |
| Switchgear   |              273 |                51 |     222 |
| Total        |            4,185 |               100 |   4,085 |

The one-off worker is waiting for provider limits. The persisted earliest retry is 29 October at 13:27:39 UTC (17:27:39 Dubai) for Switchgear after a `429` response with `Retry-After: 3600`. Contracting's known daily-quota delay lasts until 29 October at 20:02:01 UTC (30 October at 00:02:01 Dubai). Later provider responses may defer either organization again. Automatic continuation requires this PC to remain awake, the worker process to keep running, and local MySQL and internet access to remain available. Current counts and any revised retry time are in the private progress file.

### Historical one-off original-file procedure

This procedure describes the original 29 October download. The current backlog is complete and the incoming worker owns future changes. A one-off downloader would require a coordinated worker handoff; do not start it alongside the active incoming downloader.

The reusable downloader reads current attachment metadata from the database and reuses originals whose private bytes pass integrity checks. It does not require the earlier private source JSON cache. Configure an active company-authorized Admin's `ACCOUNT_OPERATOR_EMAIL` and `ACCOUNT_OPERATOR_PASSWORD` privately. Production requires those credentials; the trusted local development workspace can use its existing `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` fallback. Keep all financial-write gates disabled and the verified read-only Books connection enabled.

For this 29 October import, Contracting's observed daily quota requires no further requests before `2026-10-29T20:02:01Z` (30 October, 00:02:01 Dubai). Start or resume the one-off download with that known delay:

```powershell
npm run books:download-attachments -- --wait --state=.local/mysql-dev/books-attachments-20261029/resume-progress.json --not-before-org=828765858:2026-10-29T20:02:01Z
```

The private progress JSON persists available/pending counts, failures, quota observations and `nextResumeAt`. Keep the same state file across restarts; a process lock prevents concurrent owners of that state. The command uses one download worker across organizations, spaces requests by at least 800 ms and reserves 100 daily requests. It honors later provider quota limits as well. `--wait` keeps this process waiting for a known reset and continues until the current run completes; it does not install a scheduled task or recurring synchronization. If the provider gives no safe reset time, the run stops with files pending instead of probing the exhausted quota.

Omit `--wait` to save pending progress and exit when quota blocks further work. Use repeatable `--organization=<configured-id>` to explicitly scope a separate run, and `--not-before-org=<id>:<ISO timestamp>` to preserve an observed organization delay. Keep each state file tied to its original organization scope. Exit status is `0` for completion, `2` for pending/waiting work and `1` for an error. Check the private receipt and app coverage rather than inferring completion from a stopped process. No command in this download flow creates or updates provider accounting records.

### Deploying and restoring originals

1. Include migration `202610290005_books_bill_attachments` and regenerate the Prisma client when preparing the release. Apply migrations through the deployment runbook's separate migration identity before starting the updated app.
2. Keep `UPLOAD_DIR` on persistent private storage outside `public`, `.next` and the source release. The deployment Compose configuration mounts the `invoices` volume at `/var/lib/voltronix/uploads`; configure the matching absolute `UPLOAD_DIR`. Give the app's runtime identity access to that directory. Do not serve it directly through the proxy or replace the invoice volume during a code release.
3. Back up the database and the entire private upload directory as one recovery set. Preserve every stored filename exactly: database `storageKey` values locate those files. Capture a consistent snapshot with attachment imports and uploads paused, or use a coordinated snapshot method. Keep its private receipt with row counts, file sizes and SHA-256 hashes; keep runtime secrets separately protected as described in the deployment runbook.
4. Restore into a separate verification database and private directory first. Confirm the restored `BooksBillAttachment` count against the same backup receipt and verify every referenced file's byte length and SHA-256. Check authenticated Open/Download on a PDF and image, plus denial for an account without that company membership, before accepting the restore. A successful check of native `Document` records alone does not verify Books originals.

The restore-verification command, `npm run backup:verify`, requires `ALLOW_RESTORE_VERIFICATION=true`, a disposable loopback `RESTORE_DATABASE_URL` named `bills_restore_<identifier>`, and an absolute `RESTORE_UPLOAD_DIR` pointing to the separately restored private files. Supply all four counts from the coordinated **source backup receipt**: `RESTORE_EXPECTED_BILLS`, `RESTORE_EXPECTED_DOCUMENTS`, `RESTORE_EXPECTED_BOOKS_BILLS` and `RESTORE_EXPECTED_BOOKS_ATTACHMENTS`. Use explicit zero only when that source receipt confirms zero; do not calculate expected counts from the restored destination. The report separates imported `booksBills`, `downloadedBooksOriginals` and `unreadableOrAlteredBooksOriginals` from native bills/documents, checks expected counts, and verifies every stored original's size/hash. The command verifies an existing restore; it does not create or restore the database or copy files.

A source-code deployment archive contains neither the imported database nor private invoice files. Copying only that archive cannot transfer this local history or its originals to another host. Follow the production runbook for company authorization and operational configuration; retaining imported history does not authorize accounting writes.

## Private evidence and verification

The source cache is `.local/mysql-dev/books-import-20261029/<organization-id>/`: `listing.json`, paginated `page-N.json`, combined `bills.json`, and `details/<bill-id>.json`. Progress and failure receipts are in the same private directory. These files contain business data and are excluded from source/deployment archives.

The read-only validator compares complete source JSON, source identity and unique bill grain, every imported native financial field, pagination, detail coverage and exact decimal aggregates grouped by source currency. It does not derive payments from balances or combine currencies. It also checks that the import companies have no fabricated local bills/payments/outgoing jobs and that their original CRM job identities match the preserved cleanup baseline. Two additional jobs selected by the existing Admin during the import were independently matched to their CRM source and selection audits; those legitimate user changes remain intact. Detailed results and private aggregate values are written to `.local/mysql-dev/books-import-20261029/validation.json`; console output contains counts and status only.

Run after both downloader and importer finish:

```powershell
node --conditions=react-server --env-file=.env --import=tsx .local/mysql-dev/books-import-20261029/verify-import.ts --require-complete
```

To inspect coverage while work continues, omit `--require-complete`. To validate only a completed company, add `--organization=802911060` or `--organization=828765858`. A validation report identifies its selected organizations and timestamp; a one-company result is not evidence that both companies finished.

## Cleanup and recovery

The pre-cleanup database, private environment and original uploads were backed up to `.local/mysql-dev/backups/before-books-import-20261029T110630/`. Its private `receipt.json` records a successful isolated restore verification. Removed dummy uploads were moved to `.local/mysql-dev/demo-quarantine-20261029/`; cleanup and preservation receipts remain there. Existing logins, real-company memberships, OAuth grants and audit history were preserved. Seed-company memberships were removed. The Admin login retains both real-company scopes; the Accounts login currently has no company assignment.

The completed bill-data import also has a verified private backup at `.local/mysql-dev/backups/after-books-import-20261029T120509Z/`. Its 57,161,526-byte database dump was restored into an isolated database using a restricted temporary account. All 31 tables matched the live snapshot by row count and full-data SHA-256; the temporary database/account were then removed. The private environment was backed up alongside it. `receipt.json` and `.local/mysql-dev/books-import-20261029/final-backup.json` record the checks. **This backup predates local original attachments and cannot restore files downloaded afterward.** A newer coordinated database/upload backup is required for those files. Production company configuration and access still require the deployment runbook.

A newer coordinated backup at `.local/mysql-dev/backups/after-books-originals-partial-20261029T123133Z/` includes the attachment migration and the first 100 original files. Its 57,326,560-byte database dump was restored into a restricted disposable database; all 32 tables matched the source snapshot. Every restored original passed private-file SHA-256 and byte-length checks. The private receipt at `.local/mysql-dev/books-attachments-20261029/final-backup.json` records 100 available and 4,085 pending originals. This recovery set covers the files available at backup time; later downloads require a newer recovery set.

Keep the backups and downloaded source cache under private storage. Recovery should restore the verified database and uploads into an isolated database first, check the receipt and application access, and replay the cached import only after review. Restoring the pre-cleanup snapshot also restores its dummy records; it is a recovery point, not a production release database.

The subsequent [complete CRM import](CRM_JOB_IMPORT.md) added 149 verified billing jobs and retained all five jobs present immediately before that import. It did not change the 4,671 Books bill records or the 100 stored originals. The coordinated backup at `.local/mysql-dev/backups/after-crm-dashboard-20261029T130927Z/` includes both CRM tables, all 154 billing jobs, and those originals. Its 61,910,089-byte database dump was restored and all 34 tables matched by full-row SHA-256; all 100 private original files passed size/hash verification. The CRM evidence directory's `final-backup.json` records this recovery set. Later attachment downloads still require a newer coordinated backup.

This work populates the local workspace. Production hosting and new-invoice posting readiness remain governed by [Books production verification](BOOKS_PRODUCTION_VERIFICATION.md) and the [manual deployment runbook](MANUAL_DEPLOYMENT.md).

## Application checks

Before the original-attachment extension, production build and TypeScript checks passed, along with ESLint, 1,137 unit tests, 171 MySQL integration tests (one skipped), and ten isolated browser checks covering imported history and the existing manual Save and sync flow. Real authenticated local browser checks verified desktop/mobile history and details; final HTTP checks verified all 4,671 records, both complete import runs, and the last page of history. Source records, credentials and private runtime data remain excluded from deployment archives. These earlier results establish bill-history behavior; attachment-specific validation and current download coverage are tracked separately.

The original-attachment extension passed the optimized production build and TypeScript checks. Twelve isolated browser checks passed: four for Books history/original links and strict HTTP file headers, and eight for existing manual entry/Save and sync behavior. These browser scenarios use fictional business responses with real local authentication and no provider writes.

The final checks also passed 1,196 unit tests, 179 MySQL integration tests (one skipped), full ESLint, and release privacy scanning of 1,200 build files. The actual attachment migration was applied to the local database with runtime schema privileges still restricted. A private one-off completion helper waits for the current downloader to exit successfully and then creates and verifies a fresh database/upload backup; its state is `.local/mysql-dev/books-attachments-20261029/completion-backup-status.json`. This is local work and requires the current computer and MySQL service to remain available.

Real authenticated local HTTP checks independently downloaded all 100 stored originals and matched their SHA-256 values; unauthorized and wrong-bill access were denied. The real JPEG **Open** link created a new tab and the browser decoded its image successfully under the strict sandbox policy. A separate 609-byte fictional PDF, supplied only through a browser test response, rendered its expected page/text in the built-in viewer with the same headers. That fixture check validates PDF preview behavior, not receipt of a real source PDF. Private evidence is under `.local/mysql-dev/books-attachments-20261029/`: `http-verification.json`, `image-preview-verification.json`, `pdf-preview-fictional-verification.json` and the fictional preview screenshot. These checks made no provider financial writes.
