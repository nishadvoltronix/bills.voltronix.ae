# Approval-free Books synchronization

28 October 2026. This phase implements the owner's newer instruction: **no separate bill approval or per-bill live synchronization confirmation in any entry flow**. It supersedes the mandatory-approval policy described in earlier reports. Existing approval history is preserved.

## Current behavior

- **Manual entry:** `Save and sync` saves a draft, stores the selected original, then finalizes that exact version as `READY`. Optional `Save as draft` remains available. The original creator can finish their own bill; a second reviewer is not required.
- **Upload/scanner OCR:** Azure processing and human field review remain. `Save and sync` on the reviewed invoice stores its original and finalizes the bill in one database transaction. Reviewed manual fallback after an OCR failure follows the same path. An unattended OCR extraction is not treated as a verified invoice.
- **Existing unfinished bills:** an authorized writer may explicitly finish a draft, rejected or legacy pending bill. Migration does not finalize or enqueue historical bills automatically.
- **Routing:** final save chooses only the unique configured Books destination belonging to the selected company. Missing, ambiguous, disabled or unverified setup is visible as a synchronization error; the valid local bill remains saved. No organization is guessed from invoice text or from the first global profile.
- **Background execution:** new automatic jobs retain their initiating user and immutable financial/document snapshot. The general worker can run them without per-bill approval. Historical jobs without that marker retain their original recovery controls.
- **Payment:** finalization and synchronization create no payment. Recording a payment remains a separate authorized action.

READY is a truthful lifecycle status, not a fabricated approval. New READY rows have no `approvedById` or `approvedAt`. Reports, dashboard, job costs and the local Hub consumer recognize READY alongside historical APPROVED bills.

## Data integrity and access

Migration `202610280005_approval_free_sync` adds READY, a constraint prohibiting approval metadata on READY, and a nullable `IntegrationJob.initiatedById` foreign key. It preserves existing statuses and queue rows. The local schema has 27 application tables, 28 total, 272 columns, 36 enforced checks, 41 foreign keys and 55 unique indexes including primary keys.

New work checks current user/company membership and ownership, valid supplier/job/company relationships, the configured destination and current accounting mappings. Production runtime, real-company/demo restrictions, network/write switches and verified organization controls remain required. These are configuration/access checks, not an additional per-bill approval screen.

Before each outgoing financial request, the worker checks the current initiating user's access, exact canonical job/lease, source values, destination configuration, supplier mapping and original attachment bytes. Local payment records are not exported; a payment-only version increment does not alter the queued financial snapshot. Changed source data, revoked access or changed mapping blocks the job. Uncertain provider outcomes require reconciliation before any repeated create.

Manual upload uses an expected bill version. A concurrent edit cannot silently become the version that is synchronized. If the attachment response is lost after storage commits, retry reuses the existing document only when the original upload/version evidence matches; no duplicate file metadata or second upload audit is created. Failed uploads leave a draft and cannot enqueue it. An uncertain finalization response directs the user to the saved bill instead of creating another invoice.

## Windows worker

After actual connection, company and accounting configuration are verified in an operational installation, run from the project directory:

```powershell
npm run worker:sync -- --watch --limit=5
```

The worker polls bounded batches every ten seconds, backs off on worker errors and stops claiming new work on shutdown. Run it under the existing restricted application account or an appropriately configured scheduler/service. This phase did not install a Windows service or launch an unattended provider writer. A single scheduled batch is still available with `npm run worker:sync -- --limit=5`.

## Executed validation

The migration passed **9/9 real MySQL infrastructure checks** in a disposable database before application to the local development database. The runtime account retains its restricted privileges; AuditLog remains SELECT/INSERT only. No production schema was modified.

| Check                                                                    | Actual result                          | Boundary                                                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `npm test`                                                               | **495 passed**, 24 files               | Provider calls mocked                                                                                              |
| Full `npm run test:integration` with fresh native Hub fixture            | **123 passed**, 11 files, zero skipped | Disposable real MySQL 8.4.11; provider requests mocked                                                             |
| `npm run test:e2e:isolated`                                              | **17 passed**                          | Real local workflow/attachment tests plus explicitly mocked integration/OCR screens, provider credentials stripped |
| Actual `http://127.0.0.1:3000` attachment-retry/final-save browser smoke | **1 passed**                           | Synthetic invoice, READY, original retained, zero payment; live write flags verified false                         |
| `npm run build`                                                          | **Passed**                             | Current application build and TypeScript compilation, no deployment                                                |
| `npm run lint`                                                           | **Passed**, no warnings                | Full source check                                                                                                  |
| `npm run typecheck`                                                      | **Passed**                             | Next route types and TypeScript                                                                                    |
| `npm run check:release`                                                  | **Passed**, 958 build files            | No configured secrets or private runtime paths found                                                               |

The first full database run passed 121/123 and exposed a real compatibility issue: the new write guard also blocked read-only reconciliation after a mapping change. The implementation now retains exact company/destination/current-user/source checks for recovery reads while financial POSTs remain blocked. The existing regression was strengthened to use the actual Books adapter and transport with mocked GET-only responses and writes disabled; retry/POST denial is also verified. The full suite then passed without removing or weakening those checks.

The existing local development process initially retained a stale generated database client after migration. Its supported configuration watcher was notified with configuration contents unchanged, refreshing the process. The actual port-3000 browser test then passed. No database reseed or historical-bill migration was used to fix it.

Database evidence is in `.local/mysql-dev/test-runs/19536_1793187471592/receipt.json` and `integration.log`; the fresh native Hub fixture was `80ab2c3f-179b-4089-8e30-d3700b36b815`. Disposable Billing resources were cleaned up successfully. The earlier failing receipt remains under `18480_1793187158543`. Local browser smoke output is under `.local/mysql-dev/approval-free-validation-20261028/local-browser.log`. Provider calls in automated tests are mocked; they are not evidence of real Zoho acceptance.

The necessary local Hub compatibility update adds READY to its response parser and displays a neutral status label. Its targeted checks passed **7 tests** (six server, one browser), with scoped lint passing. Only the Billing response contract, its tests, billing display and bridge documentation changed in the sibling local workspace; its existing unrelated changes, environment and databases were preserved.

## Actual provider state and remaining setup

At 11:40 UTC, the authenticated local Integrations endpoint still reported both configured organizations as `CONFIGURED_UNVERIFIED`. It showed `writeEnabled=false` for both, authorization buttons ready, and CRM networking disabled. The owner's acknowledgment is not evidence that the OAuth callback completed. No live bill or payment was posted by this phase.

The current `voltronix_billing_dev` database and the two `[CONNECTION CHECK]` workspaces remain ineligible for real accounting writes. The Books write/live flags remain false. Real OAuth consent, real company-to-organization verification, supplier/accounting mappings and a suitable operational runtime are still needed before the new automatic worker can post a real invoice. Once configured, a separate bill approval or live-confirmation step is no longer required.

Scanner share access and real Azure acceptance are unchanged; see [scanner validation](SCANNER_IMPORT_VALIDATION_REPORT.md). The hosted application was not deployed or modified.
