"use client";
import Link from "next/link";
import {
  ArrowUpRight,
  BriefcaseBusiness,
  ChevronRight,
  ReceiptText,
} from "lucide-react";
import type { Bill, Job, Money } from "./types";
import { billTotal, date, money, summary } from "./api";
import { Card, EmptyState, StatusBadge, Table } from "./ui";
import { NativeBillDocuments } from "./bill-history-documents";

export function Metric({
  label,
  value,
  note,
  icon,
  accent,
  negative,
}: {
  label: string;
  value: string;
  note: string;
  icon: React.ReactNode;
  accent?: boolean;
  negative?: boolean;
}) {
  return (
    <Card className={`metric-card ${accent ? "metric-accent" : ""}`}>
      <div className="metric-top">
        <span>{label}</span>
        <span className="metric-icon">{icon}</span>
      </div>
      <strong className={`metric-value ${negative ? "text-danger" : ""}`}>
        {value}
      </strong>
      <span className="metric-note">{note}</span>
    </Card>
  );
}
export function BillTable({
  bills,
  showJob = true,
  compact = false,
  showAttachments = false,
}: {
  bills: Bill[];
  showJob?: boolean;
  compact?: boolean;
  showAttachments?: boolean;
}) {
  if (!bills.length)
    return (
      <EmptyState
        title="No bills to show"
        description="Bills appear here after they have been recorded."
      />
    );
  return (
    <Table>
      <thead>
        <tr>
          <th>Invoice / vendor</th>
          {showJob && !compact && <th>Job reference</th>}
          <th>Invoice date</th>
          <th>Bill status</th>
          {!compact && <th>Payment</th>}
          <th className="align-right">Amount</th>
          <th>
            <span className="sr-only">Details</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {bills.map((bill) => (
          <tr key={bill.id}>
            <td>
              <Link className="table-primary" href={`/bills/${bill.id}`}>
                <span className="row-document-icon">
                  <ReceiptText size={15} />
                </span>
                {bill.invoiceNumber}
              </Link>
              <span className="table-secondary indent-document">
                {bill.vendor?.name ?? "Vendor unavailable"}
              </span>
              {showAttachments && <NativeBillDocuments bill={bill} />}
            </td>
            {showJob && !compact && (
              <td>
                <Link className="job-code" href={`/jobs/${bill.jobId}`}>
                  {bill.job?.jobNumber ?? "View job"}
                </Link>
              </td>
            )}
            <td className="muted">{date(bill.invoiceDate)}</td>
            <td>
              <StatusBadge status={bill.status} />
            </td>
            {!compact && (
              <td>
                <StatusBadge status={bill.paymentStatus ?? "UNPAID"} />
              </td>
            )}
            <td className="align-right table-money">
              {money(billTotal(bill), bill.currency)}
            </td>
            <td>
              <Link
                className="row-link"
                href={`/bills/${bill.id}`}
                aria-label={`View invoice ${bill.invoiceNumber}`}
              >
                <ArrowUpRight size={17} />
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
export function JobTable({ jobs }: { jobs: Job[] }) {
  if (!jobs.length)
    return (
      <EmptyState
        title="No jobs recorded"
        description="An administrator can add the first project to begin tracking its expenses."
      />
    );
  return (
    <Table>
      <thead>
        <tr>
          <th>Job / project</th>
          <th>Adjusted job value</th>
          <th>Recognized expenses</th>
          <th>Budget usage</th>
          <th>Status</th>
          <th>
            <span className="sr-only">Details</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => {
          const s = summary(job);
          const pct =
            s.expensePercentage === null ? null : Number(s.expensePercentage);
          return (
            <tr key={job.id}>
              <td>
                <Link className="table-primary" href={`/jobs/${job.id}`}>
                  <span className="row-job-icon">
                    <BriefcaseBusiness size={15} />
                  </span>
                  {job.jobNumber}
                </Link>
                <span className="table-secondary indent-document">
                  {job.name}
                </span>
              </td>
              <td className="table-money">
                {s.adjustedValue === null ? (
                  <span className="muted small">Job value not available</span>
                ) : (
                  money(s.adjustedValue, job.currency)
                )}
              </td>
              <td className="table-money">
                {money(s.recognizedExpenses, job.currency)}
              </td>
              <td>
                {pct === null ? (
                  <span className="muted">—</span>
                ) : (
                  <div className="budget-meter">
                    <div className="budget-meter-track">
                      <span
                        className={
                          pct > 100
                            ? "meter-danger"
                            : pct >= 90
                              ? "meter-warning"
                              : ""
                        }
                        style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }}
                      />
                    </div>
                    <span>{pct.toFixed(1)}%</span>
                  </div>
                )}
              </td>
              <td>
                <StatusBadge status={s.budgetStatus} />
              </td>
              <td>
                <Link
                  className="row-link"
                  href={`/jobs/${job.id}`}
                  aria-label={`View ${job.jobNumber}`}
                >
                  <ChevronRight size={17} />
                </Link>
              </td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
export function AmountRow({
  label,
  value,
  currency,
  strong,
}: {
  label: string;
  value: Money | null | undefined;
  currency: string;
  strong?: boolean;
}) {
  return (
    <div className={`amount-row ${strong ? "amount-row-strong" : ""}`}>
      <span>{label}</span>
      <strong>{money(value, currency)}</strong>
    </div>
  );
}
