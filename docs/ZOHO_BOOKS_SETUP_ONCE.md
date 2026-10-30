# Zoho Books server configuration

Updated 28 October 2026. Books setup is managed on the server. Billing has no Integrations menu or setup page; `/integrations` redirects to Bills. Users choose **Save and sync** after entering or verifying an invoice. Separate approval and per-bill preview confirmation are not part of that workflow.

Follow [server integration setup](SERVER_INTEGRATION_SETUP.md) for the environment/token-map example and [live synchronization setup](LIVE_SYNC_SETUP.md) for runtime and company requirements. No live supplier bill, new provider grant or hosted deployment is claimed by this guide. The local development database and connection-check demo companies remain accounting-disabled.

## Required operator inputs

Establish the exact Books organization IDs and names, data center, environment and OAuth client configuration. A CRM organization ID is not a Books organization ID. The companies' physical location does not establish their Zoho data center. Profiles in `ZOHO_BOOKS_ORGANIZATIONS_JSON` must have unique numeric IDs and each profile's own reviewed accounting mapping.

Configure real-company membership and the exact company-to-Books destination through trusted backend services. Active MySQL company boundaries apply to users, bills, vendors, jobs, documents and reports. The fictional development companies and `[CONNECTION CHECK]` workspaces are not real-company assignments. Never guess a destination from invoice text or send one bill to both organizations.

Before posting can work, the destination must have verified expense accounts, tax IDs/rates, currency IDs and any applicable custom fields. Each supplier needs its own destination-scoped mapping to an existing active Books contact. The protected Admin vendor-mapping endpoint reads that contact and records the local mapping; it does not create a remote contact. See [the mapping contract](../INTEGRATION_MAPPING.md) for retained API routes and current discount/attachment limitations.

## Private credentials

Use `ZOHO_BOOKS_REFRESH_TOKENS_JSON` for separate server bootstrap tokens keyed by exact configured organization ID. Leave `ZOHO_BOOKS_REFRESH_TOKEN` empty when the map is supplied. A partial map is allowed when omitted organizations already have their own valid vault grants; it never borrows another organization's token. Without a map, the legacy scalar token is used only for a single configured organization and ignored with multiple profiles.

The map accepts 1–20 entries, at most 128 KiB of UTF-8 JSON and token strings of 1–4,096 characters without whitespace/control characters. Malformed input, unknown organizations, duplicate keys (including escaped aliases), invalid values or simultaneous scalar/map credentials fail closed with a sanitized error.

An initial valid refresh token must come from an authorized Zoho OAuth process. Configuration does not generate provider consent, log in with an account password or prove organization access. Existing encrypted `(target, organizationId)` grants take precedence and retain rotated refresh tokens. Revoked grants, changed connection fingerprints and preserved legacy unscoped credentials cannot be bypassed with environment bootstrap tokens. Reauthorization/recovery must respect those records and preserve audit history.

Keep client secrets, refresh tokens and the dedicated 64-hex-character token-encryption key only in private server configuration or encrypted storage. Any previously disclosed secret must be rotated securely by its owner before reuse. Never place credentials in source, logs, browser fields, screenshots or chat.

## Optional operator OAuth endpoints

The existing Admin-only authorization and callback endpoints remain available for an operator's authorization/recovery flow. Their presence does not restore a setup screen or authorize production reads/writes.

For Books, the callback is `/api/integrations/oauth/zoho/callback` beneath the exact `APP_URL`. A local process at `http://127.0.0.1:3000` therefore needs that exact local callback registration; a hosted registration alone is insufficient. Use the same origin, active Admin session and state database from start through callback. For multiple profiles, explicitly select the intended organization. Stored state is single-use, expires after ten minutes and binds the selected organization and connection fingerprint. Callback completion returns to `/account/books-authorization`.

The application's Books scopes are:

```text
ZohoBooks.bills.CREATE
ZohoBooks.bills.READ
ZohoBooks.contacts.READ
ZohoBooks.settings.READ
ZohoBooks.accountants.READ
ZohoBooks.projects.READ
```

Because these include `bills.CREATE`, provider authorization must not be described as read-only merely because application write flags are disabled. Credential presence and `AUTHORIZED_UNVERIFIED` do not prove token exchange or financial acceptance.

## Verify configuration and operate safely

Run `npm run check:integrations` to inspect configuration presence/readiness without contacting Zoho or printing secrets. Keep all financial-write modes false during local setup. Actual provider checks need independently authorized environment/account scope; they have not been executed for this configuration change.

An eligible operational deployment additionally requires HTTPS, a production runtime with a restricted operational database, a verified active non-demo company destination, current writer permissions and intact finalized source records. The local loopback development installation is explicitly rejected for production writes. Flags alone cannot turn fictional fixtures into authorized bills.

The queue worker can process a bounded batch with `npm run worker:sync -- --limit=5` or run under supervision with `npm run worker:sync -- --watch --limit=5`. A saved/queued bill is not proof of synchronization: verify its confirmed provider ID and attachment completion. Unknown outcomes require read reconciliation instead of blind creation retries. Payment remains a separate authorized action.

Use [current workflow validation](APPROVAL_FREE_SYNC_VALIDATION.md) for the preceding workflow milestone and [implementation status](../IMPLEMENTATION_STATUS.md) for current checks. [Earlier connection evidence](LIVE_SYNC_VALIDATION_REPORT.md) records the historical UI/consent milestone and is not a current setup procedure or evidence of live posting.
