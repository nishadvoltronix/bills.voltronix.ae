# Server-managed integration setup

Updated 29 October 2026. Billing users enter an invoice and choose **Save and sync**. There is no Integrations menu; `/integrations` redirects to Bills. Trusted operators manage credentials, organization profiles and mappings on the server. The direct Admin-only `/account/books-authorization` link handles provider consent without accepting or displaying any credential values. The existing authenticated integration APIs remain available for operator workflows.

The manual form now shows the selected company's Books setup before saving, including missing or ambiguous destinations and unsupported discounts. Saving remains available when synchronization is blocked. The saved bill distinguishes a local draft, blocked synchronization, a queued request, incomplete attachment delivery and a provider-confirmed result. Pending status refreshes for up to two minutes without discarding an open form; **Refresh sync status** is also available. A failed status refresh is reported, and lost session/company access clears the loaded bill details. These UI checks do not replace server validation or provider confirmation.

The local development database and demo companies remain ineligible for production financial writes. The owner has now completed OAuth consent for both Contracting and Switchgear; both scoped encrypted grants are stored and authenticated read-only provider metadata access succeeded for each organization. See the dated [observed connection progress](BOOKS_OPERATIONAL_SETUP.md). No live Zoho bill or deployment has been performed.

## Authorize the two Books accounts first

On the application's actual origin, open `/account/books-authorization`. If the session is missing or expired, sign in as an Admin; login returns to this operator page. Each authorized company has its own **Connect** button. The browser goes to the configured Zoho data center; Zoho login and consent must be completed by the account owner. The callback exchanges the one-use code on the server and stores that organization's refresh/access tokens encrypted in the database. No token is returned to the browser or written into a public environment variable. A successful Books callback returns directly to the operator page with updated authorization status so the next company can be connected.

Register the callback displayed on that page exactly in the Zoho client. Local setup uses `http://127.0.0.1:3000/api/integrations/oauth/zoho/callback`; the hosted server uses `https://bills.voltronix.ae/api/integrations/oauth/zoho/callback`. The same application and Admin account must receive the callback. A domain pointing to the Coming Soon page cannot receive the application's callback yet.

The equivalent server command is `npm run books:authorize`, with explicit `ALLOW_BOOKS_AUTHORIZATION=true`, `BOOKS_AUTHORIZATION_ORGANIZATION_ID`, and trusted `ACCOUNT_OPERATOR_EMAIL`/`ACCOUNT_OPERATOR_PASSWORD` supplied privately. Its one-use authorization URL expires after ten minutes; do not collect it in shared logs. The command does not automate consent. Existing grants predating the `ZohoBooks.accountants.READ` scope need reauthorization before expense-account metadata can be verified.

Books authorization also requests `ZohoBooks.projects.READ` for project metadata. For an existing grant without project-read access, the account owner must use **Reconnect** on the exact company's card at `/account/books-authorization` and complete Zoho consent. Then repeat the project API inspection to verify access and any explicit job references. Granting this scope creates no job-to-bill links or financial allocations; existing financial-write checks still apply.

For a new production backend, create the operator with `npm run user:create`, then prepare each real company with `npm run company:prepare` before authorization. Preparation requires the exact configured company name/organization, an operator reference, a production runtime and disabled write flags; it never converts local demo companies. After consent, `npm run books:catalog` reads accounting options and `npm run books:verify-live` verifies the supplied mapping against actual provider metadata. See [operational setup](BOOKS_OPERATIONAL_SETUP.md) and the [own-server deployment package](../deploy/README.md).

## Configure private credentials and exact destinations

Use `.env.example` for variable names. Keep actual secrets in the ignored private server environment or an appropriate secret manager. Do not hardcode them in source, place them in browser forms, or pass them through command arguments, logs or chat. Restart the application and workers after configuration changes using the normal process supervisor.

Books needs a verified data center, environment, OAuth client ID/secret, organization profiles and a dedicated `INTEGRATION_TOKEN_ENCRYPTION_KEY` of 64 hexadecimal characters. Profiles contain nonsecret IDs, labels and each organization's accounting mapping. Never put refresh tokens inside profile objects.

The following uses **fictional IDs and invalid placeholder tokens**. Replace every value with independently verified configuration before use:

```dotenv
ZOHO_BOOKS_ORGANIZATIONS_JSON='[{"organizationId":"900001","name":"Example Company A"},{"organizationId":"900002","name":"Example Company B"}]'
ZOHO_BOOKS_REFRESH_TOKEN=""
ZOHO_BOOKS_REFRESH_TOKENS_JSON='{"900001":"REPLACE_WITH_VALID_TOKEN_FOR_900001","900002":"REPLACE_WITH_VALID_TOKEN_FOR_900002"}'
```

`ZOHO_BOOKS_REFRESH_TOKENS_JSON` is a flat object of exact configured organization IDs to token strings:

- It accepts 1–20 entries and at most 128 KiB of UTF-8 JSON. Tokens must be 1–4,096 characters with no whitespace or control characters.
- Malformed JSON, unknown organization IDs, nonstring or empty values, duplicate keys (including escaped spellings), and a nonempty map together with a nonempty scalar `ZOHO_BOOKS_REFRESH_TOKEN` are rejected.
- A partial map is allowed: an omitted organization may use its own existing encrypted vault grant. It cannot borrow another organization's token or the scalar token.
- With no map, the scalar Books refresh token remains a legacy bootstrap option for a single configured organization. It is ignored when multiple profiles are configured.

This is a bootstrap mechanism. The encrypted `(target, organizationId)` vault takes precedence, including rotated refresh tokens. A revoked grant, changed connection fingerprint or retained legacy unscoped credential cannot be bypassed by adding an environment token. Such records need the existing explicit reauthorization/recovery process; do not delete or rewrite audit history to force fallback.

An initial **valid OAuth refresh token** must already have been obtained through an authorized Zoho OAuth process with the required scopes. Server configuration cannot manufacture consent or replace provider authentication with a username/password login. The retained Admin-only OAuth endpoints can support an operator's authorization/recovery flow when required; no setup step is exposed in the Billing menu. If using those endpoints, register the exact callback under the same `APP_URL`, use the current Admin session, and select the exact Books organization. Books callback completion returns to `/account/books-authorization`; CRM callback completion returns to Bills.

CRM uses its own `ZOHO_CRM_*` client, organization, mapping and `ZOHO_CRM_REFRESH_TOKEN`. Never reuse a Books token for CRM. See [Books setup](ZOHO_BOOKS_SETUP_ONCE.md) and [CRM setup](ZOHO_CRM_SETUP.md) for scope and callback details.

## Keep connection checks separate from posting

Network access, financial-write flags and operational company verification are separate requirements. Start with all provider network/write modes disabled; enable only the specific connection checks that have been authorized. Keep these financial settings false during local configuration:

```dotenv
ZOHO_BOOKS_WRITE_ENABLED="false"
ZOHO_BOOKS_LIVE_ENABLED="false"
ALLOW_PRODUCTION_ACCOUNTING_WRITES="false"
INTEGRATION_TEST_MODE="false"
```

`ALLOW_PRODUCTION_ACCOUNTING_WRITES=true` is a legacy deny condition, not an enable switch. The global `INTEGRATION_NETWORK_ENABLED` and the applicable product's network flag must both permit a request. Their presence alone does not establish valid credentials or permit a bill POST.

Run the safe configuration inventory:

```powershell
npm run check:integrations
```

It reports presence/configuration readiness without printing secret values or contacting Zoho. `AUTHORIZED_UNVERIFIED` or a configured token is not proof of provider access. Provider acceptance must be verified separately within the authorized environment and account scope.

For a combined runtime and database inventory, run this from the application directory with the same private environment as the intended web/worker processes:

```powershell
npm run check:sync
```

This read-only command reports each configured organization's authorization metadata, exact company/destination verification, accounting mapping presence, real supplier/job counts and missing setup actions. It never decrypts tokens, calls Zoho, changes records or starts the worker. `BLOCKED` returns a nonzero exit status; `CONFIGURATION_PRESENT_UNVERIFIED` means only that the inspected configuration and metadata checks passed. Provider acceptance, database privileges, invoice-specific checks and worker health remain unverified. Secret values, hashes, company names and verification references are excluded from the JSON. Additional `.env.*` overrides are refused until their precedence is reviewed, as with `check:integrations`.

Operational posting also requires an exact active non-demo company-to-Books destination, verified destination configuration, existing supplier mappings, expense accounts, tax and currency mappings, current user membership and an eligible production runtime. Maintain these through trusted backend configuration/services; there is no general company-provisioning wizard. Do not assign real invoices to fictional test companies or infer the company from invoice text. [The mapping contract](../INTEGRATION_MAPPING.md) and [live-sync guide](LIVE_SYNC_SETUP.md) describe these checks.

## Operate the queue

After an eligible invoice is saved, the application queues its configured destination without a second approval. The worker must run on the protected application host with the same private configuration:

```powershell
npm run worker:sync -- --limit=5
npm run worker:sync -- --watch --limit=5
```

Choose the bounded command or supervise the continuous command. A queued bill is not yet a confirmed remote bill: inspect its saved synchronization result and required attachment completion. Unknown provider outcomes require read reconciliation; do not blindly repeat creation. Synchronization never automatically records a payment. Historical jobs without an initiating user retain their original exact-job execution rules.

## Executed checks

Verified Books project history has a separate read-only refresh worker: `npm run worker:job-history -- --watch`. Start it after the project-association migration and the initial source-verified cache import. It uses the incoming operator credentials and `INCOMING_SYNC_ENABLED`, checks for due work every five seconds, refreshes at most two existing projects per pass, and preserves complete proof for up to 24 hours while honoring provider cooldowns. Successful checks schedule the next refresh after five minutes. Exact project IDs connect newly imported bills to history without creating financial allocations or canonical jobs. See [deployment operation](../deploy/README.md#automatic-verified-project-history) for scopes, supervision and source limits.

On 28 October 2026, this backend-configuration/UI change passed 524 unit tests across 24 files, 17 isolated browser tests and one actual localhost:3000 browser check covering the redirect and absence of setup UI on desktop/mobile. Build, lint, typecheck and the privacy scan across 955 build files passed. The safe inventory reported two configured Books profiles, no scalar or mapped bootstrap token, accounting-write flags false and `providerVerified=false`. The preceding workflow milestone's 123 MySQL integration tests were not rerun for this UI/configuration-only change. Provider tests were mocked; no live token exchange or financial write occurred.

See [workflow validation](APPROVAL_FREE_SYNC_VALIDATION.md) for the preceding milestone and its limits. Earlier setup reports describe historical UI and verification milestones; they do not prove this backend configuration has received live provider acceptance.
