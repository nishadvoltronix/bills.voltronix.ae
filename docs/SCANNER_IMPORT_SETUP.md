# Automatic scanner import: Windows setup and operation

This feature imports a private PDF into the existing OCR review workflow. Intake and extraction alone do not create a bill or send it to Zoho. After verifying the original and its fields, an authorized user chooses **Save and sync** to create an unpaid `READY` bill and queue its exact configured company destination when operational settings allow. Optional draft save remains available. No separate approver, batch approval or preview confirmation is required, and no scanner/OCR/save operation records payment. See [current workflow validation](APPROVAL_FREE_SYNC_VALIDATION.md); the scanner validation report records the earlier implementation milestone.

Read the [inspection findings](SCANNER_IMPORT_FINDINGS.md) and [executed validation report](SCANNER_IMPORT_VALIDATION_REPORT.md) before enabling an office source. The validation report distinguishes mocked Azure, real local MySQL/HTTP, and any later live-service checks.

## Confirmed development scope

The owner confirmed that development/testing must use **synthetic invoices and isolated local folders only**. Both fictional companies may be exercised with deliberately selected fixtures. Real invoices must not be assigned to either fictional Company A or Company B. Do not reconnect/read the office share or enable live Zoho Books writes as part of this test phase.

Company assignment is configuration, not an OCR inference. The current importer binds each source to one explicitly selected company through `SCANNER_COMPANY_ID`. For two-company synthetic tests, use two separate test folders, source identities and state directories. **Never run sources for different companies against the same mixed-company folder**: identical content can legitimately exist in different companies, so cross-company deduplication would not prevent two imports.

Manual uploads require company selection when several memberships exist. Scanner OCR review retains the source's configured company; bills cannot be silently moved between companies, and synchronization checks the configured company-to-destination binding. Before any real use, verify the real company-to-Zoho organization mapping and require an explicit company selection or verified source assignment. Do not infer the company from invoice text, supplier, filename or amount.

The current version does **not** provide an unassigned shared inbox with per-invoice company reassignment after scanning. If the office folder mixes both companies, that assignment workflow must be implemented and validated before activating it; the current test-only scope does not authorize defaulting that folder to either fictional company or routing it twice.

## Current installation and outstanding configuration

- The observed mapping is `Y:` → **`\\192.168.60.10\Nishad_Scan`**, verified using three Windows mapping interfaces. The mapping was disconnected; TCP port 445 was reachable, but reading the UNC directory failed. No scanner file was opened or changed. Actual folder permissions and service-account access remain unverified.
- The inspected application runs on this Windows machine at `http://127.0.0.1:3000`; its dedicated MySQL 8.4.11 instance uses loopback port `3308`. No hosted application or production database was changed.
- The Azure endpoint/key were missing and OCR was disabled at inspection. See [Azure OCR setup](AZURE_OCR_SETUP.md) for server-side configuration and the separate live acceptance command.
- The existing development companies are fictional fixtures. No real scanner company has been assigned. Choose the authorized company explicitly before importing office documents.
- Scanner intake and each scanner source are separately disabled until enabled deliberately. A generated configuration file alone does not enable import.

Use the verified UNC path for office operation. A mapped drive available in an interactive Explorer session does not establish access for a scheduled task or another Windows account. Microsoft documents this separate-logon behavior in [Services and Redirected Drives](https://learn.microsoft.com/en-us/windows/win32/services/services-and-redirected-drives). Restoring access is an operator task; never put SMB passwords in the worker configuration, command arguments, source code or logs.

## Components and permissions

The folder worker runs on a Windows machine that can read the share. It sends each stable PDF to `POST /api/scanner/imports` using a source-specific bearer token. The Billing application verifies the hash, stores the private original and commits the MySQL import receipt and OCR document together. The existing `worker:ocr` process performs Azure submission and polling.

The folder worker receives no MySQL connection, Azure key, administrator password or browser session. Non-loopback communication requires HTTPS. HTTP is permitted only for a loopback development/test application; the server also checks its configured `APP_URL` origin. Redirects are refused.

Use a dedicated Windows service identity with:

- Share and NTFS **Read/List** access to the scanner folder. The worker needs no source-file write, rename or delete permission.
- Read/execute access to the worker code and Node.js installation, and read access to its protected configuration file.
- Permission to create and modify its own dedicated local state directory. The worker protects that directory for its current Windows identity and holds an exclusive OS lock. It must be on a fixed local drive, outside the scanner folder, `public` and `.next`.
- Outbound access to the approved Billing HTTPS origin. Azure and MySQL access belong to the application/OCR worker environment.

Run provisioning and the folder worker under the intended identity where practical. Generated configuration ACLs initially allow the provisioning Windows identity only. If another service identity will run the worker, an administrator must transfer access securely to that identity. Do not grant broad `Users`/`Everyone` access or run the task as an administrator merely to bypass permissions.

The application creates a dedicated, active `DATA_ENTRY` upload identity for each new source, with membership in exactly the selected company and no usable password login. Authorized Admin/Accounts users in that company can review its documents. A scanner token cannot authenticate staff APIs, finalize a bill or record payment.

## Provision a source in the local development application

The source command supports only the guarded local development database, or a disposable database created by the test harness. It refuses remote/production targets. It requires an active Admin's password and company membership, rechecks authorization inside the transaction, and records the action in the audit log.

Run from `G:\bills.voltronix.ae`. The application migrations, generated Prisma client and local database must already be current. For a local database setup/update, use the existing `npm run db:local` and `npm run db:migrate` commands; do not point them at production.

First choose a source folder and company. For initial validation, use the synthetic local-folder procedure below. Office operation later uses `\\192.168.60.10\Nishad_Scan`, after access and company assignment have been verified.

Set non-secret settings and supply the operator password through a masked prompt:

```powershell
$env:ALLOW_SCANNER_ADMINISTRATION = 'true'
$env:SCANNER_COMPANY_ID = '<explicit authorized company ID>'
$env:SCANNER_SOURCE_NAME = '<reviewable scanner label>'
$env:SCANNER_FOLDER = '<absolute approved folder or verified UNC path>'
$env:SCANNER_API_URL = 'http://127.0.0.1:3000'
$env:ACCOUNT_OPERATOR_EMAIL = Read-Host 'Active Admin email'
$scannerAdminPassword = Read-Host 'Admin password' -AsSecureString
$env:ACCOUNT_OPERATOR_PASSWORD = [System.Net.NetworkCredential]::new('', $scannerAdminPassword).Password
try {
    npm run scanner:source -- create
} finally {
    Remove-Item Env:ACCOUNT_OPERATOR_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:ACCOUNT_OPERATOR_EMAIL -ErrorAction SilentlyContinue
    Remove-Item Env:ALLOW_SCANNER_ADMINISTRATION -ErrorAction SilentlyContinue
    $scannerAdminPassword.Dispose()
}
```

The command prints the new source ID and configuration **path**, never the token or password. The source starts disabled. Its files are under the ignored private directory:

```text
.local/mysql-dev/scanner-workers/<source-id>/config-<unique-id>/.env.scanner
.local/mysql-dev/scanner-workers/<source-id>/state/
```

The generated file contains only these worker settings:

| Setting | Purpose |
| --- | --- |
| `SCANNER_FOLDER` | Absolute source directory; use the verified UNC for office operation |
| `SCANNER_API_URL` | Exact Billing origin; HTTPS except local development/test loopback |
| `SCANNER_SOURCE_ID` | Fixed company-bound source identity |
| `SCANNER_TOKEN` | Private, intake-only credential; only its hash is stored in MySQL |
| `SCANNER_STATE_DIR` | Dedicated private directory on a fixed local Windows drive |
| `SCANNER_POLL_SECONDS` | Poll interval, default 10 seconds; allowed 1–300 |
| `SCANNER_SETTLE_SECONDS` | Unchanged-file interval, default 30 seconds; allowed 2–3600 |

Do not print or paste that file. Do not put administrator, SMB, MySQL or Azure credentials in it. Generated values are checked for safe environment-file round trips; unsupported quote/control characters are rejected.

After reviewing the assignment, set `SCANNER_SOURCE_ID` to the returned ID and use the same masked Admin authentication procedure to run:

```powershell
npm run scanner:source -- enable
```

Separately set `SCANNER_IMPORT_ENABLED="true"` in the **local application's** private environment and restart the application process you own. Both the server flag and the source's active state must allow import. Do not enable live Zoho flags as part of scanner setup.

The same authenticated command supports `disable` and `rotate`. Rotation writes a new private configuration and invalidates the previous token. Supply the original folder/origin settings when rotating, stop the old worker, and restart with the new configuration. Token rotation preserves the existing state binding when folder, source and origin remain the same. Disabling a source stops new intake; it does not delete previously imported documents.

## Run the Windows folder worker

Use Node.js supported by this project and installed dependencies. Start from the repository directory and select the generated configuration explicitly:

Existing process variables take precedence over `--env-file`, as documented in [Node's command-line reference](https://nodejs.org/api/cli.html#--env-filefile). Clear these worker settings from the current shell before selecting its private file, so stale provisioning values cannot override it. This changes only the shell environment, not files or saved application settings:

```powershell
'SCANNER_FOLDER', 'SCANNER_API_URL', 'SCANNER_SOURCE_ID', 'SCANNER_TOKEN',
'SCANNER_STATE_DIR', 'SCANNER_POLL_SECONDS', 'SCANNER_SETTLE_SECONDS' |
    ForEach-Object { Remove-Item -LiteralPath "Env:$_" -ErrorAction SilentlyContinue }
$scannerWorkerConfig = '<absolute path printed by scanner:source create>'
node "--env-file=$scannerWorkerConfig" --import=tsx scripts/scanner-worker.ts
```

`npm run worker:scanner` instead loads `.env.scanner` from the repository root. The generated private path above avoids needing to copy a credential file there.

On its **first successful directory scan**, the worker records existing files without uploading them. This prevents an unexpected historical backlog. A disconnected or unreadable folder does not initialize that baseline. New arrivals are persisted before processing, so restarting does not silently classify those arrivals as historical.

For a deliberately approved historical/sample import, pass `--include-existing` when initializing a new journal. This option is not a way to override an already skipped baseline. Later adding it to a journal created without it produces `STATE_INVALID`. Do not delete or edit an operational journal to force re-import; arrange an explicit backlog procedure with an administrator.

`--once` runs one scan and exits. A new file needs at least two observations separated by the configured settling interval. One `--once` invocation normally observes a new file without importing it.

The worker checks unchanged metadata, a PDF header and ending, and metadata before/after a bounded read. On Windows it also holds a read-only sharing handle that excludes writers. Its source files are never modified, moved or deleted. Reparse-point files are refused. Use one worker per state directory; simultaneous workers are rejected by the OS lock, which releases after a process crash.

An administrator can later configure Windows Task Scheduler to run the same Node executable and arguments under the dedicated account, with this repository as **Start in**. Configure the task's network-capable logon, access to the private configuration, restart-on-failure policy and appropriate private log retention. Run without elevated privileges. Task installation and unattended service-account/network access are separate operational checks; this implementation does not install or enable a scheduled task automatically.

Run the existing OCR worker separately in the application's server environment:

```powershell
npm run worker:ocr
```

Configure `OCR_PROVIDER="azure_document_intelligence"`, `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` and `AZURE_DOCUMENT_INTELLIGENCE_KEY` only on that application/OCR host, then restart its processes. Scanner import always goes through the OCR workflow. It never substitutes an automatic manual bill when Azure is unavailable.

## Test with one generated invoice

The repeatable isolated acceptance command is:

```powershell
npm run build
npm run test:scanner
```

It creates a disposable MySQL schema, generated local PDFs and a separate application on loopback port 3013. It exercises the actual source CLI, Windows worker, HTTP intake, restart/deduplication and human review using mocked Azure. It does not read the office share or call Azure. Consult the validation report for the actual latest result; the existence of this command is not a live-Azure pass.

For a visible manual sample in the existing local dashboard:

1. Create a new, empty local folder, and provision a **fictional-company** source pointing to it. Do not use real supplier invoices with a fictional company.
2. Enable that source and the local server intake as described above. Start the worker once to record the empty baseline.
3. Add one generated PDF, then run the worker continuously and allow the settling interval to pass.
4. Open the dashboard OCR attention card and review the source-labelled document. With Azure missing/disabled, expect a retained original with `FAILED / NOT_CONFIGURED`; that proves intake only. With configured Azure and the OCR worker running, wait for extraction and explicitly verify the fields.
5. After successful extraction, verify the fields and choose **Save and sync**. Expect an unpaid `READY` bill with blocked synchronization while local Zoho writes are disabled; no separate approval is required. To test the optional draft path, choose **Save verified draft** instead and expect `DRAFT`. If OCR failed, use the audited manual-from-original recovery only if intentionally testing that path; this does not prove OCR success. Keep Zoho writes disabled and verify the original is downloadable privately and unchanged in the sample folder.

Create the empty sample folder before provisioning:

```powershell
$scannerSampleFolder = Join-Path (Get-Location) ('.local\scanner-sample-' + [Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $scannerSampleFolder | Out-Null
$env:SCANNER_FOLDER = $scannerSampleFolder
```

After provisioning/enabling the fictional source and setting `$scannerWorkerConfig`, baseline it:

```powershell
node "--env-file=$scannerWorkerConfig" --import=tsx scripts/scanner-worker.ts --once
```

Generate the one fictional invoice using the existing synthetic fixture generator:

```powershell
$env:SCANNER_SAMPLE_DIRECTORY = $scannerSampleFolder
node --input-type=module -e "import { writeFileSync } from 'node:fs'; import path from 'node:path'; import { syntheticInvoicePdf } from './scripts/lib/ocr-synthetic-invoice.mjs'; writeFileSync(path.join(process.env.SCANNER_SAMPLE_DIRECTORY, 'sample.pdf'), syntheticInvoicePdf('DEMO-SCANNER-SAMPLE'), { flag: 'wx' });"
Remove-Item Env:SCANNER_SAMPLE_DIRECTORY
node "--env-file=$scannerWorkerConfig" --import=tsx scripts/scanner-worker.ts
```

Use `Ctrl+C` to stop your sample worker. Do not switch this journal to the office UNC: its state is bound to the folder, application origin and source. Provision the office source separately after the outstanding checks are complete.

## Recovery and operating limits

| Situation | Behavior and operator action |
| --- | --- |
| Folder disconnected or read denied | No premature baseline or source mutation. Worker logs a safe code and retries with exponential backoff. Verify UNC access while signed in as the service identity. |
| Copy still open, changing or incomplete | No upload. The worker waits for stable observations and an available read-sharing lock. A missing PDF ending is retried; repair/rescan an invalid source rather than deleting originals. |
| Upload response lost or worker/app restarts | Same bytes produce the same SHA-256. The MySQL source/hash receipt and company-wide duplicate checks prevent a second OCR document for accepted identical content. |
| Azure missing or unavailable | The private original and OCR failure remain visible in Billing. Accepted files are not repeatedly uploaded. After fixing configuration, use the authorized OCR Retry action and run `worker:ocr`. Existing operation IDs and bounded OCR retries are reused. |
| OCR cannot be completed | An authorized user may choose failed-OCR manual recovery, verify every field and Save and sync or save an optional draft. The audit records manual recovery, not successful OCR. |
| `AUTHORIZATION_FAILED` | Worker stops. Check source activation, token rotation, active company, upload identity and membership. Do not broaden staff or share permissions to bypass the failure. |
| `CONFIGURATION_INVALID` | Worker stops; check endpoint, required settings and intake deployment. Pending work is retained. |
| `STATE_IN_USE` | Another worker owns the local state lock. Run one instance per state directory. |
| `STATE_INVALID` | Check source/folder/origin binding, directory contents and journal integrity. A corrupt or missing previously initialized journal is not silently reset. Keep evidence and restore the appropriate private state/configuration. |
| HTTP 429 / pending quota | Review existing documents. Each upload owner can have at most **50 unfinished OCR documents**, including failures. Worker retries; it never approves or deletes documents to make room. |

Other boundaries:

- PDF only, maximum **10 MiB per file**; one original per request. Server filenames are limited to 200 characters.
- A single folder is scanned, **non-recursively**, with at most **20,000 directory entries**, including non-PDF entries. Subfolders require a separately planned source.
- Default polling is 10 seconds and settling is 30 seconds. Transient import/network retries back off up to 15 minutes. The private journal contains opaque filename digests and processing metadata; it does not contain invoice bytes, names, extraction text or credentials.
- Scan/snapshot operations have 30-second client deadlines; at most one outstanding operation of each type is retained if Windows is still waiting on SMB. Late results are discarded. Windows read locks expire if a read stalls; the worker never imports that timed-out result.
- Header/ending checks are not full PDF validation or malware scanning. Azure may reject a structurally invalid or encrypted PDF. Existing Azure service limits and accounting-field limitations still apply.
- Byte-identical copies are deduplicated within the company's existing OCR/attachment records. A new scan of the same paper can have different bytes; existing invoice-number/vendor warnings and human review remain necessary.
- The current implementation's protected journal and locking require Windows. A different operating-system deployment needs separately validated locking and credential/storage handling.
- Real UNC access, the eventual service account, the real company assignment, representative supplier layouts and live Azure extraction remain explicit acceptance items. No production deployment or live Zoho write is authorized by this runbook.
