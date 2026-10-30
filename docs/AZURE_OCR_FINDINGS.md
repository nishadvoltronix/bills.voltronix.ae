# Azure invoice OCR inspection - 28 October 2026

The existing implementation is being preserved. Billing uses real MySQL 8.4.11 through Prisma; the previous validation baseline is 332 unit tests, 84 database integration tests and 9 browser tests. See [the MySQL report](MYSQL_VALIDATION_REPORT.md).

## Already implemented

- Server-only Azure REST client using `prebuilt-invoice`, API `2024-11-30`; no Azure SDK package is installed or required by the current architecture.
- Endpoint validation, private API key, redirect refusal, request timeout, bounded result size and durable start/poll operation identity.
- Existing `OcrBatch`, `OcrDocument` and template models, private originals, company/owner authorization, bounded worker leases/retries and versioned review.
- Extracted invoice fields, editable bill review, decimal comparisons, duplicate warnings and explicit human confirmation. Reviewed OCR creates a draft and links its original; independent approval/payment remain separate.

## Gaps to correct

1. Preserve source line amounts and available tax/rate evidence. Flag missing confidence and unsupported mixed tax instead of silently suggesting an averaged bill tax rate.
2. Prevent OCR forms from inheriting manual AED/5% defaults when extraction has no currency/tax evidence.
3. Preserve a saved Azure operation when polling fails because configuration/authentication is temporarily unavailable; a retry must not unnecessarily start a second charged analysis.
4. Offer a safe manual-review path using the retained original after OCR fails, with explicit confirmation and unchanged approval/permission controls.
5. Clarify upload/processing/review/failure/retry UI states and actionable setup errors.
6. Add a separate guarded, opt-in live Azure test using synthetic non-sensitive invoices. Add OCR-specific process-restart persistence coverage and regression tests for the gaps above.

## Configuration and scope

At inspection, `OCR_PROVIDER` is disabled and the Azure endpoint/key are absent. The user will configure credentials locally; this work will not overwrite `.env` or print its values. Existing names remain `OCR_PROVIDER`, `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` and `AZURE_DOCUMENT_INTELLIGENCE_KEY`.

The public Microsoft invoice contract supports the existing GA API/model. Retain it and direct REST unless executed evidence requires a change. Reference: [Microsoft invoice model](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/invoice?view=doc-intel-4.0.0).

No new schema or competing workflow is planned. A source checkpoint was saved under ignored `.local/azure-ocr-baseline-20261028/`; it contains source files and an environment hash only. Tests use isolated local MySQL and mocked provider calls by default. Live Azure results will be reported separately. Production, Zoho writes and preserved PostgreSQL data remain outside this phase.
