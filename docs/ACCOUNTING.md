# Financial policy for the MVP

## Cost recognition and amounts

This application estimates job performance on a VAT-exclusive basis. It assumes job contract values/approved variations are entered on that same basis. Recoverable versus nonrecoverable VAT is not modeled: do not use these estimates as final accounting profit or statutory tax totals.

Each line is quantity × unit price, rounded half-up to two decimals. Sum rounded lines to obtain subtotal, subtract a currency amount discount, then compute VAT on the discounted subtotal and round VAT half-up to two decimals. Total = discounted subtotal + VAT. Quantities support three decimals. Negative/zero final totals, invalid dates, excessive precision, negative amounts, discounts beyond subtotal, and VAT beyond 0–100% are rejected. Zero-price lines are allowed within an otherwise positive invoice.

`DRAFT → READY` is the normal workflow. **Save and sync** finalizes the bill after its original is stored, then queues its exact company destination when operational settings allow. There is no second-user approval. Admin/Accounts and owning Data Entry users can finalize bills; legacy pending/rejected bills can also be finalized through the current writer workflow. Historical `APPROVED` records and their approval evidence remain unchanged. Finalized financial values and documents cannot be edited. Accounts/Admin may cancel an unpaid active bill with a reason; paid bills require a future separately reviewed reversal workflow and cannot be cancelled here.

`READY` and historical `APPROVED` invoices contribute net recognized expense. Payment status is derived independently: zero payments = UNPAID; positive payments below total = PARTIALLY_PAID; payments equal total = PAID. Saving or synchronizing a bill never records payment. Payment references are normalized and unique per bill. Repeated payment submissions, stale versions, and overpayments are rejected atomically.

Example: a bill with net cost AED 1,000, VAT AED 50, and gross total AED 1,050 recognizes AED 1,000 once finalized. A payment of AED 300 leaves AED 750 outstanding and does not change recognized costs. Cancelling an unpaid finalized bill removes its AED 1,000 from recognized costs. Draft/rejected/legacy-pending/cancelled bills have zero recognized payable in job/dashboard summaries.

## Job performance

- Adjusted job value = contract value + approved variations.
- Recognized expenses = sum of READY and historical APPROVED bill net amounts linked to the job.
- Remaining contract value / provisional estimated profit = adjusted job value - recognized expenses.
- Expense percentage = recognized expenses / adjusted job value × 100.
- At 90% through 100%: NEAR_LIMIT. Above 100%: OVER_BUDGET / estimated loss. Below 90%: WITHIN_BUDGET.

The UI's budget comparison uses adjusted contract revenue as its reference. There is no separately entered cost budget, revenue-recognition schedule, payroll ledger, or overhead allocation. This is a provisional estimate before unrecorded/other costs. A missing, zero, or invalid adjusted value yields VALUE_UNAVAILABLE and no profit percentage. Aggregate profit is unavailable if any selected job lacks a valid value; the sum of known job values remains distinguishable from a complete valuation.

Job and management summaries use lifetime costs in one currency. Date/vendor/category/status filters apply to the separately labelled expense report and bill listings. They never subtract a subset of costs from a full contract to present filtered profit. Dashboard currency/job filtering applies to both values and costs. The report's invoice face-value total includes selected statuses; its recognized cost/paid/outstanding totals include only READY and historical APPROVED bills. CSV rows reconcile to those definitions. Data Entry summaries include only that user's own bills and hide contract values/profit; they are not organization-wide profitability.

## Identities and limitations

There is one canonical internal bill ID. Local job IDs and user-facing job numbers have a unique relationship; reserved external CRM IDs will be populated only by an approved integration. All current demo jobs are fictional, not imported production CRM records.

OCR review links its original and either creates a draft or finalizes READY in one transaction, according to the user's save choice. Extraction evidence remains distinct from the human-verified input. Repeated posting of the same document returns the same bill. Source-total differences require explicit correction and verification; mixed tax and tax-inclusive lines must be normalized to the supported VAT-exclusive form by the entry user. Failed-OCR manual recovery remains audited and does not claim successful extraction.

External synchronization uses the finalized bill snapshot and canonical ID. Bill finalization, payment, OCR review and external synchronization have separate states. No separate approval or preview confirmation is required. A local cancellation is blocked while an external create is pending, uncertain or confirmed; reconcile it and use a future authorized reversal workflow. A confirmed remote bill or attachment must have provider evidence before it is reported successful.

Vendor + Unicode-normalized, trimmed, whitespace-collapsed, uppercase invoice number is unique even after cancellation. Invoice punctuation is preserved. A legitimate reused invoice number needs a future authorized duplicate-resolution process; staff cannot silently bypass the rule. Identical attachment retries reuse the same document under current access/state/version checks; they do not create another attachment or audit event. Sync records and their external IDs never create another local expense row.

Credit notes, refunds, reversals, prepayments, withholding tax, multi-job split allocation, and exchange rates are not implemented. Do not enter them as negative invoices or fictitious payments. A future credit must reference the original invoice, preserve history, and offset cost/payable under an explicit approved policy.

Database CHECK constraints guard financial signs, totals/VAT consistency, payment bounds, valid states, finalization evidence and historical approval evidence. Service transactions additionally enforce line-sum equality, payment-ledger consistency, job/vendor currency agreement, authorization, and audit creation. These cross-record rules can be bypassed by privileged direct SQL, so restrict database write access to the application and trusted migration operators. Current validation and remaining live-provider limitations are recorded in [APPROVAL_FREE_SYNC_VALIDATION.md](APPROVAL_FREE_SYNC_VALIDATION.md).
