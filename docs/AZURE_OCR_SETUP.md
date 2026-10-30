# Azure invoice OCR setup and verification

Azure AI Document Intelligence invoice OCR uses the existing private document storage, MySQL OCR queue and bill-review form. Extraction alone cannot create a bill or trigger accounting writes. A user verifies the retained original and extracted fields, then chooses **Save and sync** to finalize an unpaid `READY` bill and queue its exact company destination when operational settings allow. Optional drafts remain available; no separate approval is required and no OCR/save/sync operation records payment. See [current workflow validation](APPROVAL_FREE_SYNC_VALIDATION.md); earlier OCR reports retain their historical results.

The adapter calls the supported `prebuilt-invoice` model directly through the REST API with API version `2024-11-30`. The application has no Azure SDK dependency to install or upgrade. Microsoft documents both REST and SDK access, asynchronous analysis with an operation reference, and polling that reference for results. [Invoice model](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/invoice?view=doc-intel-4.0.0), [Analyze Document REST API](https://learn.microsoft.com/en-us/rest/api/aiservices/document-models/analyze-document?view=rest-aiservices-v4.0+%282024-11-30%29).

## Configure the existing development application

Use your approved Azure Document Intelligence resource endpoint and key. Add or update only these existing settings through your secure local editor or server secret store; do not replace the complete `.env` file or alter its database/provider settings. `.env.example` contains placeholders only.

```dotenv
OCR_PROVIDER="azure_document_intelligence"
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT="https://YOUR-RESOURCE.cognitiveservices.azure.com/"
AZURE_DOCUMENT_INTELLIGENCE_KEY="<set securely; never commit the key>"
```

The endpoint must be the HTTPS Azure resource root, without credentials, a query string or an API path. The application validates configuration when checking readiness and before provider requests. An empty or malformed setting produces an actionable setup error. Configuration presence is reported as configured/unverified; it is not proof that Azure accepted the key or extracted an invoice correctly.

Keep all three settings server-side. Never use a `NEXT_PUBLIC_` prefix, put keys in browser fields, paste them into chat, include them in screenshots, or pass them as command-line arguments. Keep `.env` ignored. Restart both the web and OCR worker processes after changing their environment so they use the same resource and credentials. The OCR worker uses the same `DATABASE_URL` and private `UPLOAD_DIR` as the web app.

Azure OCR does not require enabling `INTEGRATION_NETWORK_ENABLED` or any Zoho write/test flag. Do not change Books connection settings to test OCR; keep financial-write modes disabled in this development installation. Enabling Azure sends uploaded invoice bytes to the configured Azure resource; use an approved resource/region and only invoices authorized for that processing.

From the existing, already provisioned development workspace:

```powershell
cd G:\bills.voltronix.ae
npm run db:local
npm run dev
```

In a second terminal:

```powershell
cd G:\bills.voltronix.ae
npm run worker:ocr
```

For one bounded diagnostic worker tick, use `npm run worker:ocr -- --once`. The continuous worker processes bounded batches and sleeps between ticks. If the web app runs without this separate worker, uploaded invoices can remain queued. Do not run a sync worker or enable live Zoho writes to test OCR.

## Upload, review and manual recovery

1. Sign in as an active Admin, Accounts or Data Entry user with current company membership. Select the correct company before uploading one invoice or a batch. Management can view authorized records but cannot upload, review into a draft or retry processing.
2. Upload PDF, JPEG or PNG invoices. Content signatures, declared MIME type, size and existing-document duplication are checked. Originals are stored privately; authorized downloads verify their stored size, type and SHA-256. These controls do not constitute malware scanning.
3. The UI reports uploading, queued/processing, completed extraction requiring review, or failure. Open the retained original beside the review form. Check vendor, invoice/date/due date, purchase order, currency, lines and source totals. Missing, unsupported or low-confidence fields and inconsistent totals remain visible for correction.
4. Correct the editable values, confirm that you checked the original, and choose **Save and sync**, or **Save verified draft** if unfinished. The original extraction remains unchanged; reviewed input is recorded separately. The original attachment is linked before finalization without another upload. Retrying the review returns the same bill rather than creating another one.
5. A finalized bill is `READY`; there is no separate approval or live-preview confirmation. Inspect its synchronization status. In this local installation, disabled financial settings leave it saved with a visible blocked/error status. OCR, bill state, external synchronization and payment remain distinct; extraction success alone recognizes no expense and records no payment.

If Azure is unavailable, ordinary manual entry remains available at **New Bill**. For an uploaded document in a failed OCR state, choose **Enter bill manually**, enter values from the retained original and explicitly verify them. **Save and sync** and optional **Save manual draft** use the same validation, company/role/version checks and original attachment. The audit records manual entry after OCR failure; it does not claim extraction succeeded. Processing documents must finish or fail before this recovery path can be used.

## File and page limits

| Limit            | This application                                                          | Azure resource consideration                                         |
| ---------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| File types       | PDF, JPEG, PNG                                                            | The application intentionally accepts a smaller set than the service |
| File size        | 10 MB per file                                                            | Azure F0 allows 4 MB; S0 documents a higher service limit            |
| Batch            | 1-10 files, 40 MB combined                                                | Each file is submitted as its own invoice analysis                   |
| Pages            | Requests pages 1-20; reaching the cap requires checking for omitted pages | F0 analyzes only the first two pages; S0 supports longer documents   |
| Invoice grouping | One invoice per file; multiple invoices require separate files            | A multipage file must belong to the same invoice                     |

Check your Azure tier before testing: a file accepted locally can exceed the resource tier's limit. In particular, **F0 does not establish completeness for invoices longer than two pages**, and the application cannot infer the original page count from a truncated service result. Always compare every original page, including totals and later line items. For longer invoices, use an appropriately approved tier and split files when they exceed the application's 20-page processing cap. Password-protected PDFs are unsupported; images must also meet Azure's documented input dimensions. [Microsoft invoice input requirements](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/invoice?view=doc-intel-4.0.0).

The application supports one bill-level VAT rate and currency. Extracted per-line tax/amount evidence is retained for review; mixed tax rates are flagged rather than silently averaged into an invented rate. Source tax details follow Microsoft's invoice field schema. [Invoice schema](https://github.com/Azure-Samples/document-intelligence-code-samples/blob/main/schema/2024-11-30-ga/invoice.md).

## Failures and retry behavior

- Missing configuration or rejected credentials require an administrator to correct the server configuration. Originals remain available for authorized manual entry.
- Rate limits, interrupted polling and transient provider errors use bounded retry/backoff. A saved operation reference is resumed after configuration or authorization recovery; it is not silently discarded to start another chargeable analysis.
- A submission timeout or lost operation reference has an **unknown outcome**. Automatic resubmission is blocked. Inspect the Azure operation first; the explicit retry acknowledgement warns that another analysis charge is possible.
- A completed analysis with no usable extraction directs the user to manual entry or a corrected invoice. It does not repeatedly analyze identical bytes after a terminal failure.
- Worker leases and version checks prevent a stale response from replacing saved human corrections. The worker rechecks the upload owner's active account, current OCR permission and company membership before contacting Azure.

The durable limits are five submission attempts and 60 polls per document. Reaching a limit requires investigation rather than resetting counters or deleting history. Error output uses safe codes/messages instead of API keys, raw provider error bodies or invoice text. Do not paste private server logs or invoice contents into public issue reports.

## Automated and opt-in live verification

Ordinary unit, database and browser tests use mocked Azure responses; real MySQL tests still exercise actual persistence and transactions. They must not be represented as live Azure acceptance.

```powershell
cd G:\bills.voltronix.ae
npm test
npm run test:integration
npm run build
npm run test:e2e:isolated
```

The isolated browser command starts its own server on port 3012 with provider credentials blanked and provider networking disabled, without stopping the app on port 3000 or editing `.env`. It requires a current optimized build. Existing mocked Books tests still cover both destinations. The separate restart check also requires that build:

```powershell
npm run build
npm run test:ocr:restart
```

This command provisions a disposable, guarded MySQL schema and identities, runs actual Next application lifetimes and separate worker processes with a mocked provider, and verifies operation continuity, immutable extraction, persisted human corrections, original attachment hashes, idempotent review and an unpaid/unapproved draft. It cleans up only its owned database/accounts and retains private evidence under `.local/mysql-dev/test-runs/`. It does not access Azure, use the preserved PostgreSQL data or reset development records. Port 3011 must be free; the check refuses an occupied port rather than stopping an unrelated process.

For a separately authorized live Azure test with a configured development resource:

```powershell
npm run test:ocr:live -- --allow-live
```

This explicit opt-in sends **two generated fictional PDFs**: one one-page invoice and one two-page invoice. It checks the returned vendor, invoice identifiers/dates/order, currency, source totals, line values, page count and human-review requirement. It uses only the configured Azure endpoint/key, enables the OCR provider in the test process, and leaves the real `.env` file unchanged. It does not load a database client, read user invoices, create bills or access Zoho. Azure usage may be charged.

Each sample is submitted once; the test polls its saved operation with a bounded deadline and never resubmits an uncertain analysis. Private generated PDFs and a receipt are retained under `.local/mysql-dev/ocr-live/`. Missing development configuration or missing `--allow-live` stops before any request. A pass requires an actual successful receipt; configuration presence, a mocked pass, or an exit caused by missing credentials is not live acceptance. Passing these two synthetic samples also does not establish extraction quality for every supplier layout or longer invoice.

No live Azure pass is claimed by this setup guide. Use the current validation report and its recorded receipts for executed results. Production deployment, hosting/DNS, production database changes and Zoho financial writes are outside this OCR phase.
