# Books connection checks and guarded live synchronization

The current workflow is **Save and sync**, with no separate bill approval or live-preview confirmation. Completed bills become `READY` and enter the Books queue when their exact company destination and operational settings allow it. Optional drafts remain available. Scanner/OCR extraction still requires the entry user to verify the original and its fields before saving. No save or synchronization records a payment.

Live bill posting is **not complete or enabled** in the local development installation at `http://127.0.0.1:3000`. Integration setup is managed through private server configuration and protected backend services; there is no Integrations menu or setup page. See [server integration setup](SERVER_INTEGRATION_SETUP.md). A configured OAuth token or completed consent alone cannot enable accounting writes. See [current workflow validation](APPROVAL_FREE_SYNC_VALIDATION.md); [the earlier live-sync report](LIVE_SYNC_VALIDATION_REPORT.md) records the superseded preview/approval milestone and local connection evidence.

The earlier hosted inspection found a “Coming Soon” page at `https://bills.voltronix.ae` with HTTP 200; `/login` and the Books OAuth callback returned HTTP 404. This task has not deployed the application there or changed its hosting. No live accounting write has occurred. These setup procedures are not evidence that consent or live synchronization succeeded.

## Current local connection check

The local application uses `voltronix_billing_dev` on MySQL loopback port `3308`. Keep `APP_ENV="development"` and `APP_URL="http://127.0.0.1:3000"`. The production runtime guard rejects this application/database combination for financial posting, including after OAuth succeeds.

The connection-only settings are:

```dotenv
INTEGRATION_NETWORK_ENABLED="true"
ZOHO_BOOKS_NETWORK_ENABLED="true"
ZOHO_CRM_NETWORK_ENABLED="false"
ZOHO_BOOKS_WRITE_ENABLED="false"
ZOHO_BOOKS_LIVE_ENABLED="false"
ALLOW_PRODUCTION_ACCOUNTING_WRITES="false"
INTEGRATION_TEST_MODE="false"
```

Only the global and Books network gates are needed for this connection check. All accounting-write modes stay disabled. `ALLOW_PRODUCTION_ACCOUNTING_WRITES` is a legacy deny switch: setting it to `true` blocks writes; it is not a shortcut for live authorization.

Keep the actual Books profiles, data center, OAuth client ID/secret and `INTEGRATION_TOKEN_ENCRYPTION_KEY` in the application's private environment. Do not paste credentials, tokens, consent callback codes or the contents of `.env` into chat or logs. The two configured Books organizations must retain separate profile entries and separate encrypted grants. A profile's configured name and ID do not establish that its company assignment is correct.

### Optional isolated connection workspaces

The local helper is `scripts/books-connect-local.ts`, backed by `src/lib/services/books-local-connection.ts`. It performs local metadata changes only; it makes no provider request and creates no bill or payment.

For each configured production Books profile, it creates a separate workspace named `[CONNECTION CHECK] <profile name>`, grants the authenticated Admin membership, and records an audit event. These workspaces have `isDemo=true` and `liveAccountingEnabled=false`; their destination records have `liveEnabled=false` and no accounting verification. They are **connection-check containers, not verified real-company accounting assignments**. Do not import real invoices into them or convert them into operating companies.

The helper accepts only the exact guarded local development database, or an explicitly identified disposable test database. It requires every accounting-write mode to remain disabled. Repeating it preserves the existing workspace and destination. It refuses an organization already assigned elsewhere, a changed workspace, existing bills, or an accounting-verified destination; it does not silently repurpose those records.

Run from `G:\bills.voltronix.ae` after the local migrations and generated client are current. Supply the active Admin password through a masked prompt:

```powershell
$env:ALLOW_BOOKS_LOCAL_CONNECTION_SETUP = 'true'
$env:ACCOUNT_OPERATOR_EMAIL = Read-Host 'Active local Admin email'
$booksOperatorPassword = Read-Host 'Admin password' -AsSecureString
$env:ACCOUNT_OPERATOR_PASSWORD = [System.Net.NetworkCredential]::new('', $booksOperatorPassword).Password
try {
    node --conditions=react-server --env-file=.env --import=tsx scripts/books-connect-local.ts
} finally {
    Remove-Item Env:ACCOUNT_OPERATOR_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:ACCOUNT_OPERATOR_EMAIL -ErrorAction SilentlyContinue
    Remove-Item Env:ALLOW_BOOKS_LOCAL_CONNECTION_SETUP -ErrorAction SilentlyContinue
    $booksOperatorPassword.Dispose()
}
```

The output contains safe workspace/destination identifiers, the local callback URL, `financialWritesEnabled:false` and `providerRequests:0`. It is not an OAuth success receipt. Use a fresh shell if earlier environment overrides remain: Node's `--env-file` does not replace values already present in the process environment.

### Configure each Books credential on the server

Supply a valid provider-authorized refresh token for each configured organization through `ZOHO_BOOKS_REFRESH_TOKENS_JSON`, or retain that organization's existing valid encrypted vault grant. The JSON keys must exactly match configured profile IDs; each token belongs only to that organization. Leave the scalar `ZOHO_BOOKS_REFRESH_TOKEN` empty when using the map. The server guide documents validation, partial maps and vault precedence. Do not place tokens in organization profile JSON or browser fields.

An initial valid token still requires Zoho OAuth authorization. The direct Admin-only `/account/books-authorization` page and authorization endpoints support an operator's authorization or recovery procedure. If using them locally, the registered redirect must exactly match `http://127.0.0.1:3000/api/integrations/oauth/zoho/callback`; the same app origin, session and state database must receive the callback. Books callback completion returns to the operator page with updated status. No account password login shortcut is implemented.

Restart the application and worker processes you own after private configuration changes, then run `npm run check:integrations`. This command checks configuration without contacting Zoho or printing secrets. A token's presence does not prove successful token exchange, supplier mapping or bill creation. A revoked or changed vault connection requires reauthorization; an environment token cannot override it. CRM credentials and scanner/Azure configuration remain separate from this Books check.

## What the production flow implements

The production branch is disabled by default and checks multiple independent conditions. The relevant code is `src/lib/integrations/config.ts`, `live-sync.ts`, `queue.ts`, `transport.ts` and the bill's synchronization panel.

- The runtime must have `APP_ENV="production"`, `NODE_ENV="production"`, `INTEGRATION_TEST_MODE="false"`, an HTTPS application origin and an operational MySQL configuration with a restricted runtime account. Development, test, demo and fixture database targets are rejected. The local port-3308 development installation is explicitly excluded.
- Network access, `ZOHO_BOOKS_WRITE_ENABLED` and `ZOHO_BOOKS_LIVE_ENABLED` must allow the configured Books destination. The legacy production deny switch must remain false. These flags alone do not authorize a bill.
- The real company must be active, non-demo and explicitly enabled for live accounting. The exact Books organization/data-center/production destination must be enabled and have an operator verification reference, verification time and a hash matching the current accounting configuration. Changed credentials or mappings can invalidate that proof. The local connection helper deliberately cannot create this verification.
- OAuth, accounting mappings and the supplier's mapping must belong to that exact destination. Demo vendors/jobs, cross-company source records, missing mappings and unfinished drafts remain blocked.
- A current Admin, Accounts or owning Data Entry user must retain bill access and company membership. The finalized bill snapshot, source version, full attachment list and private file integrity are checked when queued and again before provider writes. Management remains read-only.

No hosted deployment or operational company provisioning procedure has been executed by this task. A trusted operator must establish the real company, database permissions and destination proof through a separately reviewed operational setup. Do not repurpose the connection-check workspaces, rename a fixture database to evade the guard, or manually manufacture a verification hash as proof of provider acceptance.

## Save, synchronize and inspect the result

This sequence describes the implemented flow for a future authorized operational deployment. It must not be used to post a development fixture.

1. Select the correct company, vendor and job and enter the invoice details. With OCR or failed-OCR manual recovery, verify all fields against the retained original and check the field-verification box. This is the entry review, not a second-user approval.
2. Choose **Save and sync**. A manual entry first saves a draft, then uploads its selected original, and only then finalizes its exact saved version. An upload failure leaves the draft unqueued and exposes **Retry attachment**. OCR review links its original and finalizes in the same server transaction. **Save as draft** remains available when the entry is unfinished.
3. The finalized bill displays **Ready to sync** (`READY`). Its unique configured company destination is used for automatic queueing. Missing, ambiguous or disabled configuration leaves the saved bill with a visible synchronization error; it does not silently choose another company. After setup is corrected, an authorized writer can select the exact destination and use **Queue Zoho Books sync**, without an approval or confirmation dialog. Existing canonical operations retain their original destination.
4. Run the existing queue worker on the protected application host. A bounded batch or supervised continuous process executes new operations when all runtime and company checks pass:

   ```powershell
   npm run worker:sync -- --limit=5
   npm run worker:sync -- --watch --limit=5
   ```

   Use one of these commands according to the supervisor configuration. The watch process must be operated and monitored; the web application does not install it automatically. Attachment operations inherit the initiating user and saved snapshot. A queued result is not a synchronized result: inspect the confirmed provider ID and required attachment completion.

New operations have no per-bill challenge, expiry or approval step. The old preview endpoint returns HTTP 410 and the sync endpoint rejects confirmation payloads. Historical production jobs with no recorded initiating user keep their original permission/history and require exact `--job-id` execution; they are not silently converted into new automatic work. Unknown provider outcomes still require read reconciliation, not automatic bill-creation replay.

Finalization, synchronization and payment remain separate. `READY` and historical `APPROVED` bills contribute recognized costs; no save, queue or worker operation marks a bill paid. Payment recording remains a separate authorized Accounts/Admin action.

## Errors, reconciliation and validation

| Result                                                     | Meaning and next action                                                                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Live environment or company verification blocked           | The current runtime or company destination is not authorized for accounting writes. This is expected for the local connection-check workspaces. |
| OAuth consent succeeds but writes remain disabled          | Connection authorization was obtained; operational/company/bill authorization is still absent.                                                  |
| Draft or original changed while saving                     | Open the saved bill and review its current fields and original. A stale browser version cannot finalize unseen changes.                         |
| Provider outcome unknown                                   | Use the protected synchronization history and reconciliation workflow. Do not blindly create another bill or switch organizations.              |
| Bill created, attachment pending/failed                    | Preserve the confirmed external bill ID. Review and execute/reconcile the matching attachment operation; do not recreate the bill.              |
| Company access, token, configuration or permission revoked | Stop posting and resolve the authorization issue. A stored queue entry does not bypass current checks.                                          |

The existing sandbox path remains separate and still requires its matching nonproduction authorization. Synthetic regression tests use mocked providers and/or disposable MySQL databases; they do not demonstrate live Zoho acceptance.

Use [APPROVAL_FREE_SYNC_VALIDATION.md](APPROVAL_FREE_SYNC_VALIDATION.md) for current test commands, actual results and limitations. [LIVE_SYNC_VALIDATION_REPORT.md](LIVE_SYNC_VALIDATION_REPORT.md) is historical evidence from before the approval-free policy. This guide makes no claim that browser consent, production deployment or live supplier-bill creation has completed.
