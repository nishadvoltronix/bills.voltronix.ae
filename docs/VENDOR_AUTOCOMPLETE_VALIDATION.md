# Company-specific vendor autocomplete

Validated 29 October 2026. This change updates the existing bill-entry form; it does not introduce another form, vendor table, company setup or provider data source.

## Implementation

- The vendor field searches only after a company is selected. Requests contain its actual internal company ID; the server resolves the existing Books destination and configured organization. Search text is debounced, bounded and treated as a literal substring.
- Configured Books companies receive active, supported-currency suppliers from the existing Zoho transport and exact organization/data-center/environment mappings in the existing database. Unmapped local vendors are not added to these suggestions. Local companies without a Books destination retain local lookup. Existing demo companies with an unconfigured sandbox placeholder retain an explicitly labelled local fallback; configured or production destinations cannot enter that fallback.
- Selecting a Books result sends its exact destination and provider ID to the server. The server verifies the active vendor again and returns its existing local ID or atomically adds that selected supplier and its mapping to the existing tables. It preserves existing supplier records and rejects ambiguous name/TRN/external-ID collisions instead of merging or overwriting them. Search itself creates no vendor records. No provider POST is used.
- Current company membership and destination are checked before and after provider reads and inside the selection transaction. Existing bill create/update validation still rejects mixed-company vendor/job references. No credentials enter client responses.
- Company switches and edited search text clear selection. Aborted or late requests cannot restore the previous company's vendor. Keyboard selection does not submit the surrounding form. Loading, empty, failure, cached-result warnings and retry states are explicit. Late supplier resolution respects the currently selected job currency.
- Existing bills and OCR drafts hydrate their selected local vendor directly, independently of search pagination or provider availability. Currency, TRN and email use existing application fields; no address field/schema was introduced.
- Materials/Other mapping configuration was not changed. A regression test verifies that an unmapped LABOUR bill is rejected by the Books payload builder rather than using another category's account.

## Files changed for this task

Application:

- `src/components/bill-form.tsx`
- `src/components/vendor-autocomplete.tsx` (new field component)
- `src/components/types.ts`
- `src/app/globals.css`
- `src/lib/services/bill-vendor-lookup.ts` (existing integration/database orchestration)
- `src/app/api/vendors/search/route.ts`
- `src/app/api/vendors/resolve/route.ts`

Tests:

- `tests/bill-vendor-lookup.test.ts`
- `tests/bill-vendor-lookup.integration.test.ts`
- `tests/bill-vendor-routes.test.ts`
- `tests/e2e/vendor-autocomplete.spec.ts`
- `tests/e2e/manual-readiness.spec.ts`
- `tests/e2e/mvp.spec.ts`
- `tests/e2e/ocr.spec.ts`
- `tests/integrations.test.ts`

## Validation

- 744 unit tests passed, including 43 lookup-service tests and 13 HTTP-boundary tests.
- 130 MySQL integration tests passed in a newly created disposable test database, including eight autocomplete tests; one optional Hub fixture test was skipped. Harness cleanup succeeded. No application schema migration was run against the existing database.
- 30 existing browser checks passed, including bill entry/editing, private attachments, attachment retry, OCR, duplicate protection and mocked Zoho synchronization. One pre-existing consent test was skipped because the isolated browser server disables provider networking.
- All 12 autocomplete browser checks passed. The initial run exposed two incorrect test locators (Company options were counted as vendor results, and edit mode was queried for the new-bill save label); both assertions were corrected and the complete autocomplete suite rerun successfully. No remaining test failures.
- Full lint, TypeScript checks and production build passed. Release privacy validation checked 1,020 build files without finding configured secrets or private runtime paths.
- Authenticated, read-only searches succeeded against both actual Books organizations, `828765858` and `802911060`. Returned suggestions matched their exact internal company and organization; neither check created local suppliers or provider financial records. Selection/creation behavior was tested using fictional data in the disposable database and browser mocks.

## Preservation and limits

A before/after inventory confirmed no changes to any of the 31 pre-existing bills, three existing vendor records, four companies, destination configurations or 25 attachment records. All 25 original attachment files matched their stored byte sizes and SHA256 digests. `.env` and the MySQL schema file were unchanged by checksum. Existing browser regression tests added their normal fictional test bills/attachments; no existing bill was recreated or migrated.

No deployment, GitHub push, live-sync setting change, accounting mapping change or live Zoho bill posting occurred. Autocomplete has no remaining implementation blocker. An existing ambiguous supplier identity still requires explicit administrator mapping; provider outages remain visible and retryable. Live bill synchronization readiness is unchanged and outside this task.

## Vendors dashboard company filter — 29 October 2026

The existing `/vendors` dashboard previously listed only locally saved suppliers through `/api/vendors`. It now requires an authorized company selection and displays that company's existing Books directory through a paginated read-only endpoint. The original local vendor endpoint and bill-entry autocomplete contracts are preserved.

### Changed files

- `src/components/vendors.tsx`: company selection, debounced search, paging, source/status labels, loading/empty/error/retry states and stale-response isolation. The existing Add vendor form remains available and inherits the selected company; it explicitly creates a workspace vendor.
- `src/components/types.ts`: directory response types.
- `src/app/globals.css`: scoped directory filter and notice styles.
- `src/lib/services/bill-vendor-lookup.ts`: extends the existing company/destination/transport mechanism with `listCompanyVendorDirectory`. MANAGEMENT retains directory read access without gaining bill-entry supplier selection permissions. Membership, destination and Books authorization are rechecked after provider reads.
- `src/app/api/vendors/directory/route.ts`: authenticated GET with a strict company/search/page contract. Organization and credential selection stay on the server.
- `tests/vendor-directory.test.ts`, `tests/vendor-directory-routes.test.ts`: directory and HTTP-boundary fixtures.
- `tests/vendor-directory.integration.test.ts`: seven disposable MySQL tests covering Management access, literal search, pagination, organization isolation, read-only listing and access/destination changes during a request.
- `tests/e2e/vendor-directory.spec.ts`: eleven browser tests covering company selection, search, paging, stale responses, scope rejection, empty/failure/retry states and the existing local create flow.

### Results

- Authenticated read-only Books checks found **69 Switchgear vendors** in organization `802911060` and **982 Contracting vendors** in organization `828765858`. Contracting returned ten pages: nine with 100 vendors and one with 82. Every row matched the selected internal company and exact Books destination; IDs were unique across each organization's pages.
- The directory includes active/inactive vendors and valid currencies beyond the bill-entry currency choices. It uses provider pagination without importing contacts or creating local supplier records. Configured Books failures display a retryable warning instead of presenting a partial local cache as the full directory.
- Actual local browser checks displayed all 69 Switchgear vendors, returned 22 matching `TRADING` searches, switched to Contracting page 2, and switched back without stale rows. Desktop and 390px mobile views passed; no browser page errors or document overflow were observed. The local development server was restarted after a stale runtime module error; the repeated browser check succeeded.
- **894 unit tests passed.**
- **151 MySQL integration tests passed; one optional Hub fixture test skipped.** The disposable database and temporary users were cleaned up successfully.
- **65 browser tests passed; one existing provider-consent test skipped because the isolated server disables provider networking.** This includes existing bill-entry/editing, attachments/retry, duplicate prevention, OCR, autocomplete, line VAT and mocked synchronization checks.
- Full lint, TypeScript checks, production build and release privacy scan passed. The privacy scan checked 1,043 build files.
- Before/after verification preserved all **37 pre-existing bills and their lines, three vendors, four companies, company destinations and 31 attachments**. Attachment bytes matched their stored sizes and SHA256 digests. Existing browser workflow tests added three normal fictional bills and attachments. `.env` and the active MySQL schema file retained their original checksums.

No remaining implementation blocker for the company vendor directory. No schema migration, production configuration change, accounting mapping change, deployment, GitHub push, vendor import or live Zoho bill posting was performed for this dashboard change.
