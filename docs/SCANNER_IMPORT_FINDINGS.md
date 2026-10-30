# Scanner import inspection - 28 October 2026

The existing Billing application is running locally on Windows 11 Pro, with the Next.js process listening at `127.0.0.1:3000` and the dedicated MySQL 8.4.11 instance at `127.0.0.1:3308`. No hosted deployment was inspected or changed.

## Verified share mapping and current access

PowerShell drive metadata, Win32 logical-disk metadata and SMB mapping agree that `Y:` maps to **`\\192.168.60.10\Nishad_Scan`**. This is an observed mapping, not an assumption from the Explorer label.

The SMB mapping currently reports **Disconnected**. A TCP connection to server port 445 succeeded, but opening the UNC directory from this execution session failed with `ItemNotFoundException`. Directory contents, file read permissions and a dedicated service account's access are therefore **not verified**. No scanner file was opened, written, renamed or deleted. Share reachability alone does not establish authenticated file access.

Use the UNC path for a background worker; an interactive drive-letter mapping does not establish another Windows logon/service account's access. The user has been asked to restore access locally without sharing credentials.

## Existing functionality to reuse

The latest OCR milestone supersedes the older supplied baseline: **355 unit tests, 93 real-MySQL tests and 12 browser tests** passed. Existing code provides private PDF/image originals, company/owner authorization, durable Azure operation tracking and retries, editable OCR review, failed-OCR manual recovery, unpaid draft creation and separate independent approval. See [Azure OCR validation](AZURE_OCR_VALIDATION_REPORT.md).

The Azure endpoint/key remain absent and OCR is disabled. No live Azure acceptance has passed. Zoho writes remain disabled. The current development database contains only fictional Company A and Company B; real scanner-company assignment has been requested and will not be guessed.

## Implementation approach

- Add a separate Windows-compatible polling worker with read-only folder access. It will send stable PDF bytes over a narrowly scoped Billing API, with no database credentials, Azure key or staff session in the worker.
- Keep a source-scoped hashed credential, fixed company/upload owner and durable MySQL hash/import receipt. Reuse the existing private-storage/OCR transaction and serialize duplicate intake at company level.
- Wait for stable metadata and a complete PDF ending; recheck metadata around bounded reads. Persist baseline/retry state locally, use API hash receipts as the authority after lost responses/restarts, and never delete or move source files.
- Default first-start behavior records existing files without importing a historical backlog; an explicit include-existing option supports an intentional sample/backlog import.
- Show scanner arrivals through existing OCR pending-review/processing/error views and dashboard attention. Do not create financial Bill rows from unverified extraction or automatically approve/pay/post to Zoho.
- Test with isolated local folders, synthetic PDFs, mocked Azure and disposable real MySQL. Real-share/Azure acceptance remains separately blocked until access/configuration and company assignment are supplied.

A source checkpoint was saved under ignored `.local/scanner-import-baseline-20261028/`; `.env` is represented only by a hash. No production or preserved PostgreSQL change is planned.
