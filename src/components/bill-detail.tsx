"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import Decimal from "decimal.js";
import { PAYMENT_TERMS } from "@/lib/payment-terms";
import {
  ArrowLeft,
  Download,
  FileText,
  FileUp,
  History,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Send,
  Wallet,
  X,
} from "lucide-react";
import {
  api,
  billTotal,
  date,
  dateTime,
  errorMessage,
  money,
  useApi,
} from "./api";
import type { AuditEvent, Bill, BooksConnection } from "./types";
import { useManualEntryOnly, useUser } from "./app-shell";
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  LoadingPanel,
  Notice,
  PageHeader,
  Select,
  StatusBadge,
  Table,
  Textarea,
} from "./ui";
import { AmountRow } from "./records";

function savedBillNotice(bill: Bill, manualEntryOnly: boolean): { tone: "info" | "success" | "error"; message: string } {
  if (manualEntryOnly)
    return { tone: "success", message: ["DRAFT", "REJECTED"].includes(bill.status)
      ? "Draft saved. Open it again to finish entering the bill."
      : "Bill saved successfully." };
  if (["DRAFT", "REJECTED"].includes(bill.status))
    return { tone: "success", message: "Draft saved. It has not been sent to Zoho Books." };
  const sync = bill.syncRecords?.find((record) => record.target === "ZOHO");
  if (sync?.status === "SYNCED" && sync.externalId)
    return { tone: "success", message: "Bill saved and synchronized with Zoho Books." };
  if (sync?.status === "PENDING")
    return { tone: "info", message: sync.externalId
      ? "Bill created in Zoho Books. Attachment synchronization is still pending."
      : "Bill saved. Zoho Books synchronization queued. Provider confirmation is pending." };
  if (sync?.status === "UNKNOWN")
    return { tone: "error", message: "Bill saved. The Zoho Books result is uncertain. Reconcile this bill before retrying." };
  if (sync?.externalId)
    return { tone: "error", message: "Bill created in Zoho Books, but synchronization is incomplete. Check the synchronization details below." };
  return { tone: "error", message: `Bill saved, but it has not synchronized with Zoho Books. ${sync?.lastError || "Books synchronization is not ready for this bill. Check the synchronization details below."}` };
}

function auditReason(event: AuditEvent) {
  const details = event.details;
  return (
    event.reason ??
    (details &&
    typeof details === "object" &&
    "reason" in details &&
    typeof details.reason === "string"
      ? details.reason
      : null)
  );
}
export function AuditTimeline({ events }: { events: AuditEvent[] }) {
  if (!events.length)
    return <div className="small-empty">No audit events available.</div>;
  return (
    <ol className="audit-timeline">
      {events.map((event) => (
        <li key={event.id}>
          <span className="timeline-dot">
            <History size={12} />
          </span>
          <div>
            <strong>{event.action.replaceAll("_", " ").toLowerCase()}</strong>
            <p>
              {event.actor?.name ?? event.user?.name ?? "System"}{" "}
              <span>· {dateTime(event.createdAt)} Dubai</span>
            </p>
            {auditReason(event) && (
              <p className="timeline-reason">{auditReason(event)}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
export function BillDetail({
  id,
  saved = false,
}: {
  id: string;
  saved?: boolean;
}) {
  const state = useApi<{ bill: Bill }>(`/api/bills/${id}`, { keepPreviousData: true });
  const user = useUser();
  const manualEntryOnly = useManualEntryOnly();
  const integrations = useApi<{
    zoho: BooksConnection;
    crm: { status: string; message: string };
  }>(manualEntryOnly ? null : "/api/integrations");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [showSaveOutcome, setShowSaveOutcome] = useState(saved);
  const [action, setAction] = useState<"cancel" | "payment" | null>(
    null,
  );
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [selectedOrganization, setSelectedOrganization] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const bill = state.data?.bill;
  const canWrite = user.role !== "MANAGEMENT" &&
    (user.role !== "DATA_ENTRY" || bill?.createdBy?.id === user.id);
  const organizations = (integrations.data?.zoho.organizations ?? []).filter((organization) => organization.companyId === bill?.companyId);
  const booksRecord = bill?.syncRecords?.find(
    (record) => record.target === "ZOHO",
  );
  const booksJobs = bill?.integrationJobs ?? [];
  const hasBooksOperation = booksJobs.length > 0;
  const syncPending = !manualEntryOnly && (booksRecord?.status === "PENDING" ||
    booksJobs.some((job) => ["QUEUED", "RETRY", "PROCESSING"].includes(job.status)));
  const reloadBill = state.reload;
  const refreshInFlight = useRef(false);
  useEffect(() => {
    refreshInFlight.current = state.refreshing;
  }, [state.refreshing]);
  useEffect(() => {
    if (!syncPending || busy) return;
    // Poll only while confirmation is pending, for at most two minutes.
    // Reads never enqueue or retry provider writes.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible" && !refreshInFlight.current) reloadBill();
    }, 5000);
    const deadline = setTimeout(() => clearInterval(interval), 120000);
    return () => {
      clearInterval(interval);
      clearTimeout(deadline);
    };
  }, [id, syncPending, busy, reloadBill]);
  const lockedOrganization = booksRecord?.organizationId;
  const organizationId =
    lockedOrganization ??
    (selectedOrganization ||
      (organizations.length === 1 ? organizations[0].organizationId : ""));
  const selectedConnection = organizations.find(
    (organization) => organization.organizationId === organizationId,
  );
  async function queueSync() {
    if (!canWrite || !organizationId || !selectedConnection?.writeEnabled) return;
    setBusy(true);
    setError("");
    setSuccess("");
    setShowSaveOutcome(false);
    try {
      await api(`/api/bills/${id}/sync`, {
        method: "POST",
        body: JSON.stringify({ target: "ZOHO", organizationId }),
      });
      setShowSaveOutcome(true);
      state.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function recoverSync(job: NonNullable<Bill["integrationJobs"]>[number], action: "retry" | "reconcile") {
    if (!canWrite || !["ADMIN", "ACCOUNTS"].includes(user.role)) return;
    setBusy(true);
    setError("");
    setSuccess("");
    setShowSaveOutcome(false);
    try {
      await api(`/api/integrations/jobs/${job.id}`, {
        method: "POST",
        body: JSON.stringify({ action, organizationId: job.organizationId }),
      });
      setSuccess(action === "reconcile"
        ? "Zoho Books reconciliation queued. The worker will check the existing outcome before any further posting."
        : "Zoho Books retry queued for the existing operation.");
      state.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function apply(actionName: string) {
    if (!bill) return;
    setBusy(true);
    setError("");
    setSuccess("");
    setShowSaveOutcome(false);
    try {
      await api(`/api/bills/${id}/actions`, {
        method: "POST",
        body: JSON.stringify({
          action: actionName,
          version: bill.version,
          ...(actionName === "payment" ? { amount, reference } : {}),
          ...(actionName === "cancel" ? { reason } : {}),
        }),
      });
      setAction(null);
      setReason("");
      setAmount("");
      setReference("");
      setSuccess(
        actionName === "payment"
          ? "Payment recorded successfully."
          : actionName === "submit"
            ? ""
            : "Bill updated successfully.",
      );
      if (actionName === "submit") setShowSaveOutcome(true);
      state.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set("file", file);
      await api(`/api/bills/${id}/attachment`, { method: "POST", body: form });
      setSuccess("Document uploaded securely.");
      setFile(null);
      state.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  if (state.loading) return <LoadingPanel />;
  if (state.error || !bill)
    return (
      <ErrorState
        message={state.error ?? "Bill unavailable"}
        retry={state.reload}
      />
    );
  const accounts = user.role === "ADMIN" || user.role === "ACCOUNTS";
  const editable =
    ["DRAFT", "REJECTED"].includes(bill.status) && canWrite;
  const canFinalize = canWrite && ["DRAFT", "REJECTED", "PENDING_APPROVAL"].includes(bill.status);
  const financialReady = ["READY", "APPROVED"].includes(bill.status);
  const remaining = new Decimal(String(billTotal(bill)))
    .minus(String(bill.paidAmount ?? "0"))
    .toFixed(2);
  const docs = bill.documents ?? bill.attachments ?? [];
  const lines = bill.lines ?? bill.lineItems ?? [];
  const usesLineBooks = lines.some((line) => !!line.booksSelection);
  const saveOutcome = savedBillNotice(bill, manualEntryOnly);
  return (
    <>
      <Link className="back-link" href="/bills">
        <ArrowLeft size={15} />
        Back to bills
      </Link>
      <PageHeader
        eyebrow="BILL DETAILS"
        title={bill.invoiceNumber}
        description={`${bill.vendor?.name ?? "Vendor"} · Created ${date(bill.createdAt)} by ${bill.createdBy?.name ?? "staff"}`}
      >
        <StatusBadge status={bill.status} />
        <StatusBadge status={bill.paymentStatus ?? "UNPAID"} />
        {editable && (
          <Button variant="secondary" asChild>
            <Link href={`/bills/${id}/edit`}>
              <Pencil size={15} />
              Edit bill
            </Link>
          </Button>
        )}
      </PageHeader>
      {error && (
        <Notice tone="error" onClose={() => setError("")}>
          {error}{" "}
          <button className="inline-button" onClick={state.reload}>
            Refresh bill
          </button>
        </Notice>
      )}
      {success && (
        <Notice tone="success" onClose={() => setSuccess("")}>
          {success}
        </Notice>
      )}
      {showSaveOutcome && !state.refreshing && !state.refreshError && (
        <Notice tone={saveOutcome.tone} onClose={() => setShowSaveOutcome(false)}>
          {saveOutcome.message}
        </Notice>
      )}
      <div className="bill-detail-layout">
        <div className="detail-main">
          <Card className="form-card">
            <div className="panel-heading compact">
              <h2>Invoice information</h2>
              <span className="version-label">Version {bill.version}</span>
            </div>
            <dl className="detail-grid">
              <div>
                <dt>Vendor</dt>
                <dd>{bill.vendor?.name ?? "—"}</dd>
              </div>
              <div>
                <dt>Job / project</dt>
                <dd>
                  <Link className="text-link" href={`/jobs/${bill.jobId}`}>
                    {bill.job?.jobNumber ?? "View job"}
                    <span>· {bill.job?.name}</span>
                  </Link>
                </dd>
              </div>
              <div>
                <dt>Invoice date</dt>
                <dd>{date(bill.invoiceDate)}</dd>
              </div>
              <div>
                <dt>Due date</dt>
                <dd>{date(bill.dueDate)}</dd>
              </div>
              <div>
                <dt>Order Number</dt>
                <dd>{bill.orderNumber || "—"}</dd>
              </div>
              <div>
                <dt>Payment Terms</dt>
                <dd>
                  {PAYMENT_TERMS.find(
                    (term) => term.value === (bill.paymentTerms ?? "CUSTOM"),
                  )?.label ?? "Custom"}
                </dd>
              </div>
              <div>
                <dt>Expense category</dt>
                <dd>{bill.category}</dd>
              </div>
              <div>
                <dt>Currency</dt>
                <dd>{bill.currency}</dd>
              </div>
            </dl>
            {bill.description && (
              <div className="invoice-notes">
                <strong>Description</strong>
                <p>{bill.description}</p>
              </div>
            )}
            {bill.notes && (
              <div className="invoice-notes">
                <strong>Internal notes</strong>
                <p>{bill.notes}</p>
              </div>
            )}
          </Card>
          <Card>
            <div className="panel-heading">
              <h2>Line items</h2>
              <span className="muted small">Prices excluding VAT</span>
            </div>
            <Table>
              <thead>
                <tr>
                  <th>Description</th>
                  {usesLineBooks && <th>Books account</th>}
                  <th className="align-right">Quantity</th>
                  <th className="align-right">Unit price</th>
                  <th className="align-right">Amount</th>
                  {usesLineBooks && <th>Tax / customer</th>}
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => (
                  <tr key={line.id ?? i}>
                    <td className="line-description-text">
                      {line.description}
                    </td>
                    {usesLineBooks && <td>{line.booksSelection?.accountName ?? "—"}</td>}
                    <td className="align-right">{String(line.quantity)}</td>
                    <td className="align-right">
                      {money(line.unitPrice, bill.currency)}
                    </td>
                    <td className="align-right table-money">
                      {money(line.lineTotal ?? line.total, bill.currency)}
                    </td>
                    {usesLineBooks && <td>
                      {line.booksSelection ? <>
                        <div>{line.booksSelection.taxName} ({line.booksSelection.taxRate}%)</div>
                        {line.booksSelection.customerName && <div className="muted small">{line.booksSelection.customerName}</div>}
                      </> : "—"}
                    </td>}
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card>
            <div className="panel-heading">
              <div>
                <h2>Invoice documents</h2>
                <p>Private attachments, accessible to authorized staff</p>
              </div>
              <Badge>{docs.length} files</Badge>
            </div>
            <div className="document-list">
              {docs.length ? (
                docs.map((doc) => (
                  <a
                    className="document-row"
                    key={doc.id}
                    href={`/api/documents/${doc.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span className="document-icon">
                      <FileText size={21} />
                    </span>
                    <div>
                      <strong>
                        {doc.fileName ??
                          doc.originalName ??
                          doc.filename ??
                          "Invoice document"}
                      </strong>
                      <span>
                        {doc.createdAt
                          ? date(doc.createdAt)
                          : "Secure attachment"}
                      </span>
                    </div>
                    <Download size={17} />
                  </a>
                ))
              ) : (
                <div className="small-empty">
                  No invoice documents attached.
                </div>
              )}
            </div>
            {user.role !== "MANAGEMENT" &&
              ["DRAFT", "REJECTED", "PENDING_APPROVAL"].includes(
                bill.status,
              ) && (
                <form className="attachment-form" onSubmit={upload}>
                  <Field label="Add attachment" htmlFor="detail-file">
                    <Input
                      id="detail-file"
                      type="file"
                      required
                      accept="application/pdf,image/png,image/jpeg"
                      onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    />
                  </Field>
                  <Button
                    type="submit"
                    variant="secondary"
                    disabled={busy || !file}
                  >
                    <FileUp size={15} />
                    Upload
                  </Button>
                </form>
              )}
          </Card>
          <Card>
            <div className="panel-heading">
              <h2>Payment history</h2>
              <Badge>Including VAT</Badge>
            </div>
            {bill.payments?.length ? (
              <Table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Reference</th>
                    <th className="align-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {bill.payments.map((p) => (
                    <tr key={p.id}>
                      <td>{date(p.createdAt)}</td>
                      <td>{p.reference || "—"}</td>
                      <td className="align-right table-money">
                        {money(p.amount, bill.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <div className="small-empty">
                No payments recorded for this bill.
              </div>
            )}
          </Card>
          <Card>
            <div className="panel-heading">
              <h2>Audit history</h2>
              <History size={18} className="muted" />
            </div>
            <AuditTimeline events={bill.auditLogs ?? bill.auditEvents ?? []} />
          </Card>
        </div>
        <aside className="detail-aside">
          <Card className="summary-card">
            <h2>Financial summary</h2>
            <AmountRow
              label="Subtotal"
              value={bill.subtotal ?? bill.subTotal}
              currency={bill.currency}
            />
            <AmountRow
              label="Discount"
              value={bill.discount}
              currency={bill.currency}
            />
            <AmountRow
              label={usesLineBooks ? "VAT (line taxes)" : `VAT (${bill.vatRate}%)`}
              value={bill.vatAmount}
              currency={bill.currency}
            />
            <AmountRow
              label="Invoice total"
              value={billTotal(bill)}
              currency={bill.currency}
              strong
            />
            <AmountRow
              label="Paid (including VAT)"
              value={bill.paidAmount ?? 0}
              currency={bill.currency}
            />
            <AmountRow
              label="Outstanding"
              value={
                bill.outstanding ??
                (financialReady ? remaining : "0")
              }
              currency={bill.currency}
            />
            <div className="detail-actions">
              {canFinalize && (
                <Button onClick={() => apply("submit")} disabled={busy}>
                  <Send size={15} />
                  {manualEntryOnly ? "Save bill" : "Save and sync"}
                </Button>
              )}
              {accounts &&
                financialReady &&
                new Decimal(remaining).gt(0) && (
                  <Button
                    onClick={() => {
                      setAction("payment");
                      setAmount(remaining);
                    }}
                    disabled={busy}
                  >
                    <Wallet size={16} />
                    Record payment
                  </Button>
                )}
              {accounts &&
                bill.status !== "CANCELLED" &&
                Number(bill.paidAmount ?? 0) === 0 && (
                  <Button
                    variant="ghost"
                    onClick={() => setAction("cancel")}
                    disabled={busy}
                  >
                    Cancel bill
                  </Button>
                )}
            </div>
          </Card>
          {action && (
            <Card className="summary-card action-card">
              <div className="inline-heading">
                <h2>
                  {action === "payment"
                    ? "Record payment"
                    : "Cancel bill"}
                </h2>
                <button
                  className="icon-button"
                  aria-label="Close action"
                  onClick={() => setAction(null)}
                >
                  <X size={16} />
                </button>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void apply(action);
                }}
              >
                {action === "payment" ? (
                  <>
                    <Field
                      label={`Payment amount (${bill.currency})`}
                      htmlFor="payment-amount"
                    >
                      <Input
                        id="payment-amount"
                        type="number"
                        min="0.01"
                        max={remaining}
                        step="0.01"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        required
                      />
                    </Field>
                    <Field
                      label="Payment reference"
                      htmlFor="payment-reference"
                    >
                      <Input
                        id="payment-reference"
                        value={reference}
                        onChange={(e) => setReference(e.target.value)}
                        placeholder="Transfer or receipt reference"
                        maxLength={200}
                        required
                      />
                    </Field>
                    <p className="field-hint">
                      This records a payment in the ledger. It does not transfer
                      funds.
                    </p>
                  </>
                ) : (
                  <Field label="Reason" htmlFor="action-reason">
                    <Textarea
                      id="action-reason"
                      rows={3}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      required
                      minLength={3}
                      maxLength={1000}
                    />
                  </Field>
                )}
                <Button
                  type="submit"
                  variant={action === "payment" ? "default" : "destructive"}
                  disabled={busy}
                >
                  {busy && <LoaderCircle className="spin" size={16} />}Confirm{" "}
                  {action === "payment"
                    ? "payment"
                    : "cancellation"}
                </Button>
              </form>
            </Card>
          )}
          {!manualEntryOnly && <Card className="summary-card integration-summary">
            <h2>Synchronization</h2>
            <Button variant="secondary" disabled={busy || state.refreshing} onClick={() => {
              state.reload();
              integrations.reload();
            }}>
              <RefreshCw size={15} className={state.refreshing ? "spin" : undefined} />
              Refresh sync status
            </Button>
            {state.refreshError && (
              <p className="text-danger" role="alert">Status could not be refreshed. {state.refreshError}</p>
            )}
            {["ZOHO", "CRM"].map((target) => {
              const sync = bill.syncRecords?.find(
                (record) => record.target === target,
              );
              return (
                <div key={target}>
                  <strong>{target === "ZOHO" ? "Zoho Books" : "CRM"}</strong>
                  <StatusBadge status={sync?.status ?? "NOT_CONFIGURED"} />
                </div>
              );
            })}
            {bill.syncRecords
              ?.filter((record) => record.lastError)
              .map((record) => (
                <p key={record.id} className="text-danger">
                  {record.lastError}
                </p>
              ))}
            {booksRecord?.externalId && (
              <p>Books bill ID: <strong>{booksRecord.externalId}</strong></p>
            )}
            {booksJobs.filter((job) => job.status !== "SUCCEEDED").map((job) => {
              const uncertain = job.needsReconciliation || job.status === "UNKNOWN";
              const waiting = ["QUEUED", "RETRY", "PROCESSING"].includes(job.status);
              return (
                <div key={job.id} role="group" aria-label={`${job.operation === "CREATE_BILL" ? "Bill" : "Attachment"} synchronization recovery`}>
                  <strong>{job.operation === "CREATE_BILL" ? "Bill posting" : "Original attachment"}</strong>{" "}
                  <StatusBadge status={job.status} />
                  {job.lastError && <p className="text-danger">{job.lastError}</p>}
                  {job.status === "RETRY" && <p>Automatic retry scheduled for {dateTime(job.nextAttemptAt)} Dubai.</p>}
                  {accounts && canWrite && !waiting && (
                    <Button variant="secondary" disabled={busy || (!uncertain && !selectedConnection?.writeEnabled)}
                      onClick={() => recoverSync(job, uncertain ? "reconcile" : "retry")}>
                      {uncertain ? "Reconcile Zoho Books outcome" : job.operation === "CREATE_BILL" ? "Retry Zoho Books sync" : "Retry original attachment"}
                    </Button>
                  )}
                  {!accounts && !waiting && <p>Ask an administrator or Accounts user to {uncertain ? "reconcile the existing Books outcome" : "retry this operation"}.</p>}
                </div>
              );
            })}
            {syncPending && (
              <p>Waiting for Zoho Books confirmation. This page checks for updates for two minutes; use Refresh sync status to check again.</p>
            )}
            <p>
              Saving and synchronization do not record a payment. Check the
              status here to see whether the bill reached Zoho Books.
            </p>
            {canWrite && financialReady && (
              <>
                <Field
                  label="Books organization"
                  htmlFor="sync-books-organization"
                >
                  <Select
                    id="sync-books-organization"
                    value={organizationId}
                    disabled={busy || !!lockedOrganization}
                    onChange={(event) => {
                      setSelectedOrganization(event.target.value);
                    }}
                  >
                    <option value="">Select Books organization</option>
                    {lockedOrganization && !selectedConnection && (
                      <option value={lockedOrganization}>
                        Organization {lockedOrganization}
                      </option>
                    )}
                    {organizations.map((organization) => (
                      <option
                        key={organization.organizationId}
                        value={organization.organizationId}
                      >
                        {organization.name} ({organization.organizationId})
                      </option>
                    ))}
                  </Select>
                </Field>
                {lockedOrganization && (
                  <p>
                    Destination locked to{" "}
                    {selectedConnection?.name ?? lockedOrganization} (
                    {lockedOrganization}). Retry and reconciliation use this
                    organization.
                  </p>
                )}
                {selectedConnection && !selectedConnection.writeEnabled && (
                  <p>Books synchronization is unavailable for this destination. Contact your administrator.</p>
                )}
                {integrations.data && organizations.length === 0 && (
                  <p>Books synchronization is unavailable for this company. Contact your administrator.</p>
                )}
                {!hasBooksOperation && <Button
                  variant="secondary"
                  disabled={busy || !selectedConnection?.writeEnabled || ["PENDING", "UNKNOWN", "SYNCED"].includes(booksRecord?.status ?? "") || !!booksRecord?.externalId}
                  onClick={queueSync}
                >
                  Queue Zoho Books sync
                </Button>}
              </>
            )}
            {integrations.error && (
              <p className="text-danger">{integrations.error}</p>
            )}
          </Card>}
        </aside>
      </div>
    </>
  );
}
