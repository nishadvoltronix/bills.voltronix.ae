# One explicitly authorized local Books test

This operator workflow permits one exact saved draft to pass through the existing **Save and sync** action into its real Books organization. It does not enable general posting, change a company or job's demo labels, mark a production organization as a sandbox, or record a payment.

At the 2026-10-30 verification, the JOB-5358 test had **not been posted to Books**. Contracting returned a successful metadata response with remaining quota `-8`; no live permission was issued. A local TEST supplier without an exact existing Books contact mapping cannot be used to authorize the remote test. This workflow does not schedule an automatic retry. After the provider reset, a trusted operator must verify available quota and the selected real supplier before issuing the short-lived permission and executing the exact operation.

Keep `APP_ENV=development`, the guarded local application/database, `MANUAL_ENTRY_ONLY=false`, and all normal Books write flags explicitly `false`. Apply the normal migration before using this workflow. The operator must authenticate as the draft's active Admin creator with current membership in its company. A current, unique imported CRM job must prove the exact company/Books organization assignment. An arbitrary local job or supplier name is insufficient.

The actual manual form saved `TEST-LOCAL-5358-20261030-001` as an unpaid AED 1.00 / VAT 0 draft for JOB-5358, using the local `TEST SUPPLIER - LOCAL SYNC CHECK`. Reuse that draft. No outgoing operation or live permission exists. When Books search is unavailable, same-company unmapped local suppliers can now be selected for draft entry and are labelled as needing a Books mapping; this never fabricates a provider supplier ID. Final checks passed 1,407 unit tests, 274 MySQL integration tests with one skip, 53 scoped browser checks, lint, the production build and release privacy scanning.

1. Obtain the user's exact job, existing supplier, invoice reference, currency, account, tax treatment and total. Read and configure the reviewed Books accounting mapping for that organization while write flags remain disabled. Do not invent a supplier mapping or substitute another organization because of quota.
2. If the selected existing supplier has no local mapping, run `npm run books:local-test -- supplier` with `ALLOW_LOCAL_BOOKS_TEST_SETUP=true` and `BOOKS_LOCAL_TEST_INPUT_JSON` containing `companyId`, `organizationId`, `jobId`, `externalVendorId`, and an operator `reference`. Supply existing `ACCOUNT_OPERATOR_EMAIL` and `ACCOUNT_OPERATOR_PASSWORD` through the trusted environment. This performs at most two provider GETs and creates/reuses only local supplier metadata. It never creates a provider contact.
3. Use the actual local form to save the completed bill as a draft and add any intended originals. Keep its exact saved version and values unchanged.
4. Run `npm run books:local-test -- authorize` with the same fields plus `billId`, `invoiceNumber`, `currency`, and decimal-text `total`. The command reads the exact Books organization/account/tax/currency/contact and exact CRM organization/deal. It creates a ten-minute permission bound to the full saved financial snapshot, original-file hashes, final-save version, actor, source, runtime and configuration. No bill is posted by this command. An existing canonical operation can never be replaced by a new permission.
5. Open that saved draft and choose **Save and sync**. The normal final-save transaction binds the permission to exactly one canonical outbox operation. Run only `npm run worker:sync -- --job-id=EXACT_OPERATION_ID` for that operation. The generic worker cannot claim it. Any attachment operation requires its own exact execution and must match a document in the same original snapshot.

Changing the bill, supplier, source assignment, actor access, accounting mapping, runtime, or permission invalidates the write. Expired permissions cannot post. An uncertain already-attempted outcome uses the existing read-only reconciliation route and stable bill reference; do not create another bill to retry it. A confirmed permission cannot be renewed or repurposed to authorize a second operation.

Setup requires successful Books responses to confirm at least sixteen remaining requests, and observes signed quota headers: zero and negative values block setup. It never clears the incoming worker's cooldown. A successful low-quota reserve differs from a provider-reported rate-limit failure; a known provider failure cooldown must expire before this workflow proceeds. Do not probe an exhausted organization repeatedly. Private operator input and raw provider responses must not be placed in application logs or committed files.

The input shapes are intentionally exact; the following TypeScript describes the trusted JSON input, not an HTTP endpoint:

```ts
type SupplierInput = {
  companyId: string;
  organizationId: string;
  jobId: string;
  externalVendorId: string; // verified existing supplier ID in that organization
  reference: string;       // operator record of the user's exact authorization
};
type AuthorizationInput = SupplierInput & {
  billId: string;          // existing saved DRAFT, created by this Admin
  invoiceNumber: string;  // must equal the saved draft
  currency: string;       // must equal the draft and verified supplier/job currency
  total: string;          // positive decimal text, e.g. "1.00", exactly the draft total
};
```
