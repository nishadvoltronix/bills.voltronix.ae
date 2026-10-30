"use client";

import Link from "next/link";
import { ArrowUpRight, ReceiptText } from "lucide-react";
import { date, money } from "./api";
import type { ImportedBillSummary } from "./types";
import { Badge, EmptyState, Table } from "./ui";
import { ImportedBillDocuments } from "./bill-history-documents";

export function ImportedBillsTable({ bills, showJob = true, showAttachments = false }: { bills: ImportedBillSummary[]; showJob?: boolean; showAttachments?: boolean }) {
  if (!bills.length) return <EmptyState title="No linked Zoho Books bills"
    description="Imported bills appear here when their job reference is verified for this company." />;
  return <Table>
    <thead><tr><th>Invoice / supplier</th><th>Company</th>{showJob && <th>Job</th>}<th>Invoice date</th><th>Books status</th><th className="align-right">Amount</th><th><span className="sr-only">Details</span></th></tr></thead>
    <tbody>{bills.map(bill => <tr key={bill.id}>
      <td><Link className="table-primary" href={`/bills/books/${encodeURIComponent(bill.id)}`}><span className="row-document-icon"><ReceiptText size={15} /></span>{bill.billNumber}</Link>
        <span className="table-secondary indent-document">{bill.vendorName}</span>
        {showAttachments && bill.relationEvidence && <span className="table-secondary">{bill.relationEvidence}</span>}
        {showAttachments && bill.allocationKnown === false && <span className="table-secondary">Job cost allocation unverified</span>}
        {showAttachments && <ImportedBillDocuments bill={bill} />}</td>
      <td>{bill.companyName}</td>
      {showJob && <td>{bill.jobId ? <Link className="job-code" href={`/jobs/${encodeURIComponent(bill.jobId)}`}>{bill.jobNumber || "View job"}</Link> : <span className="muted small">Job not linked</span>}</td>}
      <td className="muted">{date(bill.billDate)}</td>
      <td><Badge tone={bill.status === "paid" ? "success" : bill.status === "overdue" ? "danger" : "neutral"}>{bill.status || "Not provided"}</Badge></td>
      <td className="align-right table-money">{money(bill.total, bill.currency)}</td>
      <td><Link className="row-link" href={`/bills/books/${encodeURIComponent(bill.id)}`} aria-label={`View imported invoice ${bill.billNumber}`}><ArrowUpRight size={17} /></Link></td>
    </tr>)}</tbody>
  </Table>;
}
