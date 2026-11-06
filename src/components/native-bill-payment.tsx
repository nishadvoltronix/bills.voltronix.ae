"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import Decimal from "decimal.js";
import { ArrowLeft, LoaderCircle, Plus, RefreshCw, Wallet } from "lucide-react";
import { useManualEntryOnly, useUser } from "./app-shell";
import { savedBillState } from "@/lib/bill-save-outcome";
import { api, billTotal, date, dateTime, errorMessage, money, useApi } from "./api";
import type { Bill, Payment } from "./types";
import { AmountRow } from "./records";
import { isNativeBillPaid, NativePaidRibbon } from "./native-paid-ribbon";
import { SavedBillOutcome } from "./saved-bill-outcome";
import { Button, Card, ErrorState, Field, Input, LoadingPanel, Notice, PageHeader, Select, StatusBadge, Table } from "./ui";
import styles from "./native-bill-payment.module.css";

type PaymentAccounts = {
  companyId: string;
  accounts: { id: string; name: string; type: "bank" | "cash"; currency: string }[];
  warning: string | null;
};
const paymentModes = ["Cash", "Bank Transfer", "Credit Card", "Cheque", "Other"];
function dubaiToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function PaymentBooksStatus({ payment }: { payment: Payment }) {
  const sync = payment.booksSync;
  const label = !sync ? (!payment.paymentDate || !payment.paymentMode || !payment.paidThroughAccountId
    ? "Not sent to Zoho Books: payment details are missing." : "Not sent to Zoho Books.")
    : sync.status === "SYNCED" ? (sync.externalPaymentId ? "Payment confirmed in Zoho Books." : "Zoho Books payment confirmation is unavailable.")
      : sync.status === "QUEUED" ? "Queued for Zoho Books."
        : sync.status === "PROCESSING" ? "Synchronizing payment with Zoho Books."
          : sync.status === "UNKNOWN" ? "Zoho Books payment outcome is uncertain. Reconciliation is required."
            : sync.status === "BLOCKED" ? "Zoho Books payment needs attention."
              : "Zoho Books payment failed.";
  return <span>{label}</span>;
}

export function NativeBillPayment({ id, fromEntry = false, saved = false }: { id: string; fromEntry?: boolean; saved?: boolean }) {
  const user = useUser();
  const allowed = user.role === "ADMIN" || user.role === "ACCOUNTS";
  const state = useApi<{ bill: Bill }>(allowed ? `/api/bills/${encodeURIComponent(id)}` : null, { keepPreviousData: true });
  if (!allowed) return <ErrorState message="Only Accounts or Admin may record bill payments." />;
  if (state.loading) return <LoadingPanel />;
  if (state.error || !state.data) return <ErrorState message={state.error ?? "Bill unavailable"} retry={state.reload} />;
  if (state.data.bill.id !== id) return state.refreshing ? <LoadingPanel />
    : <ErrorState message="The returned bill does not match this payment page. Refresh the bill." retry={state.reload} />;
  return <NativeBillPaymentRecord key={id} bill={state.data.bill} refreshing={state.refreshing}
    refreshError={state.refreshError} refresh={state.reload} fromEntry={fromEntry} saved={saved} />;
}

export function NativeBillPaymentRecord({ bill, refreshing = false, refreshError, refresh, fromEntry = false, saved = false }: {
  bill: Bill; refreshing?: boolean; refreshError?: string | null; refresh?: () => void;
  fromEntry?: boolean; saved?: boolean;
}) {
  const manualEntryOnly = useManualEntryOnly();
  const [confirmed, setConfirmed] = useState<Bill | null>(null);
  const [amount, setAmount] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [paymentDate, setPaymentDate] = useState(dubaiToday);
  const [paymentMode, setPaymentMode] = useState("");
  const [paidThroughAccountId, setPaidThroughAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [unverifiedSource, setUnverifiedSource] = useState<Bill | null>(null);
  const verificationBlocked = unverifiedSource === bill;
  // The POST response is persisted server data. A slower prior GET must not
  // replace it while the refreshed bill is on its way back. An equal-version
  // GET can still refresh sync status, which has its own independent lifecycle.
  const current = confirmed && confirmed.version > bill.version ? confirmed : bill;
  const finalized = ["READY", "APPROVED"].includes(current.status);
  const entryJob = fromEntry ? { id: current.jobId, companyId: current.companyId, jobNumber: current.job?.jobNumber ?? "this job" } : null;
  const nextBillHref = entryJob ? `/bills/new?${new URLSearchParams({ jobId: entryJob.id })}` : null;
  let balance: string | null = null;
  try {
    const total = new Decimal(String(billTotal(current)));
    const paid = new Decimal(String(current.paidAmount ?? "0"));
    if (total.isFinite() && total.gt(0) && paid.isFinite() && paid.gte(0) && paid.lte(total)) balance = total.minus(paid).toFixed(2);
  } catch { /* Unavailable amounts cannot authorize a payment form. */ }
  const payable = finalized && balance !== null && new Decimal(balance).gt(0);
  const accountsState = useApi<PaymentAccounts>(payable ? `/api/companies/${encodeURIComponent(current.companyId)}/payment-accounts` : null);
  const accountsScopeMatches = accountsState.data?.companyId === current.companyId;
  const accounts = accountsScopeMatches ? accountsState.data!.accounts.filter(account => account.currency === current.currency) : [];
  const selectedAccount = accounts.find(account => account.id === paidThroughAccountId);
  const accountsReady = !accountsState.loading && !accountsState.refreshing && !accountsState.error && accountsScopeMatches;
  const pendingPaymentsKey = (current.payments ?? []).filter(payment => ["QUEUED", "PROCESSING"].includes(payment.booksSync?.status ?? ""))
    .map(payment => payment.id).sort().join(":");
  const syncPolling = useRef({ key: "", started: 0 });
  useEffect(() => {
    if (!pendingPaymentsKey || !refresh || busy || refreshing) return;
    if (syncPolling.current.key !== pendingPaymentsKey) syncPolling.current = { key: pendingPaymentsKey, started: Date.now() };
    let timer: ReturnType<typeof setTimeout> | undefined;
    function schedule() {
      if (timer) clearTimeout(timer);
      if (document.hidden || Date.now() - syncPolling.current.started >= 120_000) return;
      timer = setTimeout(() => { if (!document.hidden) refresh?.(); }, 3_000);
    }
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => { if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", schedule); };
  }, [pendingPaymentsKey, refresh, busy, refreshing, current]);
  async function record(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!payable || busy || refreshing || refreshError || verificationBlocked || !accountsReady || !selectedAccount || !paymentDate || !paymentModes.includes(paymentMode)) return;
    setBusy(true); setError(""); setSuccess("");
    try {
      const result = await api<{ bill: Bill }>(`/api/bills/${encodeURIComponent(current.id)}/actions`, {
        method: "POST", body: JSON.stringify({ action: "payment", version: current.version, amount: amount ?? balance, reference,
          paymentDate, paymentMode, paidThroughAccountId }),
      });
      if (!result?.bill || result.bill.id !== current.id || result.bill.companyId !== current.companyId || result.bill.jobId !== current.jobId || result.bill.currency !== current.currency ||
        !Number.isInteger(result.bill.version) || result.bill.version <= current.version) {
        setUnverifiedSource(bill);
        throw new Error("The payment result could not be verified. Refresh this bill before retrying.");
      }
      setConfirmed(result.bill);
      setAmount(null); setReference(""); setSuccess("Payment recorded. Check its Zoho Books status in the payment history below.");
      refresh?.();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally { setBusy(false); }
  }
  return <>
    {busy ? <span className="back-link" aria-disabled="true"><ArrowLeft size={15} />Back to bill</span>
      : <Link className="back-link" href={`/bills/${encodeURIComponent(current.id)}`}><ArrowLeft size={15} />Back to bill</Link>}
    <PageHeader eyebrow="BILL PAYMENTS" title="Record payment" description={`Invoice ${current.invoiceNumber}`}>
      <span className="small muted">Local payment</span>
      <StatusBadge status={current.paymentStatus ?? "UNPAID"} />
      {nextBillHref && (busy ? <Button disabled><Plus size={15} />Add another bill</Button>
        : <Button asChild><Link href={nextBillHref}><Plus size={15} />Add another bill</Link></Button>)}
      {refresh && <Button variant="secondary" disabled={busy || refreshing} onClick={refresh}><RefreshCw size={15} />Refresh bill</Button>}
    </PageHeader>
    {error && <Notice tone="error">{error}</Notice>}
    {success && <Notice tone="success">{success}</Notice>}
    {refreshError && <Notice tone="error">{refreshError} Refresh the bill before recording another payment.</Notice>}
    {saved && entryJob && <div role="group" aria-label="Saved bill confirmation">
      <SavedBillOutcome key={current.id} receipt={{ id: current.id, invoiceNumber: current.invoiceNumber, isDraft: !finalized,
        outcome: savedBillState(current, { id: current.id, companyId: current.companyId, jobId: current.jobId }) }}
        job={entryJob} manualEntryOnly={manualEntryOnly} continuation="payment" navigationBusy={busy}
        billRead={refresh ? { bill: current, refreshing, error: refreshError, reload: refresh } : undefined} />
    </div>}
    {entryJob && <nav className="button-row" aria-label="Bill entry navigation">
      {busy ? <>
        <Button type="button" variant="secondary" disabled>Back to job history</Button>
        <Button type="button" variant="ghost" disabled>Change job</Button>
      </> : <>
        <Button asChild variant="secondary"><Link href={`/jobs/${encodeURIComponent(entryJob.id)}`}>Back to job history</Link></Button>
        <Button asChild variant="ghost"><Link href="/bills/manual">Change job</Link></Button>
      </>}
    </nav>}
    <div className={styles.layout}>
      <div className={styles.main}>
        <Card className={styles.billCard}>
          <NativePaidRibbon bill={current} />
          <div className={styles.billHeading} style={isNativeBillPaid(current) ? { paddingLeft: 76 } : undefined}><span>Bill</span><h2>{current.invoiceNumber}</h2><StatusBadge status={current.status} /></div>
          <dl className={styles.identity}>
            <div><dt>Supplier</dt><dd>{current.vendor?.name ?? "Not available"}</dd></div>
            <div><dt>Job</dt><dd>{current.job?.jobNumber ?? "Not available"}{current.job?.name && <span>{current.job.name}</span>}</dd></div>
            <div><dt>Currency</dt><dd>{current.currency}</dd></div>
          </dl>
        </Card>
        <Card className={styles.entry}>
          <h2>Payment entry</h2>
          {payable ? <form onSubmit={record}>
            <Field label={`Payment amount (${current.currency})`} htmlFor="payment-amount"><Input id="payment-amount" type="number"
              min="0.01" max={balance!} step="0.01" required value={amount ?? balance!} disabled={busy}
              onChange={event => setAmount(event.target.value)} /></Field>
            <Field label="Payment reference" htmlFor="payment-reference"><Input id="payment-reference" required maxLength={200}
              placeholder="Transfer or receipt reference" value={reference} disabled={busy} onChange={event => setReference(event.target.value)} /></Field>
            <Field label="Payment date" htmlFor="payment-date"><Input id="payment-date" type="date" required value={paymentDate}
              disabled={busy} onChange={event => setPaymentDate(event.target.value)} /></Field>
            <Field label="Payment method" htmlFor="payment-method"><Select id="payment-method" required value={paymentMode}
              disabled={busy} onChange={event => setPaymentMode(event.target.value)}><option value="">Select the actual payment method</option>
              {paymentModes.map(mode => <option key={mode} value={mode}>{mode}</option>)}</Select></Field>
            <Field label="Paid through account" htmlFor="payment-account"><Select id="payment-account" required value={paidThroughAccountId}
              disabled={busy || !accountsReady} onChange={event => setPaidThroughAccountId(event.target.value)}>
              <option value="">{accountsState.loading ? "Loading payment accounts…" : "Select the account used for this payment"}</option>
              {accounts.map(account => <option key={account.id} value={account.id}>{account.name} ({account.currency})</option>)}
            </Select></Field>
            {accountsState.error && <Notice tone="error">{accountsState.error}</Notice>}
            {accountsState.data && !accountsScopeMatches && <Notice tone="error">Payment accounts could not be verified for this company.</Notice>}
            {accountsReady && !accounts.length && <Notice tone="info">No payment accounts are available in {current.currency}. Refresh the accounts or ask an administrator to check the Zoho Books connection.</Notice>}
            {accountsScopeMatches && accountsState.data?.warning && <Notice tone="info">{accountsState.data.warning}</Notice>}
            <Button type="button" variant="ghost" disabled={busy || accountsState.loading || accountsState.refreshing} onClick={accountsState.reload}>
              <RefreshCw size={14} />Refresh payment accounts</Button>
            <p className="field-hint">Record a payment you have already made. This queues its record for Zoho Books; it does not transfer money.</p>
            <div className={styles.actions}><Button type="submit" disabled={busy || refreshing || !!refreshError || verificationBlocked || !accountsReady || !selectedAccount}>
              {busy ? <LoaderCircle size={16} className="spin" /> : <Wallet size={16} />}Confirm payment</Button>
              {busy ? <Button type="button" variant="secondary" disabled>{nextBillHref ? "Skip payment" : "Cancel"}</Button>
                : <Button asChild variant="secondary"><Link href={nextBillHref ?? `/bills/${encodeURIComponent(current.id)}`}>{nextBillHref ? "Skip payment" : "Cancel"}</Link></Button>}</div>
          </form> : <Notice tone={current.paymentStatus === "PAID" && finalized && balance === "0.00" ? "success" : "info"}>
            {!finalized ? "Payments can only be recorded against finalized bills."
              : balance === "0.00" ? "This bill has no outstanding amount."
                : "Payment amounts are unavailable. Refresh this bill before recording a payment."}
          </Notice>}
        </Card>
        <Card className={styles.history}>
          <div className="panel-heading"><h2>Payment history</h2><span className="muted small">Local records and Zoho Books confirmation</span></div>
          {current.payments?.length ? <Table><thead><tr><th>Payment date</th><th>Reference / method</th><th>Zoho Books payment</th><th className="align-right">Amount</th></tr></thead>
            <tbody>{current.payments.map(payment => <tr key={payment.id}><td>{payment.paymentDate ? date(payment.paymentDate)
              : <div>Not supplied<div className="small muted">Recorded {dateTime(payment.createdAt)}</div></div>}</td>
              <td>{payment.reference || "—"}{payment.paymentMode && <div className="small muted">{payment.paymentMode}</div>}</td>
              <td><PaymentBooksStatus payment={payment} /></td><td className="align-right table-money">{money(payment.amount, current.currency)}</td></tr>)}</tbody></Table>
            : <p className="small-empty">No payments recorded for this bill.</p>}
        </Card>
      </div>
      <aside><Card className={`${styles.summary} ${isNativeBillPaid(current) ? styles.paidSummary : ""}`}>
        <h2>Local payment summary</h2>
        <AmountRow label="Invoice total" value={balance === null ? null : billTotal(current)} currency={current.currency} />
        <AmountRow label="Paid (including VAT)" value={balance === null ? null : current.paidAmount ?? "0"} currency={current.currency} />
        <AmountRow label="Balance due" value={balance} currency={current.currency} strong />
      </Card></aside>
    </div>
  </>;
}
