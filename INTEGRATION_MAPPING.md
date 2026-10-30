> Current scope, 28 October 2026: Save and sync finalizes bills as READY and queues their exact company destination without separate approval or preview confirmation. The guarded production branch is disabled locally; `[CONNECTION CHECK]` demo workspaces cannot post or establish real-company accounting assignments. No provider financial write or hosted deployment has occurred. See [setup](docs/LIVE_SYNC_SETUP.md) and [current validation/status](docs/APPROVAL_FREE_SYNC_VALIDATION.md). [The earlier live-sync report](docs/LIVE_SYNC_VALIDATION_REPORT.md) predates this policy. Active MySQL access requires company destinations and current membership; the [signed Hub read view](docs/HUB_BILLING_BRIDGE.md) is implemented. Earlier shared-workspace/no-company descriptions and prior provider diagnostics/test counts are historical.

# VOLTRONIX integration mapping and operating contract

Update, 29 October 2026: the owner approved local shared-CRM lookup for both existing companies. The application's own CRM grant and company-filtered reads now pass; `/bills/manual` searches CRM and saves one explicitly selected job locally. `CompanyCrmSource` preserves the unique Books accounting destinations. See [current CRM setup and validation](docs/ZOHO_CRM_SETUP.md). No financial posting or deployment was enabled.

Status: implemented and tested against local mocks. **No live Books bill, CRM expense, OAuth grant, payment, or attachment was written during this build.** Credentials are not established by the read-only CRM connector. Configuration alone never produces a Connected or Synced label.

The statement above describes the original build milestone. For actual grant/consent status, consult the current validation report. The production branch requires HTTPS production runtime, a restricted operational database, verified non-demo company routing/configuration, finalized source records, intact private originals and current writer permissions. New queued operations run without per-bill approval or confirmation. The development connection helper enables none of these financial permissions. Sandbox test authorization remains a separate path.

## Confirmed source mapping

Read-only connector metadata identified the existing VOLTRONIX production CRM organization, AED currency and Asia/Dubai timezone. The owner explicitly confirmed `Deals.JobDealNumber` as jobID and `Deals.Amount` as contract value on 27 October 2026. No production job amounts or accounting records were imported into this development database.

The CRM setup follow-up reverified ZGID `802911927`, `type=production`, `web_url=https://crm.zoho.com/crm/org802911927` and `api_url=https://www.zohoapis.com` through the connector's organization endpoints and Deals metadata. The app's own configured CRM refresh token subsequently passed exchange, organization verification and both company searches on 29 October. [CRM setup instructions](docs/ZOHO_CRM_SETUP.md) document the approved local path, recovery callback and exact read scopes.

| Local value         | Existing CRM source                | Evidence / guard                                                                                             |
| ------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Job external ID     | `Deals.id`                         | Stable remote record identity; unique locally                                                                |
| Job number          | `Deals.JobDealNumber`              | Owner confirmed; CRM field is text and is **not declared unique**                                            |
| Job name            | `Deals.Deal_Name`                  | Metadata confirmed                                                                                           |
| Contract value      | `Deals.Amount`                     | Owner confirmed; null remains unavailable                                                                    |
| Customer name       | `Deals.Account_Name.name`          | Existing Accounts lookup; never create a customer                                                            |
| Currency            | `Deals.Currency`                   | Metadata confirmed; reject unsupported currencies and currency changes on jobs with bills                    |
| Company assignment  | `Deals.Books_Organization_ID`       | Verified text field; must exactly match the selected company's existing Books destination                    |
| CRM stage preview   | `Deals.Stage`                      | Sales-stage information only; not bill status or job completion                                              |
| Approved variations | Optional verified configured field | No production source field confirmed; new jobs default zero, reimports preserve existing approved variations |

The administrator imports one existing Deal by its external record ID. The adapter verifies organization ID and environment, reads the requested fields, searches the job number, and checks exact normalized uniqueness. It refuses incomplete search pages, missing matches, ambiguous records and local collisions. Reimport updates the same local `externalCrmId`; it never creates a CRM job. Without an explicit variations-field mapping, existing approved variations are preserved. An explicitly mapped variations field must contain a value. The audit records before/after job number, currency, contract value and approved variations. Search-result matching is deliberately stricter than the provider's text `equals` search. [Zoho CRM search contract](https://www.zoho.com/crm/developer/docs/api/v8/search-records.html).

`Projects` was not API supported in the inspected organization. Existing `Vendors` and `Purchase_Orders` did not establish a supplier-expense-to-job relation. `Invoices` contains customer invoice relationships and **is not a supplier-bill target**. Deals' related lists did not contain a verified supplier expense list. `Books_Organization_ID` values now establish company routing for job lookup; quote, sales-order and customer invoice fields are not treated as supplier expenses. The new selection endpoint preserves existing local job values and refuses conflicts; the legacy Admin reimport behavior described above is unchanged.

CRM expense POST remains blocked until an administrator supplies a verified expense module, job lookup and unique internal-bill-reference field, with acceptance evidence. The current supported alternative is the authenticated application summary `GET /api/crm/jobs/{localJobId}/expenses`; Admin, Accounts and Management receive local READY/historical APPROVED expense totals, payment totals and linked bills for that job. It requires the normal application session and is not a public or token-bearing URL. Installing a CRM widget or service-account authentication is a separate deployment step.

## Zoho Books supplier-bill mapping

The target is the Books v3 **Bills** resource. The actual Books organization, VAT IDs, chart of accounts and currency IDs have not been verified against a live Books connection. A CRM organization identifier must never be substituted for a Books organization identifier.

| Local finalized value                  | Books payload                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| Mapped vendor                          | `vendor_id` referencing an existing active supplier contact                       |
| Supplier invoice number                | `bill_number`                                                                     |
| Stable internal identity               | `reference_number = VX-BILL-{internalBillId}`                                     |
| Invoice and due dates                  | `date`, optional `due_date`                                                       |
| Named payment term                     | `payment_terms` as days; CUSTOM uses the entered due date                         |
| Currency                               | Reviewed `currency_id`; explicit reviewed `exchange_rate` for a non-base currency |
| Line description, quantity, unit price | `line_items[].description`, `quantity`, `rate`                                    |
| Expense classification                 | Reviewed category `account_id`, optional `item_id`                                |
| VAT                                    | Reviewed `tax_id` matching the local VAT percentage                               |
| JobID, purchase/order number           | Optional reviewed custom-field indices, also included in the source note          |

Expenses in this application exclude VAT. Books receives `is_inclusive_tax: false` and aggregate tax calculation. The adapter verifies the returned bill's source reference, vendor, invoice number, currency, gross total and tax total before confirming success. [Books Bills API](https://www.zoho.com/books/api/v3/bills/).

**Discount limitation:** the app supports a fixed discount before VAT. A safe equivalent for this policy has not been demonstrated against the Books supplier-bill contract. Nonzero discounts are blocked before any bill POST. They are not converted to a post-tax adjustment. Resolve and test this mapping before enabling discounted-bill synchronization.

Trusted operators maintain vendor mappings through the retained Admin-only backend endpoint with an explicit Books organization. It reads the existing Books contact and verifies active supplier status and matching currency, then updates only the local `VendorBooksMapping` and audit trail. There is no Integrations setup form. Mappings are scoped by vendor, organization, DC and environment; the same local vendor can have separate mappings for the two destinations. One external supplier cannot map to two local vendors within the same destination. The endpoint cannot create or modify a Books contact. Remapping a vendor with synchronization history for that organization is refused. Historical `Vendor.externalZohoId` values are preserved but are never reused as an implicit organization-specific mapping.

**Attachment limitation:** each finalized source document has a separate durable attachment operation. The adapter compares a downloaded remote attachment's SHA-256 before upload and after confirmation. Identical bytes are reused; a different existing attachment is never overwritten. Multiple-document behavior on the target Books edition must be validated. If the API exposes one attachment, the second different document remains blocked for operator review. A confirmed bill ID survives attachment failure, so a retry cannot recreate the bill. Private file path, signature, size and hash checks are integrity controls, not a malware-scan claim.

Local payments and cancellations do not silently mutate remote accounting. Local cancellation is frozen when there is pending, uncertain or confirmed external activity; use a separately reviewed accounting reversal. Payment export/reconciliation is not implemented. Recording a local payment cannot create another external bill.

## Configuration and OAuth

Store secrets only in the server environment or encrypted token storage. Never place refresh tokens, client secrets or the encryption key in browser fields, source control, logs, screenshots or query parameters.

Integration configuration is backend-managed. The Integrations menu/setup screen is removed and `/integrations` redirects to Bills. See [server integration setup](docs/SERVER_INTEGRATION_SETUP.md) for the operator procedure and a fictional token-map example. Existing authenticated APIs remain available; removing setup UI does not remove their access checks or establish a provider grant.

| Setting                                        | Purpose / default                                                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `INTEGRATION_NETWORK_ENABLED`                  | Defaults false; explicit permission for external requests                                                                        |
| `ZOHO_BOOKS_WRITE_ENABLED`                     | Defaults false; Books accounting worker gate                                                                                     |
| `ALLOW_PRODUCTION_ACCOUNTING_WRITES`           | Legacy deny switch: true blocks all writes; never enables the guarded live branch                                                |
| `ZOHO_BOOKS_LIVE_ENABLED`                      | Defaults false; additional live gate, requiring operational runtime, verified company routing and current writer permission      |
| `INTEGRATION_TEST_MODE`                        | Defaults false; explicitly enables the authorized nonproduction test mode only                                                   |
| `ZOHO_BOOKS_ORGANIZATIONS_JSON`                | Explicit array of `{organizationId,name,mapping?,testAuthorization?}` profiles; required for the selected two-organization setup |
| `ZOHO_BOOKS_REFRESH_TOKENS_JSON`               | Private bootstrap map of exact configured Books organization IDs to separate refresh tokens; never returned to browsers          |
| `ZOHO_BOOKS_TEST_AUTHORIZATION_JSON`           | Legacy single-organization attestation only; profile configurations use each profile's `testAuthorization`                       |
| `INTEGRATION_TOKEN_ENCRYPTION_KEY`             | Dedicated 32 random bytes encoded as 64 hex characters; required for OAuth storage                                               |
| `ZOHO_BOOKS_DC`, `ZOHO_CRM_DC`                 | Verified data center: US, EU, IN, AU, JP, CA, CN, SA or AE                                                                       |
| `ZOHO_BOOKS_ORGANIZATION_ID`                   | Legacy single-organization fallback only when no profiles JSON is configured; does not select a default among profiles           |
| `ZOHO_CRM_ORGANIZATION_ID`                     | Verified numeric CRM organization ID; CRM remains a single configured connection                                                 |
| `{prefix}_ENVIRONMENT`                         | Explicit `sandbox` or `production`                                                                                               |
| `{prefix}_CLIENT_ID`, `{prefix}_CLIENT_SECRET` | Registered server-side OAuth client                                                                                              |
| `{prefix}_REFRESH_TOKEN`                       | Optional single-organization bootstrap; a shared Books token is never used when multiple profiles exist                          |
| `{prefix}_MAPPING_JSON`                        | CRM override or legacy single-organization Books mapping; Books profiles use their own `mapping`                                 |

Here `{prefix}` is `ZOHO_BOOKS` or `ZOHO_CRM`. An environment label alone does not establish Books sandbox isolation. Sandbox writes require their separate nonproduction authorization. Production Books writes require every operational/company/bill gate in [LIVE_SYNC_SETUP.md](docs/LIVE_SYNC_SETUP.md); the local development target is blocked. OAuth consent alone relaxes neither gate. CRM sandbox requests use the distinct `sandbox.zohoapis.{domain}` host and additionally require the organization API's `type` to agree. Production CRM financial records are rejected when the application is not running with `APP_ENV=production`. This readiness review does not authorize any production CRM reads. [Zoho's sandbox guidance](https://help.zoho.com/portal/ja/community/topic/kaizen-120-a-guide-to-api-calls-in-zoho-crm-sandboxes).

### Two Books organizations with explicit company boundaries

The owner selected both Books organizations and confirmed the `books.zoho.com` domain. This maps to the app's **US / `.com`** accounts/API endpoints; it does not describe the companies' physical location or prove organization access. [Books regional endpoints](https://www.zoho.com/books/api/v3/introduction/).

Configure the destinations as profiles. This placeholder array intentionally fails validation until the IDs and labels are replaced with reviewed values:

```json
[
  {
    "organizationId": "<BOOKS-ORGANIZATION-A-ID>",
    "name": "<ORGANIZATION-A-LABEL>"
  },
  {
    "organizationId": "<BOOKS-ORGANIZATION-B-ID>",
    "name": "<ORGANIZATION-B-LABEL>"
  }
]
```

`ZOHO_BOOKS_ORGANIZATIONS_JSON` accepts 1–20 profiles with unique numeric-string IDs. Common DC, environment, client ID and client secret remain in the shared Books variables. Each optional `mapping` and `testAuthorization` belongs inside its own profile; global Books mapping/attestation variables are not inherited when profiles JSON exists. Missing optional mappings do not prevent initial OAuth. Malformed profiles fail closed rather than falling back to a legacy default.

With multiple profiles, OAuth and vendor mapping require an explicitly selected organization. Finalized bills auto-queue only the unique exact configured company destination; manual queue requests also select the organization explicitly. There is no first-organization default, even if `ZOHO_BOOKS_ORGANIZATION_ID` is also populated. Each organization uses its own valid encrypted grant or exact entry in the private `ZOHO_BOOKS_REFRESH_TOKENS_JSON` bootstrap map. An initial valid refresh token must come from an authorized Zoho OAuth process; the server cannot generate consent or use an account password as a substitute.

The map is a flat string-to-string JSON object with 1–20 entries, at most 128 KiB of UTF-8 input and tokens of 1–4,096 characters without whitespace/control characters. Unknown organizations, malformed JSON, invalid values and duplicate keys (including escaped equivalents) are rejected. Supplying both a nonempty map and scalar `ZOHO_BOOKS_REFRESH_TOKEN` is invalid. Partial maps are allowed: missing organizations may use their own vault grant but never another organization's token. When the map is absent, the legacy scalar is used only for a single profile and ignored for multiple profiles. Tokens do not belong inside the nonsecret organization profiles.

The active MySQL application enforces company membership on bills, vendors, jobs, documents and reports. External organization filters do not replace company permissions. Each canonical bill is bound to one exact company destination and cannot be sent to a second Books organization. Real company assignments must be verified independently; fictional companies and connection-check workspaces are not suitable operating companies.

A previously disclosed client secret must be revoked/rotated by the account owner and replaced securely, never reused or supplied through chat. See [current workflow validation](docs/APPROVAL_FREE_SYNC_VALIDATION.md); [the earlier connection report](docs/LIVE_SYNC_VALIDATION_REPORT.md) is historical. Local connection checks use private Books settings and isolated accounting-disabled workspaces; they must not import real financial records or enable accounting writes. Provider access remains subject to its authorized environment and operation.

### Nonproduction test authorization

Keep all write flags false until an accountable operator has independently verified the destination's isolation and the actual mappings. Books organization metadata exposes identity, active status and currency; it does not establish nonproduction isolation. The attestation is trusted operator configuration, not a provider-issued proof or an authorization granted by this application. Evidence references must point to retained approval/isolation records outside this repository.

With verified configuration injected securely, `npm run check:integrations -- --test-configuration-hash --organization-id=<selected-ID>` prints only the selected configuration digest. The organization option is mandatory for multiple profiles. It does not contact Zoho or authorize a test. Put a separately approved record of this shape under the selected profile's `testAuthorization` through the secret manager, replacing placeholders only with reviewed values. The standalone `ZOHO_BOOKS_TEST_AUTHORIZATION_JSON` is retained only for the legacy configuration without profiles:

```json
{
  "mode": "nonproduction",
  "organizationId": "<verified-test-Books-organization-ID>",
  "dataCenter": "<verified-DC>",
  "configurationHash": "<digest-from-the-read-only-command>",
  "approvedBy": "<operator-reference>",
  "approvalReference": "<approved-test-ticket>",
  "isolationEvidenceReference": "<reviewed-isolation-evidence>",
  "verifiedAt": "<UTC-ISO-timestamp>",
  "expiresAt": "<later-UTC-ISO-timestamp-within-24-hours>"
}
```

This placeholder example is intentionally invalid and grants no permission. Require `INTEGRATION_NETWORK_ENABLED=true`, `INTEGRATION_TEST_MODE=true`, `ZOHO_BOOKS_WRITE_ENABLED=true`, `ZOHO_BOOKS_ENVIRONMENT=sandbox` and legacy `ALLOW_PRODUCTION_ACCOUNTING_WRITES=false` together. Expired, future-dated, overlong or mismatched attestations fail closed. The digest binds product, DC, organization, environment, OAuth client credentials and parsed Books mappings; any change needs a new review. Expiry is checked again before each POST, including after asynchronous preflight/token work.

Before every bill or attachment POST, the transport performs an uncached `GET /books/v3/organizations/{organization_id}` and requires the exact approved ID, active status, base currency code and mapped currency ID. Missing/mismatched metadata blocks the POST. This requires `ZohoBooks.settings.READ`. [Organization contract](https://www.zoho.com/books/api/v3/organizations/). These are mocked contract checks in this checkout; no live organization check has run.

New outbox snapshots bind the DC and environment as well as the stored organization ID. Legacy snapshots lacking destination evidence fail closed in the real adapter and need operator review; they must not be rewritten to force submission. Queue audits retain the approval reference. Disable test/write/network flags after the authorized window and retain all unknown outcomes for reconciliation.

Hosts are selected from a fixed regional allowlist; arbitrary provider URLs, redirects, path traversal and organization-query overrides are refused. Canada uses `accounts.zohocloud.ca`. Token responses must identify the configured API origin. Verify the actual data center rather than inferring it from a company's country. [Books regional endpoints](https://www.zoho.com/books/api/v3/introduction/), [Zoho multi-DC OAuth](https://www.zoho.com/developer/oauth/multi-dc-support.html).

Register these exact callback paths beneath the configured HTTPS `APP_URL`:

```text
/api/integrations/oauth/zoho/callback
/api/integrations/oauth/crm/callback
```

The retained Admin-only backend authorize action accepts the selected `organizationId`, returns a provider authorization URL and uses offline consent. It supports operator authorization/recovery without an application setup screen. OAuth state is random, hashed, single-use, expires after ten minutes and is bound to the administrator, target, organization and connection fingerprint. The callback resolves its organization from the stored state, never from a callback query override, and returns to Bills. Register the same callback for both Books consent flows; do not append organization IDs to it.

Credentials use the composite identity `(target, organizationId)` and AES-256-GCM encryption. Every use checks that organization's stored revocation and connection identity before cache reuse; renewal uses a compare-and-swap scoped to the same organization. Changing the selected organization, common data center/environment or client credentials requires matching authorization. Rotating the common client secret requires reauthorizing both organization connections. A bounded response parser and timeouts apply to both OAuth and data requests. [Books OAuth contract](https://www.zoho.com/books/api/v3/oauth/).

The historical PostgreSQL migration 006 preserved legacy credentials under `organizationId="__legacy_unscoped__"` and revoked them; legacy OAuth states received the sentinel and expired. The active credential service retains those protections: an old organization cannot be recovered safely from a fingerprint, so no organization is guessed and no token is copied into both profiles. A selected organization with no scoped credential cannot fall back to a scalar or mapped environment refresh token while a legacy credential row remains for the same product, including a revoked row. Explicit per-organization reauthorization is required; old encrypted values remain preserved for an authorized recovery review. Valid stored scoped grants and rotated tokens also take precedence over environment bootstrap values; revocation or a changed connection fingerprint cannot be bypassed with the map.

`GET /api/integrations` remains an authenticated backend readiness endpoint. It returns organization IDs/labels, callback URLs and safe readiness flags, never credentials, token-map contents or accounting mappings. It includes `zoho.organizations` with per-organization readiness and `requiresOrganizationSelection`; aggregate authorization is disabled for multiple profiles. The retained authorization endpoint still requires valid product configuration, a valid callback, networking enabled and a correctly shaped encryption key. OAuth prerequisites are distinct from accounting-posting prerequisites; a configured production Books account can be ready for OAuth while accounting writes remain disabled. Actual credential use still requires the authorized environment/account scope; readiness does not override the development-data policy. Books consent includes `bills.CREATE`; do not describe it as read-only provider consent merely because the application's posting gate is disabled.

Requested Books scopes: `ZohoBooks.bills.CREATE`, `ZohoBooks.bills.READ`, `ZohoBooks.contacts.READ`, `ZohoBooks.settings.READ`. Requested CRM scopes: `ZohoCRM.modules.deals.READ`, `ZohoSearch.securesearch.READ`, `ZohoCRM.modules.vendors.READ`, `ZohoCRM.settings.modules.READ`, `ZohoCRM.settings.fields.READ`, `ZohoCRM.org.READ`. No CRM write scope is requested.

Fictional Books mapping example — these IDs are placeholders, not VOLTRONIX records. Place each reviewed mapping under the appropriate profile's `mapping`, not in the other organization's profile or the legacy global mapping variable:

```json
{
  "verified": true,
  "baseCurrency": "AED",
  "currencies": { "AED": { "id": "1001" } },
  "taxes": {
    "5.00": { "id": "1002", "percentage": "5" },
    "0.00": { "id": "1003", "percentage": "0" }
  },
  "categories": {
    "MATERIALS": { "accountId": "1004" },
    "LABOUR": { "accountId": "1005", "itemId": "1006" }
  },
  "jobCustomFieldIndex": 1,
  "orderCustomFieldIndex": 2
}
```

Every category and VAT rate actually used must have a verified mapping; zero-rated/exempt treatment is not inferred. Optional item IDs and custom-field indices must be checked in the target organization. Exchange rates are never guessed. Validate rounding and tax behavior using approved test cases before enabling real bill creation.

The owner-confirmed CRM mapping is the default. An override must explicitly declare itself reviewed:

```json
{
  "verified": true,
  "jobModule": "Deals",
  "jobNumberField": "JobDealNumber",
  "jobNameField": "Deal_Name",
  "jobValueField": "Amount",
  "customerField": "Account_Name",
  "currencyField": "Currency"
}
```

## Queue, retry and reconciliation

Save and sync finalizes the bill as `READY` and queues its uniquely configured company Books destination in the same transaction when network, mapping and write gates allow it. A manual original must finish uploading before finalization; OCR review attaches its retained original atomically. Missing, ambiguous or disabled configuration preserves the finalized bill with a visible synchronization error. After configuration is corrected, Admin/Accounts or an owning Data Entry user can queue the exact company destination directly. There is no second-user approval or preview confirmation. Historical `APPROVED` bills remain eligible without changing their recorded status.

`IntegrationJob` stores the finalized source snapshot and SHA-256, source version, initiating user, destination organization, stable unique operation key, attempts, due time and lease. The canonical creation key is bill/target-specific, not organization-specific: enqueueing the same bill for another organization is refused. Vendor lookup, mapping, OAuth token selection, retries, attachment work and reconciliation use the persisted destination. `IntegrationAttempt` retains safe outcomes. `SyncRecord` stores the externally confirmed ID and user-facing status. Uniqueness is scoped to target/organization/external ID, so different organizations may legitimately use the same numeric provider ID. Unscoped legacy external IDs retain a separate uniqueness constraint and matching IDs require review before confirmation.

Workers claim jobs with `FOR UPDATE SKIP LOCKED`; a lease token protects finalization. The stable bill key does not change on retries or local payment versions. Before creation, the adapter searches the exact internal source reference and verifies any found bill. Uncertain writes, failed post-create confirmation and expired worker leases enter `UNKNOWN`. Automatic POST replay is prohibited. A user must schedule **reconcile**, which only reads. An absent, partial, duplicated or mismatching result remains unknown; it is not proof that creation failed. Operator review is required before any separate recovery procedure.

Legacy synchronization records with pending, unknown or confirmed activity, or recorded attempts but no canonical queue job, cannot be overwritten into a new creation job even when their external ID or organization is absent. Resolve their original outcome through an authorized recovery process. Worker lifecycle audits retain the organization ID as well as the job reference.

Known transient read failures and provider throttling use bounded exponential backoff, honoring Retry-After up to the configured cap, and stop after five automatic attempts. Authentication/mapping errors are blocked. Confirmed remote bills and attachment jobs remain distinct, so attachment repair preserves the bill's identity. This is conservative duplicate prevention; it does not claim an undocumented remote exactly-once guarantee.

Run one bounded worker batch from a protected application host:

```sh
npm run worker:sync -- --limit=5
```

The default batch is five operations, maximum 25. `--watch --limit=5` runs supervised continuous batches. New jobs with a recorded initiating user, including configured production jobs, are eligible for general batches; each provider write rechecks that user's access, company, runtime, destination, source and lease. Historical production jobs without an initiating user keep their original permission/history and require exact `--job-id` execution. There is no public worker execution endpoint. Explicit read reconciliation remains subject to network and current destination permissions. Coordinate database/document backups and preserve the encryption key in a **separately protected recovery store** before deployment or key rotation. Replacing `INTEGRATION_TOKEN_ENCRYPTION_KEY` does not migrate ciphertext; a controlled re-encryption/reauthorization procedure and recovery drill remain unverified. Never delete unknown jobs to force a retry.

Rotated provider refresh tokens are persisted with an audit entry, and environment bootstrap imports encrypted credentials into durable storage before use completes. Renewal coalescing is process-local, with compare-and-swap persistence against revocation/rotation. Cross-process web/worker refresh and provider token-reuse behavior still require nonproduction acceptance; same-process mocks do not establish this operationally.

## Application API and roles

| Endpoint                                          | Role / behavior                                                                                                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/api/integrations`                           | Authenticated readiness; no credentials returned and no provider request                                                                                                          |
| GET `/api/integrations/jobs`                      | Admin, Accounts, Management; optional organizationId filter, latest 100 operations and 10 history entries each; no source snapshots or lease secrets                              |
| POST `/api/bills/{id}/sync/preview`               | Retired: HTTP 410; no new challenge is issued                                                                                                                                     |
| POST `/api/bills/{id}/sync`                       | Admin, Accounts, or owning Data Entry; `{ target: "ZOHO", organizationId }`; READY/historical APPROVED; confirmation payload rejected; one company-bound destination; CRM blocked |
| POST `/api/integrations/jobs/{id}`                | Admin, Accounts; action retry/reconcile, optional matching organizationId; persisted destination cannot change                                                                    |
| POST `/api/integrations/oauth/{target}/authorize` | Admin; target zoho/crm, body `{ "organizationId": "<selected-ID>" }` for Books; returns authorizationUrl                                                                          |
| GET `/api/integrations/oauth/{target}/callback`   | Admin session plus single-use organization-bound OAuth state; static callback path                                                                                                |
| GET `/api/integrations/vendor-mapping`            | Admin, Accounts, Management; selected organizationId, returns only mappings for its configured DC/environment                                                                     |
| POST `/api/integrations/vendor-mapping`           | Admin; `{ vendorId, externalZohoId, organizationId }`; verified existing supplier in that destination                                                                             |
| POST `/api/integrations/crm/import-job`           | Admin; `{ externalId }`; existing Deal only                                                                                                                                       |
| GET `/api/crm/jobs/{localJobId}/expenses`         | Admin, Accounts, Management; lifetime READY/historical APPROVED local summary                                                                                                     |

Mutations require same-origin checks; OAuth callback uses the state binding instead. Management is read-only. Data Entry may finalize and queue its own bills but cannot inspect organization-wide synchronization history. Status `AUTHORIZED_UNVERIFIED` means credentials exist, not that the Books organization or accounting behavior passed a live acceptance test.

## Verification and remaining acceptance evidence

Mocked unit tests exercise payload mapping, unsafe discount/mapping rejection, existing-reference reuse, external-total mismatch, duplicate references, attachment integrity, uncertain post-write confirmation, timeouts, throttling, response size limits, token encryption, revocation, connection rotation and the confirmed CRM field mapping.

Historical disposable PostgreSQL tests covered the former approval enqueue workflow and its retry/reconciliation safeguards. Current disposable MySQL tests cover finalization without separate approval, repeated enqueue, worker claims, cancellation freeze, unknown outcomes, read-only reconciliation, interrupted leases, attachment-only retries, company isolation and idempotent existing-job import. Multi-organization unit tests cover explicit selection, distinct vendor mappings, one-destination enforcement, organization-scoped credentials/state, token-map validation and safe legacy handling. Provider calls in these tests are mocked; no live credentials are required. Current executed results are recorded in `IMPLEMENTATION_STATUS.md`; no live connection is inferred from a passing local test.

Before enabling external accounting writes, obtain and record: actual Books organization ID/data center; approved client and scopes; active supplier mappings; chart-of-accounts/item/currency/tax/custom-field mapping; approved live-write authorization; expected rounding and tax totals; discount policy resolution; multi-attachment behavior; and an authorized provider acceptance result. For CRM expense creation, separately verify the target expense module and unique source-reference field, or approve the authenticated application summary/widget approach. No such live acceptance is claimed in this build.
