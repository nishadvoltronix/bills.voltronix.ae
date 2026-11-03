"use client";

import Link from "next/link";
import { useState } from "react";
import Decimal from "decimal.js";
import { ArrowLeft, LoaderCircle, RefreshCw, Wallet } from "lucide-react";
import { useUser } from "./app-shell";
import { api, billTotal, dateTime, errorMessage, money, useApi } from "./api";
import type { Bill } from "./types";
import { AmountRow } from "./records";
import { isNativeBillPaid, NativePaidRibbon } from "./native-paid-ribbon";
import { Button, Card, ErrorState, Field, Input, LoadingPanel, Notice, PageHeader, StatusBadge, Table } from "./ui";
import styles from "./native-bill-payment.module.css";

export function NativeBillPayment({ id }: { id: string }) {
  const user = useUser();
  const allowed = user.role === "ADMIN" || user.role === "ACCOUNTS";
  const state = useApi<{ bill: Bill }>(allowed ? `/api/bills/${encodeURIComponent(id)}` : null, { keepPreviousData: true });
  if (!allowed) return <ErrorState message="Only Accounts or Admin may record bill payments." />;
  if (state.loading) return <LoadingPanel />;
  if (state.error || !state.data) return <ErrorState message={state.error ?? "Bill unavailable"} retry={state.reload} />;
  if (state.data.bill.id !== id) return state.refreshing ? <LoadingPanel />
    : <ErrorState message="The returned bill does not match this payment page. Refresh the bill." retry={state.reload} />;
  return <NativeBillPaymentRecord key={id} bill={state.data.bill} refreshing={state.refreshing}
    refreshError={state.refreshError} refresh={state.reload} />;
}

export function NativeBillPaymentRecord({ bill, refreshing = false, refreshError, refresh }: {
  bill: Bill; refreshing?: boolean; refreshError?: string | null; refresh?: () => void;
}) {
  const [confirmed, setConfirmed] = useState<Bill | null>(null);
  const [amount, setAmount] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [unverifiedSource, setUnverifiedSource] = useState<Bill | null>(null);
  const verificationBlocked = unverifiedSource === bill;
  // The POST response is persisted server data. A slower prior GET must not
  // replace it while the refreshed bill is on its way back.
  const current = confirmed && confirmed.version >= bill.version ? confirmed : bill;
  const finalized = ["READY", "APPROVED"].includes(current.status);
  let balance: string | null = null;
  try {
    const total = new Decimal(String(billTotal(current)));
    const paid = new Decimal(String(current.paidAmount ?? "0"));
    if (total.isFinite() && total.gt(0) && paid.isFinite() && paid.gte(0) && paid.lte(total)) balance = total.minus(paid).toFixed(2);
  } catch { /* Unavailable amounts cannot authorize a payment form. */ }
  const payable = finalized && balance !== null && new Decimal(balance).gt(0);
  async function record(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!payable || busy || refreshing || refreshError || verificationBlocked) return;
    setBusy(true); setError(""); setSuccess("");
    try {
      const result = await api<{ bill: Bill }>(`/api/bills/${encodeURIComponent(current.id)}/actions`, {
        method: "POST", body: JSON.stringify({ action: "payment", version: current.version, amount: amount ?? balance, reference }),
      });
      if (!result?.bill || result.bill.id !== current.id || result.bill.companyId !== current.companyId || result.bill.currency !== current.currency ||
        !Number.isInteger(result.bill.version) || result.bill.version <= current.version) {
        setUnverifiedSource(bill);
        throw new Error("The payment result could not be verified. Refresh this bill before retrying.");
      }
      setConfirmed(result.bill);
      setAmount(null); setReference(""); setSuccess("Payment recorded successfully.");
      refresh?.();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally { setBusy(false); }
  }
  return <>
    {busy ? <span className="back-link" aria-disabled="true"><ArrowLeft size={15} />Back to bill</span>
      : <Link className="back-link" href={`/bills/${encodeURIComponent(current.id)}`}><ArrowLeft size={15} />Back to bill</Link>}
    <PageHeader eyebrow="BILL PAYMENTS" title="Record payment" description={`Invoice ${current.invoiceNumber}`}>
      <StatusBadge status={current.paymentStatus ?? "UNPAID"} />
      {refresh && <Button variant="secondary" disabled={busy || refreshing} onClick={refresh}><RefreshCw size={15} />Refresh bill</Button>}
    </PageHeader>
    {error && <Notice tone="error">{error}</Notice>}
    {success && <Notice tone="success">{success}</Notice>}
    {refreshError && <Notice tone="error">{refreshError} Refresh the bill before recording another payment.</Notice>}
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
            <p className="field-hint">This records a local payment. It does not transfer funds or update Zoho Books.</p>
            <div className={styles.actions}><Button type="submit" disabled={busy || refreshing || !!refreshError || verificationBlocked}>
              {busy ? <LoaderCircle size={16} className="spin" /> : <Wallet size={16} />}Confirm payment</Button>
              {busy ? <Button type="button" variant="secondary" disabled>Cancel</Button>
                : <Button asChild variant="secondary"><Link href={`/bills/${encodeURIComponent(current.id)}`}>Cancel</Link></Button>}</div>
          </form> : <Notice tone={current.paymentStatus === "PAID" && finalized && balance === "0.00" ? "success" : "info"}>
            {!finalized ? "Payments can only be recorded against finalized bills."
              : balance === "0.00" ? "This bill has no outstanding amount."
                : "Payment amounts are unavailable. Refresh this bill before recording a payment."}
          </Notice>}
        </Card>
        <Card className={styles.history}>
          <div className="panel-heading"><h2>Payment history</h2><span className="muted small">Recorded in this workspace</span></div>
          {current.payments?.length ? <Table><thead><tr><th>Recorded on (Dubai)</th><th>Reference</th><th className="align-right">Amount</th></tr></thead>
            <tbody>{current.payments.map(payment => <tr key={payment.id}><td>{dateTime(payment.createdAt)}</td>
              <td>{payment.reference || "—"}</td><td className="align-right table-money">{money(payment.amount, current.currency)}</td></tr>)}</tbody></Table>
            : <p className="small-empty">No payments recorded for this bill.</p>}
        </Card>
      </div>
      <aside><Card className={`${styles.summary} ${isNativeBillPaid(current) ? styles.paidSummary : ""}`}>
        <h2>Payment summary</h2>
        <AmountRow label="Invoice total" value={balance === null ? null : billTotal(current)} currency={current.currency} />
        <AmountRow label="Paid (including VAT)" value={balance === null ? null : current.paidAmount ?? "0"} currency={current.currency} />
        <AmountRow label="Balance due" value={balance} currency={current.currency} strong />
      </Card></aside>
    </div>
  </>;
}
