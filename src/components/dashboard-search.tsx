"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, BriefcaseBusiness, LoaderCircle, Plus, ReceiptText, Search, X } from "lucide-react";
import { money, useApi } from "./api";
import { useUser } from "./app-shell";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input } from "./ui";
import type { DashboardSearchResult } from "./types";
import styles from "./dashboard-search.module.css";

function historyHref(job: { id: string; href?: string; canonicalJobId?: string | null }) {
  const expected = job.canonicalJobId === null ? `/jobs/crm/${encodeURIComponent(job.id)}`
    : `/jobs/${encodeURIComponent(job.canonicalJobId ?? job.id)}`;
  return job.href === expected || (job.href === undefined && job.canonicalJobId !== null) ? expected : null;
}
function historyReference(job: { id: string; jobNumber: string | null; displayReference?: string | null }) {
  return job.displayReference ?? job.jobNumber ?? job.id;
}

export function DashboardSearch({ companyId = "" }: { companyId?: string }) {
  const user = useUser();
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState<{ query: string; companyId: string } | null>(null);
  const ready = !!submitted && submitted.companyId === companyId && submitted.query === query.trim();
  const params = new URLSearchParams({ q: submitted?.query ?? "" });
  if (companyId) params.set("companyId", companyId);
  const state = useApi<DashboardSearchResult>(ready ? `/api/dashboard/search?${params}` : null);
  const results = state.data;
  const wrongScope = results && (results.query !== submitted?.query ||
    (companyId && (results.bills.some(row => row.companyId !== companyId) || results.jobs.some(row =>
      row.companyId !== companyId && !(row.referenceKind === "CRM_DEAL" && row.companyId === null && row.historyCompanies?.some(company => company.id === companyId))))) ||
    results.jobs.some(row => !historyHref(row) || !row.companyName ||
      (row.referenceKind === "CRM_DEAL" && (row.canCreateBill || row.canonicalJobId !== null)) ||
      (!row.companyId && (user.role !== "ADMIN" || row.companyId !== null || row.canCreateBill || row.canonicalJobId !== null))) ||
    results.bills.some(row => !/^\/bills\/(?:books\/)?[^/?#]+$/.test(row.href) || !row.companyId || !row.companyName ||
      row.relatedJobs?.some(job => job.companyId !== row.companyId || !historyHref(job))));
  const error = state.error || (wrongScope ? "Search results did not match your selection. Search again." : null);
  const canCreate = user.role !== "MANAGEMENT";

  return <Card className={styles.card}>
    <div className={styles.heading}>
      <span className={styles.icon}><Search size={21} /></span>
      <div><h2>Find a job or bill</h2><p>Search a job ID, bill number or job name to review its bill history and attachments, or add a bill.</p></div>
    </div>
    <form className={styles.form} role="search" aria-label="Find a job or bill" onSubmit={event => {
      event.preventDefault();
      const next = query.trim();
      if (!next) return;
      if (ready) state.reload();
      else setSubmitted({ query: next, companyId });
    }}>
      <Field label="Job ID, bill number or job name" htmlFor="dashboard-reference">
        <Input id="dashboard-reference" value={query} onChange={event => setQuery(event.target.value)}
          placeholder="e.g. JOB-5383, invoice number or project name" autoComplete="off" minLength={2} maxLength={100} required />
      </Field>
      <Button type="submit" disabled={query.trim().length < 2 || state.loading}>
        {state.loading ? <LoaderCircle size={17} className="spin" /> : <Search size={17} />}Search
      </Button>
      {(query || submitted) && <Button type="button" variant="ghost" aria-label="Clear job and bill search"
        onClick={() => { setQuery(""); setSubmitted(null); }}><X size={17} /></Button>}
    </form>
    {ready && <div className={styles.results} aria-live="polite" aria-busy={state.loading}>
      {state.loading ? <p className={styles.message} role="status">Searching jobs and bills…</p>
        : error ? <ErrorState message={error} retry={state.reload} />
          : results && <>
            {!results.jobs.length && !results.bills.length ? <EmptyState title="No matching job or bill"
              description="Check the reference or try part of the job ID, invoice number or job name." /> : <>
              {results.jobs.length > 0 && <section aria-label="Matching jobs" className={styles.group}>
                <h3>{results.jobs.some(job => job.referenceKind === "CRM_DEAL") ? "Jobs and CRM deals" : "Jobs"} <Badge>{results.jobs.length}</Badge></h3>
                {results.jobs.map(job => <article key={job.id} className={styles.row}>
                  <BriefcaseBusiness size={18} className={styles.resultIcon} />
                  <div className={styles.identity}>
                    <strong>{historyReference(job)}</strong>
                    {job.referenceKind === "CRM_DEAL" && <small>CRM deal · Read only</small>}
                    <span>{job.name}</span>
                    <small>{job.companyName} · {job.customer || "Customer not provided"}</small>
                    {job.referenceKind === "CRM_DEAL" && !!job.historyCompanies?.length && <small>Bill history: {job.historyCompanies.map(company => company.name).join(", ")}</small>}
                  </div>
                  <div className={styles.actions}>
                    <Button asChild variant="secondary" size="sm"><Link href={job.href}
                      aria-label={`${job.referenceKind === "CRM_DEAL" ? "View CRM deal history" : "View job"} ${historyReference(job)} for ${job.companyName}`}>
                      {job.referenceKind === "CRM_DEAL" ? "View CRM deal history" : "View job"}<ArrowUpRight size={15} /></Link></Button>
                    {canCreate && job.canCreateBill && job.canonicalJobId && <Button asChild size="sm">
                      <Link href={`/bills/new?jobId=${encodeURIComponent(job.canonicalJobId)}`}
                        aria-label={`Add bill to ${historyReference(job)} for ${job.companyName}`}><Plus size={15} />Add bill</Link>
                    </Button>}
                  </div>
                </article>)}
              </section>}
              {results.bills.length > 0 && <section aria-label="Matching bills" className={styles.group}>
                <h3>Bills <Badge>{results.bills.length}</Badge></h3>
                {results.bills.map(bill => {
                  const relatedJobs = bill.relatedJobs?.length ? bill.relatedJobs : bill.jobId ? [{ id: bill.jobId,
                    jobNumber: bill.jobNumber || bill.jobId, companyId: bill.companyId, companyName: bill.companyName,
                    canonicalJobId: bill.jobId, href: `/jobs/${encodeURIComponent(bill.jobId)}` }] : [];
                  return <article key={`${bill.source}:${bill.id}`} className={styles.row} style={{ flexWrap: "wrap" }}>
                  <ReceiptText size={18} className={styles.resultIcon} />
                  <div className={styles.identity}>
                    <strong>{bill.billNumber}</strong>
                    <span>{bill.vendorName}</span>
                    <small>{bill.companyName} · {bill.source === "BOOKS" ? "Zoho Books" : "Workspace bill"}</small>
                    <small>{relatedJobs.length ? relatedJobs.map(job => `${job.canonicalJobId === null ? "CRM deal" : "Job"} ${historyReference(job)}`).join(", ") : "No verified job link"}</small>
                  </div>
                  <strong className={styles.amount}>{money(bill.total, bill.currency)}</strong>
                  <div className={styles.actions}>
                    <Button asChild variant="secondary" size="sm"><Link href={bill.href}
                      aria-label={`View bill ${bill.billNumber} for ${bill.companyName}`}>View bill<ArrowUpRight size={15} /></Link></Button>
                    {relatedJobs.map(job => <Button key={job.id} asChild variant="ghost" size="sm">
                      <Link href={historyHref(job)!}
                        aria-label={`View ${job.canonicalJobId === null ? "CRM deal" : "job"} history ${historyReference(job)} for bill ${bill.billNumber} in ${job.companyName}`}>
                        {job.canonicalJobId === null ? `CRM deal ${historyReference(job)} history` : relatedJobs.length > 1 ? `Job ${historyReference(job)} history` : "View job history"}
                      </Link>
                    </Button>)}
                  </div>
                </article>; })}
              </section>}
            </>}
            {results.hasMore && <p className={styles.message}>More matches are available. Enter a more specific reference to narrow the results.</p>}
          </>}
    </div>}
  </Card>;
}
