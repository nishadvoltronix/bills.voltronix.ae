# Books accounting metadata and operational verification

These operator commands complete configuration for an existing authorized company. They do not create a provider bill, upload an attachment, record a payment, infer accounting choices or convert a demo company. No live provider acceptance is claimed from their mocked tests.

## Observed connection progress — 29 October 2026

The owner completed OAuth consent for **VOLTRONIX CONTRACTING LLC** (organization `828765858`). Its scoped encrypted grant is stored on the local server. A subsequent authenticated, read-only catalog request returned the exact active organization with AED base currency, 82 accounts (35 supported expense accounts), 11 currencies and two simple tax entries. Four provider GET requests succeeded; no bill, payment, account, mapping or tax was written. The sanitized catalog is retained under ignored `.local/books-setup/828765858-catalog.json`, without credentials or balances.

The owner subsequently completed Switchgear's separate OAuth consent. Both organizations now have current encrypted grants. A fresh authenticated catalog check succeeded for both organizations (eight provider GET requests total, zero financial writes). Organization `802911060` returned its active provider name **VOLTRONIX SWITCHGEAR LLC**, AED base currency, 64 accounts (30 supported expense accounts), 11 currencies and two tax entries. Its sanitized catalog is retained under ignored `.local/books-setup/802911060-catalog.json`. The configured display name currently includes a trailing `1`; reconcile that label with the provider's exact name before preparing and verifying its operational company.

No additional consent is indicated by these checks. Successful metadata access does not select accounting mappings or enable financial synchronization. The current connection-check workspaces remain ineligible for live posting; production runtime/database, real companies, accounting and supplier mappings, real jobs and the sync worker remain to be set up.

Subsequent supplier discovery returned 982 active AED vendors for Contracting and 69 for Switchgear. The complete sanitized ID/name/currency lists are retained in ignored `.local/books-setup/*-suppliers.json`; no suppliers were imported and no provider financial writes occurred. The final discovery used the documented `contact_type=vendor` filter and checked active status locally: combining it with `filter_by=Status.Active` returned customer records as well in this provider environment. Discovery results do not replace exact contact verification during import.

The disabled accounting review draft is `.local/books-setup/mapping-review-draft.json`. It identifies the organizations' own AED, standard VAT, Zero Rate, Materials Purchase and Other Expenses entries. Labour, equipment and transport account selections remain pending. The operator's intended production host is an existing Ubuntu server; SSH is reachable, but deployment authentication has not yet been established from this workspace. No production company/database, worker service or DNS change has been made.

## Inspect the exact organization's accounting options

After OAuth consent, supply the active Admin credentials through `ACCOUNT_OPERATOR_EMAIL` and `ACCOUNT_OPERATOR_PASSWORD` in the trusted operator process. Do not put credentials in command arguments or commit them. Select the exact `BOOKS_COMPANY_ID` and `BOOKS_ORGANIZATION_ID`, and set `ALLOW_BOOKS_CATALOG_READ=true` for this invocation:

```text
npm run books:catalog
```

The catalog supports either the guarded local connection-check workspace or a real company in the operational production runtime. In both cases all accounting-write flags must be explicitly false. It verifies current Admin membership and exact organization/company assignment before fetching metadata, then rechecks access before returning it. OAuth may refresh and retain encrypted credentials, but the command changes no company, destination, account, tax, currency or bill configuration.

Output contains organization identity, account IDs/names/types/active state, currency IDs/codes/precision and tax IDs/rates/types. It excludes balances, contact details, tokens and unknown provider fields. Pagination is bounded to ten pages of 100 rows per catalog; repeated/invalid pages and oversized results fail instead of silently returning an incomplete catalog. `supported` identifies an option this implementation understands; it is not a recommendation to select that account or tax.

Review and explicitly set each organization's own `mapping` inside `ZOHO_BOOKS_ORGANIZATIONS_JSON`. Keep the existing profile IDs and credentials; do not reuse the other company's account, tax, currency or supplier IDs. Exchange rates require explicit accounting review and are not inferred from the catalog. The mapping schema's `verified: true` is an operator statement; it does not create destination proof or enable posting.

## Verify and enable an existing operational destination

Prepare the real company and its disabled destination on the operational database first. The verifier refuses the development database, demo records and connection-check workspaces. Stop/disable posting across application and worker processes during setup; all three flags `ZOHO_BOOKS_WRITE_ENABLED`, `ZOHO_BOOKS_LIVE_ENABLED` and `ALLOW_PRODUCTION_ACCOUNTING_WRITES` must be explicitly `false` for the command. The production application origin, restricted operational database and `APP_ENV`/`NODE_ENV` production settings must already be valid.

Supply the Admin credentials and these nonsecret inputs in the trusted operator process:

| Variable | Meaning |
| --- | --- |
| `ALLOW_BOOKS_OPERATIONAL_VERIFICATION` | `true` for this explicit invocation |
| `BOOKS_COMPANY_ID` | Existing real company ID |
| `BOOKS_ORGANIZATION_ID` | Exact configured Books organization ID |
| `BOOKS_ORGANIZATION_NAME` | Exact reviewed organization name; must match both local company and provider |
| `BOOKS_VERIFICATION_REFERENCE` | Stable reference identifying the operator's accounting review |

```text
npm run books:verify-live
```

The verifier makes only Books GET requests. It checks the active organization, identity/name, base currency and amount precision; every configured currency; every active expense/cost-of-goods-sold account; and each simple tax ID/rate. It then rechecks configuration, current Admin membership, company assignment and outstanding operations inside a serializable transaction. Only after these checks does it enable that local company/destination, save the current configuration hash and verification reference, and append an audit event. No global write flags are changed. Failed metadata or concurrent local changes leave the destination authorization untouched.

This verification supports manual expense-account lines, two-decimal currencies and simple percentage taxes, with bounded currency/tax counts. Optional item IDs and custom-field indices are rejected until an implemented verification path can establish their meaning. Nonzero discounts remain blocked by the bill adapter. Supplier mappings and real job/vendor records are separate prerequisites; use the existing protected supplier-mapping workflow for the same exact destination. Outstanding queued, processing, retrying or uncertain operations must be reconciled before changing destination authorization.

After setup is verified for each company, enable the intended production write settings through normal protected configuration and supervise the sync worker. `ALLOW_PRODUCTION_ACCOUNTING_WRITES` is a legacy deny switch and stays false. Confirm a real authorized invoice's provider ID and required attachment delivery before declaring synchronization accepted. This command's successful metadata receipt is not an invoice-creation test.

## Import selected suppliers with verified mappings

After preparing the real operating company and reviewed currency configuration, `npm run books:suppliers` imports explicitly selected active Books suppliers into that company and creates their exact destination mappings. The command uses only provider GET requests; local supplier creation, mapping and audit are one transaction. It requires the operational production runtime, current Admin membership and all financial-write flags explicitly false. Existing mappings are reused without overwriting supplier identities; ambiguous existing records require explicit resolution.

Supply `ALLOW_BOOKS_SUPPLIER_SETUP=true`, `BOOKS_COMPANY_ID`, `BOOKS_ORGANIZATION_ID`, `BOOKS_SUPPLIER_IDS_JSON` (an array of 1–25 unique numeric contact IDs), `BOOKS_SUPPLIER_SETUP_REFERENCE`, and trusted operator credentials privately. Every selected contact is reread and must be an active vendor with its exact configured currency ID/code. Nothing is matched by guessed names, and this command never creates a supplier in Zoho. Do not use development connection-check workspaces as import targets.

## Provider contracts

- [Organization GET](https://www.zoho.com/books/api/v3/organizations/#get-an-organization), [currency GET/list](https://www.zoho.com/books/api/v3/currency/) and [tax GET/list](https://www.zoho.com/books/api/v3/taxes/) require `ZohoBooks.settings.READ`.
- [Chart of accounts GET/list](https://www.zoho.com/books/api/v3/chart-of-accounts/) requires `ZohoBooks.accountants.READ`. Existing tokens lacking this scope need consent again; the operator command cannot manufacture consent.
- Account GET uses the documented top-level account fields. Tax GET permits the documented array representation and selects exactly one matching tax ID; duplicate matches and compound taxes are rejected.
