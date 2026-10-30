# Hub job billing read connection

Hub's job detail includes a Bills and payments panel. The connection is disabled by default. It reads existing Billing records and does not create jobs, import CRM records, change bills, approve payments or run Zoho synchronization.

The production Hub Express API authenticates the current Hub session, checks `dashboard.view` and the current task assignment/access, and resolves the stored active Zoho Deals identity. It sends a signed request to the fixed Billing endpoint `/api/hub/job-billing`. Billing independently resolves the exact Hub issuer/subject through `HubUserBinding`, rechecks the Billing user's active status, ADMIN/ACCOUNTS/MANAGEMENT role and active company membership, verifies the explicit CRM destination tuple, and matches the company, CRM Deal ID and job number. No cookie or database credential crosses between the applications.

Each HMAC-SHA256 request binds the method, path, issuer, audience, actor, company, CRM destination, Deal ID, job number and a random nonce. Requests expire after 30 seconds. Migration `202610280002_hub_bridge_nonce` stores consumed nonce hashes to reject replay across processes. Authentication state can be written; financial records are only read. Expired nonce rows are pruned during successful reads.

The response has totals for all READY and historical APPROVED bills and at most the newest 100 bill details, with the total count and an explicit truncation flag. Amounts remain decimal strings. It includes bill/payment status and amounts, the saved Books sync status, destination organization, confirmed remote ID and last sync time. These are saved Billing observations, not live provider checks. Hub constructs job and bill links from its fixed configured Billing origin and validated IDs. Unavailable, unauthorized and unlinked results contain no bill data. The current Save and sync workflow requires no separate bill approval; see [current validation](APPROVAL_FREE_SYNC_VALIDATION.md).

Before enabling the connection in an approved environment:

1. Provision reviewed `Company` records and active `UserCompanyMembership` rows. External organization labels do not establish company authorization.
2. Assign each CRM destination through `CompanyIntegrationDestination` using its verified organization ID, data center and environment. One complete external destination can belong to only one company.
3. Map the immutable Hub local user ID to the intended Billing user through `HubUserBinding`. The issuer is the exact Hub origin, including a development port. Do not infer bindings from email addresses or create them on first access.
4. Ensure the existing Billing job has the same company, verified CRM Deal ID and normalized job number. The Hub task must have its matching active CRM source observation; jobs without that association remain unlinked.
5. Inject a dedicated random 32-byte hex secret into both servers through the approved secret store. It must be independent of database passwords, session tokens and Zoho OAuth credentials.

Billing server settings:

```text
HUB_BRIDGE_ENABLED=true
HUB_BRIDGE_ISSUER=https://hub.voltronix.ae
HUB_BRIDGE_SECRET=<dedicated 64-hex secret>
```

Hub API settings:

```text
BILLING_BRIDGE_ENABLED=true
BILLING_APP_ORIGIN=https://bills.voltronix.ae
BILLING_BRIDGE_SECRET=<same dedicated secret>
BILLING_COMPANIES_JSON=[{"companyId":"reviewed-local-company-id","crmOrganizationId":"123456789","dataCenter":"US","environment":"production"}]
```

The JSON is an illustrative placeholder, not an authorized company assignment. `APP_ORIGIN` supplies Hub's issuer. Only the fixed `hub.voltronix.ae` and `bills.voltronix.ae` HTTPS origins are accepted in production. Explicit test/development profiles also accept `http://127.0.0.1:<port>`. Hub's launcher forwards bridge secrets only to its API process and blanks them for Next. The retained direct-Next development API reports this connection unavailable; production uses the Express composition.

Validation sources include `tests/hub-bridge.test.ts` and `tests/hub-bridge.integration.test.ts`. The latter runs real Billing MySQL checks and, when the sibling Hub source is present, calls the actual Hub signer/client over loopback HTTP. Setting `HUB_BRIDGE_MYSQL_FIXTURE` to a newly provisioned private native Hub fixture additionally runs Hub's actual Express application, HTTP login/CSRF and assignment checks against a separate real MySQL schema. That fixture is exclusively claimed and retained; a rerun requires a new fixture. The acceptance script does not load Hub's root or backend `.env`.

These local checks do not verify production TLS, reverse proxies, deployment, actual staff bindings or live Zoho acceptance. Keep the connection disabled until those environment-specific values and access assignments are reviewed.

Local acceptance on 2026-10-28 passed the complete Billing MySQL suite (84 tests across eight files, no skipped tests), including the actual native Hub application fixture. Its seven recorded HTTP checks cover anonymous denial, native login/CSRF, existing job detail, Hub-to-Billing summary, other-assignee denial, unlinked response and current assignment revocation. The retained safe receipt is `.local/mysql-dev/hub-fixtures/8e1b7bef-ad62-4caf-9951-09490b609d62/acceptance-result.json`. Hub's server emit build and isolated Next webpack production build passed without loading Hub's environment files; the frontend's ready/unlinked/unavailable panel states were separately exercised in Chromium.
