"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Download, Wallet } from "lucide-react";
import { money, useApi } from "./api";
import type { Vendor } from "./types";
import { useOcrWorkspaceEnabled } from "./application-mode";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingPanel,
  Select,
  StatusBadge,
  Table,
} from "./ui";
import { Metric } from "./records";

type ExpenseData = {
  count: number;
  previewLimit: number;
  totals: {
    invoiced: string;
    recognized: string;
    paid: string;
    outstanding: string;
  };
  rows: {
    id: string;
    invoiceNumber: string;
    invoiceDate: string;
    vendor: string;
    jobNumber: string;
    status: string;
    paymentStatus: string;
    recognized: string;
    total: string;
  }[];
};
export function ExpenseReport({
  currency,
  jobId,
  companyId,
}: {
  currency: string;
  jobId: string;
  companyId?: string;
}) {
  const [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [vendorId, setVendor] = useState(""),
    [category, setCategory] = useState(""),
    [status, setStatus] = useState("");
  const vendors = useApi<{ vendors: Vendor[] }>("/api/vendors");
  const params = new URLSearchParams({ currency });
  for (const [key, value] of Object.entries({
    companyId,
    jobId,
    from,
    to,
    vendorId,
    category,
    status,
  }))
    if (value) params.set(key, value);
  const report = useApi<ExpenseData>(`/api/reports/bills?${params}`);
  return (
    <section className="expense-report">
      <div className="section-label">
        <div>
          <h2>Expense report</h2>
          <p className="muted small">
            Invoice-date filters apply to this report. Job budgets and estimated
            profit above use lifetime finalized costs.
          </p>
        </div>
        <Button asChild variant="secondary">
          <a href={`/api/reports/bills?${params}&format=csv`}>
            <Download size={16} />
            Export CSV for Excel
          </a>
        </Button>
      </div>
      <Card className="form-card">
        <fieldset className="report-filter-grid" disabled={vendors.loading}>
          <legend className="sr-only">Expense report filters</legend>
          <Field label="From invoice date" htmlFor="report-from">
            <Input
              id="report-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label="To invoice date" htmlFor="report-to">
            <Input
              id="report-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
          <Field label="Report vendor" htmlFor="report-vendor">
            <Select
              id="report-vendor"
              value={vendorId}
              onChange={(e) => setVendor(e.target.value)}
            >
              <option value="">All vendors</option>
              {vendors.data?.vendors.map((v) => (
                <option value={v.id} key={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Report category" htmlFor="report-category">
            <Select
              id="report-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">All categories</option>
              {["MATERIALS", "LABOUR", "EQUIPMENT", "TRANSPORT", "OTHER"].map(
                (v) => (
                  <option key={v}>{v}</option>
                ),
              )}
            </Select>
          </Field>
          <Field label="Bill status" htmlFor="report-status">
            <Select
              id="report-status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">All statuses</option>
              {[
                "DRAFT",
                "READY",
                "PENDING_APPROVAL",
                "APPROVED",
                "REJECTED",
                "CANCELLED",
              ].map((v) => (
                <option key={v} value={v}>{v === "READY" ? "Ready to sync" : v === "PENDING_APPROVAL" ? "Awaiting final save" : v === "APPROVED" ? "Approved (legacy)" : v}</option>
              ))}
            </Select>
          </Field>
        </fieldset>
      </Card>
      {report.error ? (
        <ErrorState message={report.error} retry={report.reload} />
      ) : report.loading || !report.data ? (
        <LoadingPanel />
      ) : (
        <>
          <div className="metrics-grid report-metrics">
            {[
              [
                "Invoice face value",
                report.data.totals.invoiced,
                "All selected statuses · including VAT",
              ],
              [
                "Recognized expenses",
                report.data.totals.recognized,
                "Finalized selected bills · excluding VAT",
              ],
              [
                "Paid expenses",
                report.data.totals.paid,
                "Finalized selected bills · including VAT",
              ],
              [
                "Outstanding",
                report.data.totals.outstanding,
                "Finalized selected bills · including VAT",
              ],
            ].map(([label, value, note]) => (
              <Metric
                key={label}
                label={label}
                value={money(value, currency)}
                note={note}
                icon={<Wallet size={18} />}
              />
            ))}
          </div>
          <Card>
            <div className="panel-heading">
              <h2>Matching bills</h2>
              <Badge>{report.data.count} records</Badge>
            </div>
            {!report.data.rows.length ? (
              <EmptyState
                title="No bills match these filters"
                description="Adjust the date range or other selections."
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Date</th>
                    <th>Vendor / job</th>
                    <th>Bill status</th>
                    <th>Payment</th>
                    <th className="align-right">Recognized cost</th>
                    <th className="align-right">Invoice total</th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <Link className="text-link" href={`/bills/${row.id}`}>
                          {row.invoiceNumber}
                        </Link>
                      </td>
                      <td>{row.invoiceDate}</td>
                      <td>
                        {row.vendor}
                        <br />
                        <span className="muted small">{row.jobNumber}</span>
                      </td>
                      <td>
                        <StatusBadge status={row.status} />
                      </td>
                      <td>
                        <StatusBadge status={row.paymentStatus} />
                      </td>
                      <td className="align-right">
                        {money(row.recognized, currency)}
                      </td>
                      <td className="align-right">
                        {money(row.total, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {report.data.count > report.data.previewLimit && (
              <p className="filter-footnote">
                Showing {report.data.previewLimit} bills. Export includes all{" "}
                {report.data.count} matching records.
              </p>
            )}
          </Card>
        </>
      )}
    </section>
  );
}

export function OperationAttention() {
  const ocrWorkspaceEnabled = useOcrWorkspaceEnabled();
  const state = useApi<{
    ocrReview: number;
    ocrFailed: number;
    ocrQueued: number;
    syncFailures: number;
    syncUnknown: number;
    duplicateWarnings: number;
    duplicateScanTruncated: boolean;
  }>("/api/operations");
  const { reload } = state;
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, 30000);
    return () => clearInterval(timer);
  }, [reload]);
  if (state.error)
    return <ErrorState message={state.error} retry={state.reload} />;
  return (
    <Card className="form-card operation-attention">
      <div className="panel-heading compact">
        <div>
          <h2>{ocrWorkspaceEnabled ? "Automation attention" : "Synchronization attention"}</h2>
          <p>
            {ocrWorkspaceEnabled
              ? "Document and synchronization queues across your accessible companies, dates and currencies. Review extracted invoices, then Save and sync."
              : "Synchronization across your accessible companies, dates and currencies. Open the bill to review its Zoho Books status."}
          </p>
        </div>
        <Button variant="ghost" onClick={state.reload}>
          Refresh
        </Button>
      </div>
      <div className="operations-grid">
        {[
          ...(ocrWorkspaceEnabled ? [
          ["OCR awaiting review", state.data?.ocrReview, "/ocr/batch"],
          ["OCR queued / processing", state.data?.ocrQueued, "/ocr/batch"],
          ["OCR processing errors", state.data?.ocrFailed, "/ocr/batch"],
          [
            "OCR duplicate warnings",
            state.data?.duplicateWarnings,
            "/ocr/batch",
          ],
          ] : []),
          [
            "Synchronization failures",
            state.data?.syncFailures,
            null,
          ],
          [
            "Uncertain external outcomes",
            state.data?.syncUnknown,
            null,
          ],
        ].map(([label, count, href]) => href ? (
          <Link href={String(href)} key={String(label)}>
            <span>{label}</span>
            <strong>{state.loading ? "…" : count}</strong>
          </Link>
        ) : (
          <div key={String(label)}>
            <span>{label}</span>
            <strong>{state.loading ? "…" : count}</strong>
          </div>
        ))}
      </div>
      {ocrWorkspaceEnabled && state.data?.duplicateScanTruncated && (
        <p className="filter-footnote">
          Duplicate count covers the latest 200 documents awaiting review. Older
          documents are checked when opened.
        </p>
      )}
    </Card>
  );
}
