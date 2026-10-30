# Job lookup and original bill history — 30 October 2026

Manual entry and dashboard search accept a job reference, job name or existing bill number. Bill-number results include the associated job when its identity is verified, including a Books invoice renamed after synchronization. Matching companies and jobs remain separate choices. Imported CRM records awaiting company review retain their review page and cannot create bills.

The job profile lists all linked workspace and Books invoices, including their original documents. Each available PDF/image has **Open** and **Download** actions beside its invoice. Missing files are identified as pending or absent; a generated invoice is not substituted for an original. History includes different currencies, but amounts in different currencies are not added into a job total.

When source coverage or job associations remain unverified, an empty canonical history now displays **Verification pending** instead of implying that the job has no bills. Existing verified bills remain visible. Source warnings and the exact company's Books cooldown are displayed separately; the stated retry is for the next Books update and does not promise automatic resolution of missing job links. Data-entry users do not receive this financial source status.

Search results are bounded and explicitly report additional matches. Selecting a job loads its complete linked history independently of that search limit. Workspace/Books copies remain in their named source sections; financial totals retain confirmed-identity deduplication.

Originals remain company- and role-protected. Downloads verify file integrity and current access. Workspace previews also recheck file identity, MIME type and authorization after disk I/O. Browser DTOs omit private storage paths, provider URLs and raw source metadata. Job history retries a concurrent Books revision once before requesting a fresh view.

## Historical source links

An imported supplier bill without a verified job association remains searchable and its original files remain available on its bill profile. It does not become part of a job's history through a similar customer, supplier or project name. Missing associations do not imply that a job has incurred no costs; complete expenses/profit remain unavailable where source coverage is unknown.

Books authorization now requests `ZohoBooks.projects.READ` to permit inspection of project references used by historical supplier bills. Existing grants require **Reconnect** on `/account/books-authorization`, separately for the intended organization. A successful consent does not establish a bill-to-job link: explicit source identifiers or documented owner mappings must still be verified. This change does not enable financial writes.

Some Books projects identify a separate Zoho Projects project. CRM authorization now requests `ZohoProjects.portals.READ` and `ZohoProjects.clients.READ` for inspecting that project's existing CRM associations. Existing shared CRM grants require **Reconnect** on `/account/crm-authorization`. The documented associated-deals response can contain multiple deals, so it must not be interpreted as full invoice allocation to a single job. These added permissions alone do not import or assign historical links.

### Verified project history

Both Books consents and the shared CRM/Projects consent have now been verified locally. The source chain is **Books bill line `project_id` → Books project `zprojects_project_id` → Projects associated CRM deals → exact CRM record ID**. Nine verified project associations now expose **15 distinct supplier bills across nine legacy CRM deals**. Their native `DealNumber` references remain separate from `JobDealNumber`: missing job numbers, company assignments and canonical IDs stay null. Same-name modern jobs do not inherit legacy invoices.

Searching the legacy reference, deal name or bill number opens `/jobs/crm/{snapshotId}` with its history companies, bills and original Open/Download controls. These profiles remain read-only. Unassigned CRM records retain the Admin requirement and membership in every active company sharing that CRM source. Company selection filters the bill history without assigning the CRM record to a company.

Project associations never change the financial ledger, native bill allocation, payments or profit. History rows report `allocationKnown: false`; private provider responses stay server-side. Complete provider pages and exact source identifiers are required. Expired proof, stale bills, source changes and concurrent relationship changes cannot silently preserve invalid links.

Run `npm run worker:job-history -- --watch` separately. It checks its queue every five seconds, refreshes due known associations after five minutes, and expires unverified proof after 24 hours. Each pass is bounded to two projects and observes leases and provider backoff. Projects quota waiting does not pause ordinary CRM imports. Existing Books/CRM incoming polling remains configured at five seconds; new bills using a verified project join its history after import. Discovering previously unseen project bridges still requires a bounded source reconciliation.

Bills without explicit CRM associations remain individually searchable. The source still provides no verified bills for `JOB-5290`; none were inferred from names or amounts. Cache import and live refresh preserved all 154 canonical jobs, 6,048 CRM snapshots, 4,674 Books bills and 4,188 originals, with zero native bills, payments or outgoing operations.

At the final runtime check on 30 October, the Contracting Books source had entered quota waiting until **20:02 UTC / 00:02 Dubai on 31 October**. Its last completed check was at 06:03 UTC. The worker continues its heartbeat and automatically retries after the recorded cooldown; CRM and Switchgear checks continue. The five-second polling setting does not override Zoho's quota. Saved history and originals remain available. The final recovery backup verified all **36 tables and 4,188 original files** through an isolated restore.

## Validation

The JOB-5363 investigation checked the exact Contracting CRM Deal, its linked native CRM Job and receivables record, imported bill/project references, and nine recent original bill images. No exact job association was found: the CRM Job's Books Project ID was null, related Projects and financial-store records were absent, and originals contained customer-level references only. No candidate was assigned to the job. A private review list retains nine candidates with authenticated local bill/original links. Current changes passed 1,409 unit tests, 275 disposable-MySQL integration tests with one skip, 54 scoped browser checks, lint, the production build and a 1,371-file release privacy scan. Actual desktop/mobile checks verified the unresolved state and preserved native financial counts.

Coverage includes bill-number-to-job lookup, company and role isolation, ambiguous identifiers, renamed Books invoices, complete history beyond the search limit, multiple currencies, attachment metadata freshness, private DTOs, document revocation during file reads, and desktop/mobile Open/Download controls. Existing CRM selection and typed **Save and sync** flows remain covered.

Actual authenticated local HTTP checks verified all nine legacy profiles and their 15 bills, reference/name/invoice searches, company selection, original Open/Download bytes, anonymous rejection, unchanged native financial counts and the running five-second incoming worker. A same-name canonical job and `JOB-5290` retained zero unproven linked bills. Final checks passed **1,353 unit tests**, **260 disposable-MySQL integration tests with one optional skip**, **49 isolated browser cases**, TypeScript, full lint and the production build. Release privacy checks passed across 1,271 build files. Browser checks include null legacy identities, exact profile links, desktop/mobile originals and the existing Save and sync flow; integration coverage includes concurrent proof revocation and unchanged financial allocation.
