# Zoho CRM server configuration

## Job and bill search — 30 October 2026

Manual entry and the dashboard now accept **Job ID, bill number or job name** with a **Search** button. Choose **View job history** to open all verified linked invoices and their original Open/Download actions. Bill-number results resolve the job through verified identities; ambiguous companies remain separate choices. Existing live CRM search and **Use CRM job** still provide source verification when needed. See [job bill history](JOB_BILL_HISTORY.md) for current attachment behavior and historical source-link limitations. The following dated workflow describes the earlier milestone.

## Job-first manual entry — 29 October 2026

The dashboard's Manual entry card opens `/bills/manual`. Enter the Job ID and select **Find job**; no company selection is required. Results identify the company automatically from the verified CRM Books organization assignment. If the same reference belongs to multiple authorized companies, the results show those companies separately for an explicit job selection. Add bill opens the existing form with an independently verified local job, company and currency. Missing or unauthorized query jobs cannot silently open an unrelated editable bill. Existing direct new-bill, editing and OCR routes are preserved.

The lookup searches saved jobs and live CRM jobs across the user's authorized company sources. Enter a job-number prefix such as `5384` or `JOB-5384`, or the full numeric CRM record ID. For short numeric input (up to 14 digits), CRM searches both the entered number and its `JOB-` prefix within each company's Books organization; leading zeros are preserved. Numeric input of 15–30 digits retains exact CRM record lookup. Saved-job search additionally supports names. Choose **Use CRM job** to verify the source again and save one selected job in the existing Job table, then open its detail and **Add bill**. Searches do not import jobs. Repeated selection reuses the same local record; a conflicting identity, currency or contract value requires review instead of overwriting existing data.

Job totals are calculated from current local bills and refresh every 15 seconds while the page is visible, and when returning to the page. Finalized READY/APPROVED costs count net of VAT; drafts and cancellations do not. Paid/outstanding figures include VAT. Transient refresh failures mark retained amounts as stale; lost access clears the financial data. This view does not import historical Zoho Books bills or represent CRM sales stage as job completion status.

Changed application files: `src/components/manual-bill-entry.tsx`, `src/app/(app)/bills/manual/page.tsx`, `src/components/dashboard.tsx`, `src/components/jobs.tsx`, `src/components/bill-form.tsx`, `src/components/types.ts`, `src/app/globals.css`, and `src/lib/services/catalog.ts`. Regression coverage is in `tests/e2e/manual-job-entry.spec.ts` and `tests/company-isolation.integration.test.ts`.

Latest validation for automatic company detection: 1,022 unit tests, 159 disposable-MySQL integration tests and 27 targeted browser tests passed (21 job-entry cases and six existing application workflows). One optional Hub fixture was skipped. Full lint, TypeScript checks, production build and release privacy scan passed (1,117 build files). All eight existing migrations applied on the fresh disposable test database and cleanup succeeded. Actual desktop/mobile searches sent only the Job ID and correctly identified both companies, with no page errors or horizontal document overflow. The preceding full-browser baseline passed 85 cases with one provider-consent skip. There are no remaining failed checks or local CRM connection blockers.

New coverage: `tests/crm-source-authorization.test.ts` (32 authorization/setup cases), `tests/crm-job-lookup.test.ts`, `tests/crm-job-routes.test.ts`, `tests/crm-job-lookup.integration.test.ts` (six real-SQL cases), and `tests/e2e/manual-job-entry.spec.ts` (21 browser cases). Automatic lookup tests cover independent companies, identical references, stale requests, partial failures, changed access and correct bill prefill. `tests/oauth-callback-navigation.test.ts` expects the CRM recovery page. Existing bill entry, attachments and payment/save retry workflows passed again; prior vendor, accounting-line, OCR and sync regression results remain recorded above.

The automatic-company follow-up changes `src/components/manual-bill-entry.tsx`, its two-column search styling in `src/app/globals.css`, `src/lib/services/crm-job-lookup.ts`, and `src/app/api/jobs/search/route.ts`, plus the four lookup/browser/SQL test files above. Omitted `companyId` now returns a `companyId: null` search envelope with each result's verified company/source identity. Existing explicit-company API requests still work. The server searches at most 20 authorized bindings with bounded concurrency and rechecks all source/access snapshots before returning. This follow-up required no schema, environment, mapping, posting-setting or deployment changes.

### Newly verified provider evidence

The direct Zoho CRM connector successfully read organization metadata, Deals fields and a ten-record sample of Deals with a nonempty `JobDealNumber`. Organization `802911927` remains production with AED currency. `Books_Organization_ID` exists as a text field, and the sample contains jobs assigned to both Books organizations `828765858` and `802911060`. `Stage` exists as a sales-stage field. The application's own configured CRM refresh token was then successfully exchanged into the existing encrypted vault, and its own `/crm/v8/org` and company-filtered Deals searches passed. No additional user consent was needed.

No real job was imported during acceptance checks and no provider financial write or deployment occurred. The approved local schema addition and read-network setting are described below. Hashes and counts for ten existing business tables were identical before and after setup. Browser workflow regression tests use their existing fictional data and normal local test records.

### Approved local shared CRM source

The current `CompanyIntegrationDestination` unique key assigns one provider organization to exactly one company. It remains appropriate for accounting destinations and must not be weakened merely to share a CRM source. Both real companies use the same CRM source organization, so live lookup needs a separate read-source binding to the existing company records.

Applied additive migration `202610290003_shared_crm_source`: `CompanyCrmSource` has `companyId` as its primary key and restrictive foreign key to the existing Company, plus `organizationId`, `dataCenter`, `environment` and `createdAt`. The source organization/DC/environment index is not unique. Both existing companies now share the verified CRM read source while preserving every existing accounting destination constraint. No company, vendor or bill table was duplicated. An initial foreign-key collation mismatch was corrected to the existing `utf8mb4_0900_bin` convention before successful application; the failed CREATE made no business-table changes.

The lookup verifies CRM organization/environment and maps each Deal's `Books_Organization_ID` to the selected company's existing Books destination. It rechecks current role, membership, source/configuration and grant; rejects missing, ambiguous or changed assignments; and resolves only an explicitly selected verified job. DATA_ENTRY responses hide contract/variation values. Admin authorization requires current access to every company sharing the source, binds OAuth state to that source set, verifies provider organization before storing an encrypted grant, and rechecks membership transactionally. Financial posting gates remain unchanged.

The user explicitly approved local shared-CRM mapping and authorization setup on 29 October. Only local `ZOHO_CRM_NETWORK_ENABLED` changed from false to true; all Books/live/test-write switches, mappings and company provenance flags were preserved. Source bindings were added to the two existing company IDs, not inferred from display names. `prepareLocalCrmSources` and `scripts/crm-connect-local.ts` support guarded local operator setup after migrations, using explicit `ALLOW_CRM_LOCAL_CONNECTION_SETUP=true` and private ACCOUNT_OPERATOR credentials. Existing different bindings and previously linked jobs without a source are refused for review. Source replacement needs an explicit migration/relink review; there is no reassignment UI or silent rebinding.

Added backend files: `src/lib/integrations/crm-source.ts`, `src/lib/services/crm-authorization.ts`, `src/lib/services/crm-local-connection.ts`, `src/lib/services/crm-job-lookup.ts`, `/api/jobs/search`, `/api/jobs/resolve` and `/api/integrations/crm/authorization`. OAuth, integration status and the transport's CRM-search HTTP 204 handling were extended. Added UI: `src/components/crm-authorization.tsx` and `/account/crm-authorization`; manual entry uses the new search/resolve endpoints. The MySQL schema/migration is additive. No PostgreSQL archive schema was changed.

Updated 29 October 2026. CRM configuration remains server-managed, separately from Books. The Admin authorization/recovery page is `/account/crm-authorization`. Use [server integration setup](SERVER_INTEGRATION_SETUP.md) for the general operator procedure. The original legacy import endpoint still blocks production imports into development; the new explicitly approved, company-scoped local selection path is separate. Neither path enables CRM expense writes or deployment.

## Previously verified metadata

On 27 October 2026, the connected CRM service returned organization and Deals field metadata only. No Deal, customer, invoice, payment or other financial record was retrieved. That connector's grant is separate from this application's OAuth; the evidence does not establish an application token or current provider acceptance.

| Item                | Historical verified value                             |
| ------------------- | ----------------------------------------------------- |
| CRM organization    | VOLTRONIX, ZGID `802911927`, environment `production` |
| CRM UI URL          | `https://crm.zoho.com/crm/org802911927`               |
| API origin / DC     | `https://www.zohoapis.com`; app DC `US`               |
| Currency / timezone | `AED` / `Asia/Dubai`                                  |
| Job ID              | `Deals.JobDealNumber`, owner-confirmed authority      |
| Contract value      | `Deals.Amount`, owner-confirmed authority             |
| Other mapping       | `Deal_Name`, `Account_Name` lookup and `Currency`     |

Do not substitute a Books organization ID for this CRM ZGID. `JobDealNumber` is not declared unique in the inspected metadata; selection checks exact normalized uniqueness within the selected Books company and refuses incomplete search evidence. No variations field was inferred. Company assignment now uses the independently verified `Books_Organization_ID` field.

## Configure the separate CRM grant

Keep `ZOHO_CRM_DC`, `ZOHO_CRM_ENVIRONMENT`, `ZOHO_CRM_ORGANIZATION_ID`, `ZOHO_CRM_CLIENT_ID`, `ZOHO_CRM_CLIENT_SECRET` and `ZOHO_CRM_MAPPING_JSON` in private server configuration. Supply a valid authorized `ZOHO_CRM_REFRESH_TOKEN` only for CRM bootstrap, or use the existing CRM organization's valid encrypted vault grant. Books' token map does not configure CRM, and Books access/refresh tokens must never be reused for it.

The dedicated `INTEGRATION_TOKEN_ENCRYPTION_KEY` must be configured before bootstrap. Encrypted credentials are scoped by `(target, organizationId)`. Stored grants and token rotations take precedence; revoked or changed vault connections cannot be bypassed by supplying an environment token. Preserve the explicit authorization/recovery process and audit history.

An initial refresh token requires an authorized Zoho OAuth process. Server configuration does not manufacture a token or replace authentication with an account password. The Admin-only authorization endpoints and `/account/crm-authorization` are available for recovery. Register `/api/integrations/oauth/crm/callback` beneath the exact `APP_URL`; local and hosted registrations are separate. Use the same app origin, Admin session and state database through completion. Callback completion returns to the CRM authorization page.

The CRM authorization flow requests these read scopes:

```text
ZohoCRM.modules.deals.READ
ZohoSearch.securesearch.READ
ZohoCRM.modules.vendors.READ
ZohoCRM.settings.modules.READ
ZohoCRM.settings.fields.READ
ZohoCRM.org.READ
ZohoProjects.portals.READ
ZohoProjects.clients.READ
```

The two Zoho Projects scopes were added on 30 October 2026 to read existing project-to-CRM-job associations. `ZohoProjects.portals.READ` permits portal discovery through `GET /api/v3.1/portals`; `ZohoProjects.clients.READ` permits client/customer reads, including `GET /api/v3/portal/{portal_id}/projects/{project_id}/crm/deals`. The latter returns associated CRM Deal IDs. See the official [portal API](https://projectsapi.zoho.com/api-docs/portals) and [project CRM associations API](https://projectsapi.zoho.com/api-docs/clients_and_customers/project_customers).

An existing grant requires owner consent again through `/account/crm-authorization` to obtain these added permissions. Changing the requested scopes does not expand a saved token automatically. The consent page describes the requested reads before redirecting to Zoho. No CRM related-list metadata scope or Projects write scope is requested. After consent, exact portal/project/CRM identities and company boundaries must still be verified before associating bill history. Multiple CRM deals may share a project; that association alone does not establish each job's allocated invoice cost.

No CRM CREATE, UPDATE or DELETE scope is requested. Keep credentials private and enable provider networking only within the authorized account/environment scope. The legacy import guard remains unchanged. The approved local selection endpoint requires a shared-source binding, exact company routing and disabled financial-write modes before reading or saving a selected job locally.

## Checks and remaining limits

Run `npm run check:integrations` for presence/readiness only; it does not contact Zoho or print secrets. Saved-grant status alone does not prove current provider acceptance. The 29 October acceptance separately verified the application's own grant and both company searches. Historical Books bills, payments and revenue are not imported by this feature; job amounts and bill statuses summarize bills recorded in this workspace. Provider financial posting and production deployment remain outside this change.

The earlier authenticated local OAuth-start check returned HTTP 200 at 16:06 Dubai on 27 October with the expected accounts host, local callback and six READ scopes. Its diagnostic state was expired and session logged out. That check did not send an application request to Zoho or complete consent/token exchange. Its evidence remains historical in ignored `.local/crm-oauth-start-20261027.json` and `.local/crm-metadata-20261027.json`.

Automated scope, development-guard and credential-isolation tests use mocks. See [implementation status](../IMPLEMENTATION_STATUS.md) for executed validation. CRM expense display still requires an approved widget/related-list/module design and permissions; CRM customer Invoices are not a supplier-expense destination.
