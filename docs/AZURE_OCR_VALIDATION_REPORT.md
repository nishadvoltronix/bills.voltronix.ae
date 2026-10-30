# Mandatory Azure invoice OCR - implementation and verification

28 October 2026. The existing MySQL application and OCR workflow were extended; no replacement application, duplicate OCR tables or new migration was created. **Implementation and automated acceptance passed. Live Azure acceptance remains blocked by missing endpoint/key; no live extraction success is claimed.**

## Initial findings

The application already had a server-only Azure REST adapter for `prebuilt-invoice` API `2024-11-30`, private uploads, MySQL OCR batches/documents, durable worker leases/polling, bounded retries, immutable extraction evidence and editable, confirmed draft creation with original attachment linkage. The previous baseline was 332 unit, 84 MySQL and 9 browser tests. The initial audit was saved before significant changes in [AZURE_OCR_FINDINGS.md](AZURE_OCR_FINDINGS.md), with source preservation under `.local/azure-ocr-baseline-20261028/`.

No Azure SDK is installed: the existing direct REST implementation was retained. Microsoft's current invoice documentation lists the existing API/model as supported GA, so no SDK/API migration was required. [Microsoft invoice model](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/invoice?view=doc-intel-4.0.0).

## Changes made

- Configuration rejects blank credentials and malformed/foreign endpoints with actionable messages. Keys remain server-side. HTTP 408 on submission is treated as an unknown outcome; polling timeouts resume the saved operation. Operation identifiers are validated and provider error bodies are not surfaced.
- Extraction now preserves optional source line amounts, per-line tax/rate and tax-detail evidence. Missing confidence, conflicting currencies, mixed rates, unsupported precision and inconsistent totals are flagged. Mixed taxes are not silently converted into an average bill-level rate.
- OCR review no longer invents missing currency, VAT rate, invoice date or quantity from ordinary manual-entry defaults. Users explicitly correct these fields. Source totals/tax evidence remain visible, and validation failures retain entered corrections.
- Failed OCR documents can use the existing review endpoint with explicit `mode: "manual"`. The same original is linked to a draft transactionally, with existing role/company/version/confirmation checks and a distinct audit event recording the failure. This does not claim extraction succeeded.
- Retrying a saved Azure operation preserves its ID after configuration/authentication/polling failures. Known terminal extraction failures direct users to manual recovery or a corrected original. Unknown submissions retain the explicit possible-charge acknowledgement. Existing attempt/poll bounds remain enforced.
- Workers recheck the upload owner's current active account, permitted role and company membership before submission/polling. Stale workers cannot replace saved human corrections.
- The existing UI now describes uploading, queued, processing, extraction completed/review required, failed/retry and saved-draft states, with readable confidence labels and manual-entry actions. OCR never approves or pays a bill.
- Added a guarded live test using two generated fictional PDFs, an OCR-specific restart verifier using real Next/MySQL processes, and an isolated browser configuration that disables providers without changing the user's `.env` or stopping their app.

## Executed results

| Check | Previous baseline | Executed OCR-phase result |
| --- | ---: | --- |
| Full unit suite | 332 | **355/355 passed**, 22 files; 16 new provider/parser cases and 7 live-command guards |
| Real MySQL integration suite | 84 | **93/93 passed**, 8 files, no skips; includes 21 OCR cases and native Hub acceptance |
| Full Edge browser suite | 9 | **12/12 passed**; includes 5 OCR cases, actual failed-OCR manual recovery and mocked extraction/Books flows |
| OCR application/worker restart | Not covered | **9 checks passed** across 2 real application restarts and 3 separate worker processes |
| Lint | Passed | Full lint passed; later scoped edits also passed targeted lint |
| Type checking | Passed | Final `npm run typecheck` passed |
| Optimized Next build | Passed | Final build passed, 35 static pages and dynamic routes |
| Release privacy | Passed | Final build scan passed across **930 files**, no configured secrets/private runtime paths |
| Synthetic live-test samples | Not supplied | Both PDFs parsed/rendered offline; one-page and two-page text/page controls passed |
| Actual live Azure extraction | Not verified | **Blocked**: endpoint/key absent. Opt-in command exited before any request |

All Azure responses in the automated suites were mocked. The database, HTTP upload/review routes, private files and application/worker processes used in the database/restart checks were real. The seven live-command guard tests execute the actual CLI in subprocesses with environment-file reads and network calls prohibited; they verify refusal without opt-in, invalid arguments, missing/blank credentials, a production environment and a foreign endpoint.

The restart verifier uploads through the actual HTTP API, saves a provider operation, stops/restarts the application, resumes that operation in a new mocked worker process, saves user corrections, restarts again, and verifies unchanged source extraction, corrected bill values and original attachment hashes. Repeated review creates exactly one draft, with no payments, approval or integration jobs. It uses only its newly generated MySQL schema/accounts and verifies cleanup.

Evidence retained privately:

- Full 93-test MySQL run: `.local/mysql-dev/test-runs/18216_1793175825382/`.
- OCR restart: `.local/mysql-dev/test-runs/18280_1793175825387/ocr-restart/receipt.json`; the parent receipt confirms owned schema/account cleanup.
- Fresh native Hub acceptance: `.local/mysql-dev/hub-fixtures/d3fc21fa-b080-4fc1-b1b6-520ff7a4cc06/acceptance-result.json`.
- Offline PDF validation: `.local/mysql-dev/ocr-fixture-validation/receipt.json` and rendered previews.
- Browser screenshots: `.local/screenshots/`; browser login traces remain disabled.

No baseline assertion was removed to obtain a pass. During validation, a newly added CLI guard test needed a TypeScript environment-shape correction; that was fixed and final type checking passed. No schema compatibility or existing financial-workflow regression remained in the executed suites.

## Files changed

Application code:

```text
src/lib/services/ocr-provider.ts
src/lib/ocr-extraction.ts
src/lib/services/ocr.ts
src/components/ocr-workspace.tsx
src/components/bill-form.tsx
```

Tests and local verification tooling:

```text
tests/ocr.test.ts
tests/ocr.integration.test.ts
tests/ocr-live-guard.test.ts                         (new)
tests/helpers/ocr-restart-worker.ts                 (new)
tests/e2e/ocr.spec.ts
tests/e2e/mvp.spec.ts
tests/e2e/books-organizations.spec.ts
scripts/test-integration.mjs
scripts/test-ocr-live.mjs                           (new)
scripts/verify-ocr-restart.mjs                       (new)
scripts/lib/ocr-synthetic-invoice.mjs                (new)
playwright.isolated.config.ts                      (new)
package.json
```

Configuration/documentation: `.env.example`, `README.md`, `IMPLEMENTATION_STATUS.md`, and new `docs/AZURE_OCR_FINDINGS.md`, `docs/AZURE_OCR_SETUP.md`, this report. The real `.env` was not edited. No dependency versions, lockfile, Prisma schema or migration files changed. The extra Books/MVP browser edits derive expected callbacks from the actual local test origin so the suite can run independently on port 3012.

## Configuration and reproduction

Required existing settings, configured by the user locally or in a server secret store:

```dotenv
OCR_PROVIDER="azure_document_intelligence"
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT="https://YOUR-RESOURCE.cognitiveservices.azure.com/"
AZURE_DOCUMENT_INTELLIGENCE_KEY="<set securely>"
```

The endpoint/key were still absent at the executed live-test check. `.env` was preserved, and OCR remains disabled until the user completes configuration. Azure does not require enabling Zoho's network or accounting flags. Restart the web and separate `npm run worker:ocr` process after configuring the resource. Full instructions: [AZURE_OCR_SETUP.md](AZURE_OCR_SETUP.md).

From `G:\bills.voltronix.ae`:

```powershell
npm run db:local
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
npm run test:e2e:isolated
npm run check:release
npm run test:ocr:restart
```

Ordinary integration runs skip the optional native Hub case when no new native fixture is supplied. To reproduce all 93 checks, create a new fixture and substitute its returned ID (previously claimed fixtures cannot be reused):

```powershell
node --import=tsx scripts/hub-mysql-fixture.mjs setup
$env:HUB_BRIDGE_MYSQL_FIXTURE = 'G:\bills.voltronix.ae\.local\mysql-dev\hub-fixtures\NEW-UUID\acceptance.json'
npm run test:integration
Remove-Item Env:HUB_BRIDGE_MYSQL_FIXTURE
```

After securely configuring Azure, the separate live command is:

```powershell
npm run test:ocr:live -- --allow-live
```

This sends only two generated non-sensitive invoices, incurs Azure analysis usage, submits each once, polls within a bounded deadline and records safe acceptance checks privately. It never loads a database client or sends an existing uploaded invoice. A missing-configuration exit is a blocker, not a passed extraction test. The opt-in enables OCR only in its own process; it does not rewrite `.env`.

## Remaining limits

- Live Azure authentication and extraction remain unverified until the endpoint/key are available and the opt-in test passes. Synthetic success would still need representative authorized supplier-layout acceptance.
- The application accepts PDF/JPEG/PNG up to 10 MB and requests up to 20 pages. Azure F0 supports only 4 MB and the first two pages. Check all original pages; a partial service result does not prove a complete invoice. [Microsoft service limits](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/service-limits?view=doc-intel-4.0.0).
- One currency and one bill-level VAT rate remain the accounting model. Mixed taxes require reviewed treatment; they are not silently generalized into new accounting rules.
- Existing private file/signature/hash controls are preserved; malware scanning and production operations remain separate readiness requirements.

Production hosting, DNS, HTTPS, production data, live Zoho writes and preserved PostgreSQL data were not modified. The MySQL architecture, existing manual workflow and independent approval/payment controls remain intact.
