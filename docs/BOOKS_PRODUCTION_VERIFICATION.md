# Manual entry and Zoho Books verification — 29 October 2026

**Save and sync is retained. Both existing Books connections passed live read-only checks. Production invoice posting remains blocked by the undeployed host and missing operational setup.**

The intended workflow is typed invoice entry, original attachment, finalization, then delivery by the sync worker to the correct Books organization. OCR and scanner intake are optional and disabled for this release. `MANUAL_ENTRY_ONLY=false` is explicit in the local environment and production template. The alternative `true` mode records only a local ledger and is not this release.

## Live provider evidence

At 14:51 Dubai time, the application's existing encrypted OAuth grants were used to read the exact active organizations, account/currency/tax catalogs and the first supplier-directory page:

| Books organization | Organization ID | Currency | Accounts / supported expense accounts | Currencies / taxes | Supplier page |
| --- | --- | --- | --- | --- | --- |
| VOLTRONIX CONTRACTING LLC | 828765858 | AED | 82 / 35 | 11 / 2 | 100 suppliers; more pages available |
| VOLTRONIX SWITCHGEAR LLC | 802911060 | AED | 64 / 30 | 11 / 2 | 69 suppliers; no further page |

All ten Books GET requests succeeded. One OAuth token exchange occurred; credential refresh may persist encrypted vault metadata. There were **zero provider financial writes**, no supplier imports and no accounting configuration changes. Full response bodies, tokens, balances and supplier contact details were not printed. Sanitized evidence is in `.local/readiness/books-provider-verification-20261029.json`; fresh sanitized catalogs are alongside it.

This proves current application credential/read access, not bill-creation scope or successful invoice posting. The checks use the documented [Books organization API](https://www.zoho.com/books/api/v3/organizations/); actual creation is a separate [supplier-bill operation](https://www.zoho.com/books/api/v3/bills/).

Switchgear's current configured display name differs from the provider's exact name (an earlier label includes a trailing `1`). Use **VOLTRONIX SWITCHGEAR LLC** in the production profile and operating-company setup, preserving organization ID `802911060`. Existing connection-check records were not renamed or promoted.

## Remaining production blockers

- Both `https://bills.voltronix.ae/login` and `/api/auth/me` returned **HTTP 404** on the unauthenticated host check. Hosted login, callbacks, runtime identity and worker operation have not been verified.
- This checkout uses the guarded development MySQL database and connection-check companies. It cannot post real invoices. No production environment file or authenticated server access was available here.
- Both organization profiles lack reviewed runtime accounting mappings. An earlier disabled mapping proposal exists privately; it is not verified production configuration. Each company needs its own reviewed currency, account and tax choices.
- Real operating companies, verified Books destinations, real jobs, supplier mappings and staff company access remain required on the production database. The current operational bootstrap assigns its Admin operator only; the manual-ledger helper cannot assign staff to a separately created Books company.
- Books write/live switches remain false. Enable them only after operational verification, then supervise the sync worker. No worker was started against the existing connection-check records.
- Confirm the first actual authorized invoice's Books bill ID and attachment delivery before accepting live synchronization. A local `READY` or queued `PENDING` state does not establish provider success. Nonzero discounts remain unsupported by the Books adapter.

`npm run check:sync` correctly reports `BLOCKED`. It now explicitly distinguishes an enabled local-ledger mode and invalid database TLS configuration from provider/network readiness. Its inventory remains observational and does not claim a worker or provider posting test.

## Code and release changes validated

- Restored the production release to **Save and sync**, with Books networking available for setup and the sync worker included in normal Compose deployment. `web check` uses sync readiness; `check:manual` is explicit for the optional local ledger.
- Separated OCR navigation and dashboard visibility from Books synchronization. Disabled OCR/scanner hides those controls while keeping manual entry and synchronization attention available.
- Preserved provider credentials, current company records and all accounting-write switches. Only the local `MANUAL_ENTRY_ONLY=false` mode setting was made explicit.
- Optimized production build, TypeScript and full ESLint passed. The full unit/route suite passed **1,106 tests**; the final readiness diagnostic refinement separately passed **22 focused tests**.
- Eight browser checks against the optimized server passed, including typed entry with OCR hidden, company-scoped Books readiness, attachment-before-finalization, and honest pending/failed synchronization states. Authentication was real; business/provider responses in these browser scenarios were fictional and intercepted.
- Release privacy scan passed over **1,117 build files**, finding no configured secret values or private runtime paths.

Follow [the corrected deployment runbook](MANUAL_DEPLOYMENT.md) to prepare and verify the actual host. No production deployment, provider bill creation or payment occurred during this verification.
