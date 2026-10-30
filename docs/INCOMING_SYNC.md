# Automatic incoming Zoho updates

The incoming worker keeps the app's imported Zoho Books bills and CRM jobs current. It runs separately from the web server and the outgoing **Save and sync** worker. Its scheduled provider work reads Zoho and updates local imported records; it does not create or update provider accounting records. Manual bill entry and outgoing synchronization retain their existing workflow.

The current default check interval is **60 seconds**, selected by the user on **30 October 2026** to preserve daily provider quota, with a full reconciliation every 24 hours. The dashboard still reads saved app status every **five seconds**. The source interval is the scheduling delay between completed checks, not a guarantee that changes appear within one minute. Provider response time, quota, incomplete pages, unavailable credentials, connectivity, or a stopped worker can delay a successful check. Existing leases and provider backoff still apply, and imported records remain available during delays.

Even an unchanged Books check uses two provider reads: organization verification and the bill list. At 60 seconds the nominal idle budget is at most 2,880 reads per organization per day, plus changed bill details, originals and reconciliation. This is not a guaranteed daily ceiling: resumable batches and other API consumers use additional quota. The earlier five-second setting and its observations below are historical. Changing the protected setting requires restarting the incoming worker; an already-due check can complete once before the longer interval applies. Existing source cooldowns are preserved.

## Verified current completion — 30 October 2026

**Historical morning snapshot:** the results in this section describe the earlier checks and five-second setting, not the current source cadence or quota state. Consult the dashboard and [production readiness](PRODUCTION_READINESS.md) for the latest evidence.

At **04:43:13 UTC / 08:43:13 Dubai**, all three sources had current successful checks, no quota/error state, and a healthy continuous incoming worker. The local mirror contained **4,674 Books bills, 6,048 CRM inventory rows and 154 canonical jobs**. Three additional Books bills arrived overnight. All **4,188 current originals were downloaded**, with zero pending, invalid-metadata or invalid-byte records. The earlier Contracting quota hold and attachment backlog are cleared; future source additions remain subject to normal scheduled checks and provider limits.

The completed backup at `.local/mysql-dev/backups/after-current-originals-complete-20261030T044152Z-7b4fa5/` passed an isolated **35-table restore**, with matching data/DDL/column hashes, and byte-length/SHA-256 verification for all **4,188 originals**. Restore cleanup succeeded. The completion monitor exited successfully while the incoming watch process continued running.

Actual authenticated local checks verified each company's sample original through both Open and Download, including bytes, MIME, disposition and no-store behavior; anonymous requests returned 401. Newest-bill search passed. Independent raw-source sums for 4,672 financial bills matched all five dashboard totals. Desktop/mobile pages had no horizontal overflow or runtime errors. Native `Bill`, `Payment` and `IntegrationJob` counts remained zero, with no provider financial writes.

The 30 October five-second cadence update passed the **50-page production build, full ESLint, 42 focused unit/route/deployment checks, 239 disposable-MySQL integration checks with one existing skip, and all three focused incoming-status browser checks**. Scheduling regressions verify that shorter intervals preserve quota/retry waits, checkpoints and active leases. The isolated browser checks verified five-second visible-tab polling, no hidden-tab polling, refreshing financial data only after a later successful source check, retained status on a temporary fetch failure, company-scope denial/recovery, and readable second-level timestamps without mobile overflow. They used mocked business responses and did not contact providers or submit financial writes.

At **04:54:57 UTC / 08:54:57 Dubai**, the local worker had been restarted with the protected interval set to `5`. The authenticated status endpoint reported five seconds, and live observation verified three successive successful-check timestamps for each of the three sources. Every completed source schedule set its next due time exactly five seconds after its successful check, with no source errors or provider financial writes. Provider work and serial source processing can extend elapsed time between completed checks. The existing 4,674 Books bills and 4,188 originals remained present; native financial tables and outgoing jobs remained empty.

The **258 CRM review records** and historical Books-to-job allocations still require exact source/owner evidence. Hosted production setup, permanent supervision, reboot recovery and outgoing posting acceptance remain manual and unverified. The dated 29 October quota/backlog records below are historical; they are not current unresolved downloads.

## Configuration and deployment

Use the same protected operational environment and MySQL database as the web application. Configure `INCOMING_SYNC_ENABLED=true`, `MANUAL_ENTRY_ONLY=false`, and the required provider read/network gates for the sources to be checked (`ZOHO_BOOKS_NETWORK_ENABLED` and `ZOHO_CRM_NETWORK_ENABLED`). Each source must have its verified company routing and valid read authorization. Enabling incoming synchronization does not grant outgoing financial-write permission; those gates remain separate.

Configure a current, active Admin operator in the worker's protected environment using `INCOMING_SYNC_OPERATOR_EMAIL` and `INCOMING_SYNC_OPERATOR_PASSWORD`. The worker can fall back to `ACCOUNT_OPERATOR_EMAIL` / `ACCOUNT_OPERATOR_PASSWORD`; development can additionally use the existing local seed account. **Production must not use seed credentials.** Keep passwords out of commands, source control, logs, and browser responses. The operator needs active company memberships for the sources it processes; a shared CRM source requires access to every active company sharing that source. A revoked operator or changed operator password stops the worker. Update the protected credentials and restart it after an authorized account change.

| Setting | Default | Supported values / purpose |
| --- | --- | --- |
| `INCOMING_SYNC_ENABLED` | `false` | `true` enables the incoming worker. |
| `INCOMING_SYNC_INTERVAL_SECONDS` | `60` | 5–86,400 seconds between completed checks; provider backoff takes precedence. Five-second checks require an explicit override and sufficient daily quota. |
| `INCOMING_SYNC_RECONCILE_SECONDS` | `86400` | 3,600–604,800 seconds between full reconciliations. |
| `INCOMING_SYNC_MAX_REQUESTS` | `40` | 5–200 reads per source batch; unfinished work resumes from its checkpoint. |
| `INCOMING_SYNC_ATTACHMENTS_ENABLED` | `false` | Enables remaining original-file work after bill metadata completes. |
| `INCOMING_SYNC_ATTACHMENT_STATE_FILE` | unset | Absolute private path to the existing attachment downloader's progress JSON, so its recorded source cooldowns also pause incoming reads. |
| `INCOMING_SYNC_NOT_BEFORE_JSON` | unset | Protected JSON mapping of exact source keys (`ZOHO:<organization-id>` or `CRM:<organization-id>`) to known earliest-retry ISO timestamps. |

Apply the release migrations and regenerate the Prisma client before starting the updated application and worker. Use the repository's [deployment runbook](MANUAL_DEPLOYMENT.md) for the separate migration identity, private environment, verified MySQL TLS, persistent storage, and recovery checks. Do not copy the local development database or seed credentials into production.

Run one check with:

```powershell
npm run worker:incoming
```

Run continuously with:

```powershell
npm run worker:incoming -- --watch
```

In production, run the incoming worker under the deployment supervisor alongside the web and outgoing sync services. A running web server alone does not perform incoming checks. Keep the host awake and the worker process running; configure restart after failure or reboot. Preserve the same database across worker restarts so durable progress, successful checkpoints, retry schedules, and source locks are retained. Never clear a pending schedule to bypass a provider quota.

The deployment Compose file includes an `incoming` service that starts the worker in watch mode with the same private runtime environment. After preparing the release and applying migrations, start or update it using the same Compose overrides and image selection as the web service:

```powershell
docker compose -f deploy/compose.yaml up -d incoming
docker compose -f deploy/compose.yaml logs --tail=100 incoming
```

Include the deployment's MySQL CA override where applicable. The production environment template explicitly enables incoming synchronization and its attachment continuation; set the attachment flag to `false` during an existing attachment-worker handoff as described below. A started container is not evidence of a completed source check: verify its heartbeat and per-source status in the app.

## Reading the dashboard status

The dashboard's **Incoming Zoho updates** panel is available to authorized Admin, Accounts, and Management readers. The company filter also scopes incoming status. Shared CRM sources show only company labels the reader may access. Data Entry accounts do not receive this operational source inventory.

Expand **Source schedules** to see each source's current state, last successful automatic check, earliest next check, and whether its imported data is stale. A successful historical manual import is separate from a successful automatic check. An unstarted or failed automatic check is never presented as successful simply because earlier data is present.

| Display | Meaning |
| --- | --- |
| Check pending | A scheduled source check is waiting to run. |
| Checking Zoho | The incoming source check is in progress. |
| Scheduled | The source is waiting for its next check; inspect the last-success time for freshness. |
| Retry scheduled | A recoverable failure has delayed the next attempt. |
| Waiting for Zoho quota | Requests are paused until the recorded provider backoff permits another attempt. |
| Needs attention | The source cannot proceed until the reported issue is resolved. |
| Automatic checks off | Incoming checks are disabled for this source. |
| Worker not reporting | A recent worker heartbeat is unavailable; running automatic checks are unconfirmed. |
| Stale | The source does not meet the service's freshness criteria. |

Times are displayed in Dubai time. The earliest next check is a lower bound: a later rate limit or an unavailable worker can defer it again. A backoff expiration is not evidence that an import completed.

The browser reads only saved status through the authenticated `GET /api/integrations/incoming-status` endpoint. It refreshes every **five seconds** while the page is visible and once when the page becomes visible again; timestamps include seconds. Refreshing status never starts a provider request or an import. If a source's successful-check timestamp advances, the open dashboard reloads its local financial summary. A status refresh failure preserves the previous display with an explicit warning that current progress is unconfirmed.

## Original files and quota coordination

Original attachment downloads have their own progress and availability. The first incoming-status view covers **Books bills and CRM jobs**, not attachment-worker completion. A successful Books check does not mean pending originals are downloaded. Continue to use the original-file coverage on each imported bill and the private downloader receipt described in [Books history and originals](BOOKS_DATA_IMPORT.md).

The historical Contracting quota delay on 29 October 2026 had an earliest retry of **20:02:01 UTC / 30 October 00:02:01 Dubai**; the current completion check confirms that hold is cleared. An earliest retry is never proof of success. For future observed delays, preserve the exact source cooldown in protected configuration and retain the downloader's private progress file through `INCOMING_SYNC_ATTACHMENT_STATE_FILE`. Incoming reads consult that file before requests and honor later source delays. In a container, mount the progress file privately at the configured path; a Windows host path is not a container path.

Keep `INCOMING_SYNC_ATTACHMENTS_ENABLED=false` while the existing attachment worker owns the original-file backlog. Enable the incoming worker's attachment continuation after a coordinated handoff, preserving available originals and pending progress. Bill metadata is committed before optional original downloads; an attachment quota pause does not undo the completed metadata refresh. The dashboard does not expose attachment completion through the Books status timestamp. Do not launch competing manual refreshes to test an exhausted quota.

## Monitoring and recovery

Monitor worker heartbeat age, last successful check per authorized source, blocked sources, retry/backoff schedules, and stale imported data. Check saved status before investigating provider connectivity; dashboard reads do not need a live provider connection. Keep source diagnostics sanitized: never expose access tokens, refresh tokens, provider response bodies, private file paths, or durable checkpoint internals to browser clients.

Back up the database and private original-file storage as a coordinated recovery set. Restore into a separate verification environment first, preserving incoming checkpoints and source identity along with imported records. Verify company access, prior successful-check timestamps, pending retries, and authenticated original-file Open/Download before accepting recovery. A restored worker must resume its persisted schedule instead of treating incomplete work as successful.

## Verified local run — 29 October 2026

The first live incoming check completed with the following saved outcomes. These are provider read results in the local application; no provider financial writes occurred.

| Source | Counted provider GET reads | Verified outcome |
| --- | ---: | --- |
| Switchgear Books (`802911060`) | 2 | Source check completed. |
| CRM (`802911927`) | 33 | Check completed; 6,048 source rows processed. |
| Contracting Books (`828765858`) | 0 | `WAITING_QUOTA`, with no reads before `2026-10-29T20:02:01Z` (30 October 00:02:01 Dubai). |

At this acceptance checkpoint, the existing **154 canonical jobs, 4,671 imported Books bills, 6,048 CRM inventory rows and 322 available originals** were unchanged. The CRM inventory includes opportunities without job references; it does not represent 6,048 billing jobs. Native `Bill`, `Payment` and `IntegrationJob` counts remained zero. The read check created no native financial ledger entries or outgoing bill operations.

Live follow-up identified that CRM ignored the millisecond/Z conditional timestamp. The worker now sends the whole-second numeric-offset format shown in [Zoho's Get Records API](https://www.zoho.com/crm/developer/docs/api/v8/get-records.html). At **14:13 UTC / 18:13 Dubai**, the next scheduled CRM cycle completed using **3 GET reads and zero changed rows**, instead of re-reading all 6,048 records. The final regression suite again passed all 229 integration checks with one existing skip.

An authenticated check against the actual local dashboard also passed: incoming checks active, two sources with successful timestamps, Contracting quota waiting, unchanged source financial totals, and no desktop/mobile horizontal overflow or browser runtime errors. This check read saved application data and did not submit a financial write.

The prior attachment downloader and its completion monitor were stopped, their exited processes and stale state lock were checked, and the original progress was retained in protected handoff receipts. The handoff preserved **322 available originals and 3,863 pending originals**. A hidden local `incoming --watch` process was then confirmed running with attachment continuation enabled, a 300-second source-check interval, and both the known-quota JSON and retained attachment progress file configured. Its error log was empty at verification. Future quota responses may extend the earliest retry, and pending originals remain pending until their bytes have been downloaded and verified.

Release checks passed **1,270 unit tests, 229 disposable-MySQL integration tests with one existing skip, all 23 isolated browser checks, and the 50-page production build**. Browser coverage includes visible-tab status polling, refreshing dashboard totals after a later successful check, retained status with an explicit refresh-failure warning, company-scope denial and recovery, manual entry/Save and sync, and authenticated Books original-file behavior. Business endpoints in these browser checks used fictional responses; they did not post provider bills.

The continuous worker is running locally and requires this PC, MySQL and internet access to remain available. Hosted production deployment, permanent service supervision, reboot recovery and actual hosted acceptance remain manual and unverified. The local start does not enable outgoing financial-write gates or establish provider posting acceptance.
