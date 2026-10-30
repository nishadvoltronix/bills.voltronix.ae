# CRM job import - 29 October 2026

**Current coverage — 30 October 2026:** the CRM inventory remains **6,048 records**, including **412 actual job references**, with **154 canonical jobs** and **258 records still requiring source-data review**. The disposition below is unchanged; no company, duplicate job reference or missing customer was guessed into a usable job. Incoming synchronization is active. The Books mirror now contains **4,674 bills and all 4,188 current originals**, with zero pending files and a restore-verified 35-table backup. See [current incoming evidence](INCOMING_SYNC.md#verified-current-completion--30-october-2026) and [current original-file coverage](BOOKS_DATA_IMPORT.md#current-completion--30-october-2026). The 29 October counts, old downloader/monitor references and validation milestones below are preserved history, superseded for current coverage and worker ownership.

The local CRM import is **complete** for the verified production source organization `802911927`, data center `US`, module `Deals`. The complete 31-page inventory contains **6,048 Deals**, with all statuses included. Of these, **412 records have an actual `JobDealNumber`**; the other 5,636 are retained privately as source inventory and do not appear as jobs. Other deal or quotation numbers are not substituted for missing job references.

| Disposition of the 412 job records | Records |
| --- | ---: |
| Linked to usable local jobs | 154 |
| Company not mapped by the source | 248 |
| Duplicate job reference within one company | 9 |
| Source customer fails existing job validation | 1 |

Company assignment uses the exact source `Books_Organization_ID`: Contracting `828765858` or Switchgear `802911060`. No company is inferred from customer names, job numbers or amounts. Job-reference uniqueness is checked within each company across the complete inventory. The nine duplicate records belong to four Contracting groups and remain separate source records for review.

The import created 149 local jobs and preserved all five pre-existing jobs byte-for-byte according to the private validation receipt. It created no accounting bills, payments or outgoing sync jobs and made no provider financial writes. The 4,671 imported Books bills and 100 downloaded originals were unchanged at this verification point.

## Access and values

Dashboard search finds usable local jobs and source job profiles. Unmapped or conflicting records have read-only profiles at `/jobs/crm/<snapshot-id>` and cannot start bill entry until their assignment or source issue is resolved. Canonical job profiles use `/jobs/<job-id>`; new manual entries retain **Save and sync**.

An active Admin can see unassigned source jobs only with current membership in **every active company sharing that exact CRM organization, data center and environment**. An explicit company filter excludes unassigned records. Other roles cannot see them. Access is rechecked against current database membership and role; read access does not depend on financial-write flags.

`CrmJobSnapshot` preserves each selected source record exactly, alongside native status, currency and amounts. Missing amounts or an unconfigured approved-variations field remain unknown. Legitimate zero amounts remain zero. Source data is not used to invent project links, payments, budgets or profits. Existing local job values are never overwritten by this importer; later source changes require review. `CrmImportRun` tracks inventory completeness and mapping outcomes separately.

## Private evidence and repeat runs

The cache and receipts are under `.local/mysql-dev/crm-jobs-import-20261029/`: `organization.private.json`, `manifest.json`, `pages/page-N.json`, `import-run.json`, `import-validation.json` and `preserved-jobs.json`. They contain private business data and must remain outside source/deployment archives and public storage. The validation receipt confirms all 6,048 stored source JSON records match the cache exactly. Import completeness is not a production hosting or browser-validation claim.

Apply migration `202610290006_crm_job_snapshots` through the deployment migration identity and regenerate Prisma before using the importer. With an authorized Admin's operator credentials configured privately, resume the existing cache import with:

```powershell
npm run crm:import-jobs -- --source=.local/mysql-dev/crm-jobs-import-20261029
```

This command performs **no provider requests**. It validates a completed cache, locks its state, resumes after the last committed page and leaves a completed run unchanged. Keep the same source directory and state file when resuming. A fresh source refresh needs a new complete private cache and organization proof; do not replace pages in an existing run. Source retrieval must include every status, use 200 records per page, follow cursor pagination after page 10, and retain the configured fields and stable query recorded in the manifest. Local import requires all accounting-write gates disabled, unchanged verified routing, and Admin access to every active company sharing the source.

Back up the database and private uploads as a coordinated recovery set before refresh or deployment. Keep the source cache and validation receipts privately with the operational evidence. Follow the [manual deployment runbook](MANUAL_DEPLOYMENT.md) and [Books data recovery guidance](BOOKS_DATA_IMPORT.md); a source-code archive does not transfer this database or its original files.

## Dashboard validation and recovery

Independent decimal calculations over the complete cached Books details matched all five dashboard amounts exactly: invoice totals, VAT-exclusive expenses, source cash payments, outstanding balances and applied credits. The current AED view recognizes 4,669 bills and excludes two drafts. Full-row backup hashes also confirm that Books bills, attachment metadata, company routing, memberships and encrypted grants remained unchanged across the CRM import. Detailed monetary receipts remain private.

None of the historical Books bills currently has a verified canonical job link. Project/customer name similarity is not a mapping rule. Company totals are available, while historical job expenses and profit remain unavailable; only established provider identities or real native bill relationships can support those figures. The recorded CRM contract total is separate from adjusted contract value, since approved variations were not supplied by the verified mapping.

Authenticated local HTTP checks verified actual dashboard totals, case-insensitive job and bill search, authorized unassigned-job profiles, blocked anonymous access and prefilled bill entry. The actual entry-page check withheld the provider options endpoint because the Books quota pause was already known; it did not submit a bill. Separate isolated browser scenarios verified the existing Save and sync flow using fictional business responses. No provider financial writes occurred.

The final optimized production build, TypeScript, ESLint and 1,230 unit tests passed. Release privacy scanning checked 1,249 build files without finding configured secrets or private runtime paths. The final MySQL integration run passed 191 tests, with one existing skip, and verified migration and cleanup. Twenty isolated browser scenarios passed across dashboard/search, manual entry, Save and sync, Books history and original-file behavior. One incomplete browser fixture was corrected and that scenario rerun successfully. Private proof includes `http-browser-verification.json`, `financial-validation.private.json`, `preserved-source-tables.json`, and the integration receipt under `.local/mysql-dev/test-runs/9280_1793279287645/`.

The coordinated recovery set `.local/mysql-dev/backups/after-crm-dashboard-20261029T130927Z/` contains a verified restore of all 34 tables and all 100 originals available at that time, plus the private environment. It covers the complete CRM import; 4,085 additional original attachments were still pending under provider limits. The existing attachment worker and completion-backup monitor continue separately. Neither this local validation nor the source archive deploys the hosted application.
