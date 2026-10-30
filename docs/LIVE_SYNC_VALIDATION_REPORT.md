# Live Books implementation and local connection validation

**Historical policy:** the owner's later instruction removed separate bill approval and per-bill live confirmation. See [current approval-free synchronization and validation](APPROVAL_FREE_SYNC_VALIDATION.md). The tests and connection observations below record the earlier implementation, not the current required workflow.

28 October 2026, `G:\bills.voltronix.ae`. The owner redirected this phase from the existing hosted domain to **local testing**. Guarded live synchronization is implemented, but **no live bill has been created, no production deployment/database has been changed, and local financial writes remain disabled**. OAuth consent and real organization/mapping acceptance are still pending as of the checks below.

## What changed

- Added a production synchronization branch that requires an operational HTTPS runtime, a restricted MySQL runtime configuration, a non-demo company, an explicitly verified company/Books destination, current finance access, supplier/accounting mappings and an independently approved bill.
- Added a server-generated preview and explicit confirmation UI. A ten-minute authorization binds the actor, company, organization, bill version, payload, configuration and original attachment hashes. Only its hash is stored; the browser keeps the challenge in component memory.
- Recheck current permission, source integrity and the claimed worker lease before financial POSTs, including after token refresh and organization checks. Unknown provider outcomes retain the existing reconciliation behavior.
- Production approval never automatically queues a bill. Production workers require an exact operation ID; the general batch worker also leaves unrelated production leases alone. Approval, external synchronization and payment recording remain separate.
- Added migration `202610280004_live_sync_permission`: company/destination live eligibility and the durable `LiveSyncAuthorization` record. Defaults keep all existing companies and destinations live-disabled.
- Added separate Books/CRM network controls and a guarded, reauthenticated local connection-preparation helper. Its isolated demo workspaces cannot be used as operating company assignments or to post bills.
- Suppressed only OAuth callback request URLs in Next's development access logging, because their query strings contain one-use codes/state. Other request logs remain enabled. Future hosting/proxy logs need equivalent protection.

See [setup and operation details](LIVE_SYNC_SETUP.md). The implemented operational branch is not evidence of actual provider acceptance.

## Executed checks

| Command/check                                            | Actual result                             | Boundary                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                               | **488 passed**, 24 files                  | Provider requests mocked; includes live runtime, permission, lease, outgoing-payload and expiry checks                                          |
| `npm run test:integration` with fresh native Hub fixture | **114 passed**, 11 files, zero skipped    | Disposable real MySQL 8.4.11; mocked Zoho/Azure                                                                                                 |
| `npm run test:e2e:isolated`                              | **16 passed**                             | Isolated port 3012 with provider credentials removed; actual local MySQL manual workflow plus explicitly mocked integration/OCR UI cases        |
| `npm run build`                                          | **Passed**                                | Application production build; not a deployment                                                                                                  |
| `npm run lint`                                           | **Passed**, no warnings                   | Source lint                                                                                                                                     |
| `npm run typecheck`                                      | **Passed**                                | Next route types and TypeScript                                                                                                                 |
| `npm run check:release`                                  | **Passed**, 958 final build files         | No configured secrets/private runtime paths found                                                                                               |
| Local migration and privilege inspection                 | **Passed**                                | Development schema only: 27 application tables, 28 total, 271 columns, 35 enforced checks, 40 foreign keys, 55 unique indexes including primary |
| Authenticated HTTP readiness on port 3000                | **Passed**                                | Both Books cards can authorize; both write gates false; CRM network false                                                                       |
| Separate visible local browser                           | **Passed**                                | Both authorization buttons enabled; existing browser profile/cookies not accessed; agent did not submit provider consent                        |
| OAuth callback log suppression                           | **8/8 checks passed**, scoped lint passed | Next's actual logging helper tested with fictional callback/query/trailing-slash and unrelated URL examples                                     |
| Live Zoho OAuth consent                                  | **Pending**                               | Requires account-owner browser interaction and matching registered local redirect                                                               |
| Live Books bill/attachment creation                      | **Not run**                               | No provider financial writes authorized from the demo installation                                                                              |
| Live Azure extraction / office scanner acceptance        | **Not run in this phase**                 | Previous scanner/Azure blockers are not resolved by Books setup                                                                                 |

The first full database run passed 113/114: an existing adapter-factory assertion expected two arguments after the new lease-bound job argument was added. The assertion was updated to require the exact destination, job, bill, processing state and lease. The full suite then passed 114/114 on a fresh disposable schema. No failing assertion was disabled.

The six new live MySQL cases cover approval separation, actor-bound one-use confirmation, exact-operation processing, changed/expired previews, revoked actors, demo provenance, disabled destinations, source changes, unrelated leases and outgoing-body substitution. Three local-setup MySQL cases cover metadata-only/idempotent setup, full rollback on conflicting organization assignment and non-admin/unsafe-environment denial. Fictional operational configuration is injected into these tests only; it is never used as a real database connection.

Private database evidence: `.local/mysql-dev/test-runs/21424_1793185903414/receipt.json` and `integration.log`; native Hub fixture `7ef30a85-4578-4462-9f37-6a528447f49e`. The disposable Billing database/users were cleaned up successfully. The earlier failed run is preserved under `21340_1793185650041`.

The local MySQL process was found stopped before these checks. The retained binary was restarted against the existing data directory, and version/instance UUID were verified unchanged before proceeding. No new initialization or production server operation was performed. The cause of the process exit was not established.

## Actual local state

The application remains at `http://127.0.0.1:3000` with `APP_ENV=development`, using `voltronix_billing_dev` on loopback port 3308. Its existing development process successfully picked up the environment changes; an application restart was unnecessary.

| Configured Books organization | ID        | Local connection workspace                      |
| ----------------------------- | --------- | ----------------------------------------------- |
| VOLTRONIX CONTRACTING LLC     | 828765858 | `[CONNECTION CHECK] VOLTRONIX CONTRACTING LLC`  |
| VOLTRONIX SWITCHGEAR LLC 1    | 802911060 | `[CONNECTION CHECK] VOLTRONIX SWITCHGEAR LLC 1` |

These are configured profile labels, **not independently verified real-company assignments**. Both connection workspaces have `isDemo=true`, `liveAccountingEnabled=false`, and destinations with `liveEnabled=false` and no verification. Original fictional Company A/B and their assignments were preserved. No real invoice was assigned to any company.

At 11:13 UTC, the reauthenticated metadata setup left all accounting counts unchanged: **19 synthetic bills, 10 payment records, 13 documents and zero integration jobs**, before and after. It made zero provider requests. Preparation and safe HTTP/browser receipts are in owner-protected `.local/mysql-dev/live-connection-20261028/`; the private environment backup is excluded from source/releases.

Only these local environment settings changed:

```dotenv
INTEGRATION_NETWORK_ENABLED="true"
ZOHO_BOOKS_NETWORK_ENABLED="true"
ZOHO_CRM_NETWORK_ENABLED="false"
ZOHO_BOOKS_WRITE_ENABLED="false"
ZOHO_BOOKS_LIVE_ENABLED="false"
ALLOW_PRODUCTION_ACCOUNTING_WRITES="false"
INTEGRATION_TEST_MODE="false"
```

All unrelated settings, credentials, database location, Azure and scanner configuration were preserved. At 11:14 UTC, authenticated `/api/integrations` returned both organizations as `CONFIGURED_UNVERIFIED`, with `authorization.canAuthorize=true`, no missing authorization settings, and `writeEnabled=false`. This checks the local application's configuration, not whether Zoho has registered the callback or accepts the client.

The owner must complete consent separately for each intended organization. The exact local callback is `http://127.0.0.1:3000/api/integrations/oauth/zoho/callback`. Consent requests the existing Books create/read scopes; application financial-write controls remain disabled even if consent succeeds. Do not paste callback codes, passwords or OTPs into chat.

## Remaining work before a real bill can synchronize

1. Complete actual provider consent and verify the intended organization's identity, data center and accounting configuration through authorized read-only checks.
2. Establish an operational database/runtime and verified real-company/vendor/job/destination mappings. Do not convert connection-check workspaces or rename the fixture database to bypass the runtime guard. A reviewed operator provisioning procedure is still needed; the local helper intentionally cannot enable live accounting.
3. Review one real invoice in the correct company, obtain independent approval, preview its exact destination/amount/attachments and explicitly confirm the individual live operation.
4. Execute and verify that exact operation and required attachment operations; record actual provider IDs and reconcile uncertain outcomes. No real acceptance result exists yet.

The hosted site was previously observed serving a Coming Soon page, with login/callback routes returning 404. This phase does not resolve that deployment. Scanner access, mandatory live Azure validation and mixed-company scanner assignment remain governed by [the scanner report](SCANNER_IMPORT_VALIDATION_REPORT.md).
