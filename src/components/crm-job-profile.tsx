"use client";

import Link from "next/link";
import { ArrowLeft, BriefcaseBusiness, RefreshCw } from "lucide-react";
import { dateTime, money, useApi } from "./api";
import { Badge, Button, Card, ErrorState, LoadingPanel, Notice, PageHeader } from "./ui";
import { Metric } from "./records";
import { ImportedBillsTable } from "./imported-bills-table";
import type { ImportedBillSummary } from "./types";
import type { CrmJobSnapshotDto } from "@/lib/services/crm-job-import";
import styles from "./dashboard-overview.module.css";

export function CrmJobProfile({ id }: { id: string }) {
  const state = useApi<{ job: CrmJobSnapshotDto & { displayReference?: string | null;
    historyCompanies?: { id: string; name: string }[]; booksBills?: ImportedBillSummary[]; historyWarnings?: string[] } }>(`/api/jobs/crm/${encodeURIComponent(id)}`);
  if (state.loading) return <LoadingPanel />;
  if (state.error || !state.data) return <ErrorState message={state.error || "CRM job unavailable."} retry={state.reload} />;
  const job = state.data.job;
  const historyCompanies = job.historyCompanies ?? [];
  const booksBills = job.booksBills ?? [];
  if (job.id !== id || booksBills.some(bill => !historyCompanies.some(company => company.id === bill.companyId) ||
    bill.href !== `/bills/books/${encodeURIComponent(bill.id)}`)) {
    return <ErrorState message="CRM history could not be verified for this record and its companies." retry={state.reload} />;
  }
  const isDeal = !job.jobNumber && !job.canonicalJobId;
  const value = (amount: string | null) => job.currencyCode ? money(amount, job.currencyCode) : "Not available";
  return <>
    <Link className="back-link" href="/dashboard"><ArrowLeft size={15} />Back to dashboard</Link>
    <PageHeader eyebrow={job.jobNumber || (job.displayReference ? `CRM DEAL · ${job.displayReference}` : "CRM DEAL")}
      title={job.name || job.jobNumber || job.displayReference || "CRM deal"} description={job.customerName || "Customer not provided"}>
      <Badge>{job.stage || "Stage not provided"}</Badge>
      {isDeal && <Badge>Read only</Badge>}
      <Button type="button" variant="secondary" onClick={state.reload}><RefreshCw size={16} />{isDeal ? "Refresh history" : "Refresh job"}</Button>
      {job.canonicalJobId && <Button asChild><Link href={`/jobs/${encodeURIComponent(job.canonicalJobId)}`}>Open billing profile</Link></Button>}
    </PageHeader>
    <div className={styles.profileSource}><span>Company: <strong>{job.companyName || "Unassigned company"}</strong></span><span>Source: <strong>Zoho CRM</strong></span><span>CRM ID: <strong>{job.externalCrmId}</strong></span></div>
    {isDeal && <div className={styles.profileSource}><span>CRM deal reference: <strong>{job.displayReference || "Not provided"}</strong></span>
      {historyCompanies.length > 0 && <span>Bill history companies: <strong>{historyCompanies.map(company => company.name).join(", ")}</strong></span>}
    </div>}
    <Notice>
      {job.canonicalJobId ? "This record has a billing profile. Open it to review linked invoices or add a bill."
        : isDeal ? "Read-only CRM deal history. Existing bills are linked through verified source identities. A billing job and company routing must be verified before new bills can be entered."
          : "This CRM record is available for reference. Its job number and company routing must be verified before bills can be entered against it."}
      {job.isStale && <p>This record was not present in the latest completed CRM import. Review its source before using it.</p>}
    </Notice>
    <div className="metrics-grid">
      <Metric label={isDeal ? "CRM deal amount" : "CRM contract value"} value={value(job.amount)} note="Recorded source amount" icon={<BriefcaseBusiness size={18} />} />
      <Metric label="Approved variations" value={value(job.approvedVariations)} note="Recorded source amount" icon={<BriefcaseBusiness size={18} />} />
    </div>
    {job.historyWarnings?.length ? <Notice>{job.historyWarnings.map(warning => <p key={warning}>{warning}</p>)}</Notice> : null}
    {job.booksBills && <Card className={styles.history}>
      <div className="panel-heading"><div><h2>Linked Zoho Books history</h2>
        <p>Verified source associations and original files. Amounts are full invoice totals.</p></div><Badge>{booksBills.length} bills</Badge></div>
      <ImportedBillsTable bills={booksBills} showJob={false} showAttachments />
    </Card>}
    <Card className={styles.source}>
      <div className={styles.sourceHeading}><h2>CRM source record</h2><Badge>{job.linkStatus.toLowerCase().replaceAll("_", " ")}</Badge></div>
      <p>Last imported: {dateTime(job.lastSeenAt)} Dubai.</p>
      {job.sourceModifiedAt && <p>Source modified: {dateTime(job.sourceModifiedAt)} Dubai.</p>}
      <p>Invoice costs and profit are unavailable until this record is linked to a verified billing job.</p>
    </Card>
  </>;
}
