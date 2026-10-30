"use client";

import Link from "next/link";
import { useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, LoaderCircle, Search } from "lucide-react";
import { api, errorMessage, money, useApi } from "./api";
import { useManualEntryOnly, useUser } from "./app-shell";
import type { Company, DashboardSearchResult, Job } from "./types";
import { Button, Card, EmptyState, Field, Input, LoadingPanel, Notice, PageHeader, Table } from "./ui";
import searchStyles from "./dashboard-search.module.css";

type CrmJobSuggestion = {
  id: string | null;
  companyId: string;
  jobNumber: string;
  name: string;
  customer: string;
  currency: string;
  contractValue: string | null;
  approvedVariations: string;
  externalCrmId: string;
  stage: string | null;
  crmOrganizationId: string;
  dataCenter: string;
  environment: "production" | "sandbox";
  booksOrganizationId: string;
  sourceId: string;
};
type CrmJobSearch = { companyId: string | null; jobs: CrmJobSuggestion[]; warning: string | null; hasMore: boolean };

function historyHref(job: { id: string; href?: string; canonicalJobId?: string | null }) {
  const expected = job.canonicalJobId === null ? `/jobs/crm/${encodeURIComponent(job.id)}`
    : `/jobs/${encodeURIComponent(job.canonicalJobId ?? job.id)}`;
  return job.href === expected || (job.href === undefined && job.canonicalJobId !== null) ? expected : null;
}
function historyReference(job: { id: string; jobNumber: string | null; displayReference?: string | null }) {
  return job.displayReference ?? job.jobNumber ?? job.id;
}

export function ManualBillEntry() {
  const router = useRouter();
  const user = useUser();
  const manualEntryOnly = useManualEntryOnly();
  const canEnter = user.role !== "MANAGEMENT";
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const companies = useApi<{ companies: Company[] }>(canEnter ? "/api/companies" : null);
  const visibleCompanies = (companies.data?.companies ?? []).filter((company) => !/^\s*\[DEMO\]/i.test(company.name));
  const companyNames = new Map(visibleCompanies.map((company) => [company.id, company.name.replace(/^\s*\[CONNECTION CHECK\]\s*/i, "")]));
  const searchReady = canEnter && submittedQuery.length >= 2 && submittedQuery === query.trim() &&
    !!companies.data && visibleCompanies.length > 0;
  const params = new URLSearchParams({ q: submittedQuery });
  const matches = useApi<DashboardSearchResult>(searchReady ? `/api/dashboard/search?${params}` : null);
  const matchesScopeError = matches.data && (matches.data.query !== submittedQuery ||
    matches.data.jobs.some(job => !historyHref(job) ||
      (job.referenceKind === "CRM_DEAL" && (job.canCreateBill || job.canonicalJobId !== null)) ||
      job.historyCompanies?.some(company => !companyNames.has(company.id)) ||
      (job.companyId ? !companyNames.has(job.companyId) : user.role !== "ADMIN" || job.canCreateBill || job.canonicalJobId !== null)) ||
    matches.data.bills.some(bill => !companyNames.has(bill.companyId) || !/^\/bills\/(?:books\/)?[^/?#]+$/.test(bill.href) ||
      bill.relatedJobs?.some(job => job.companyId !== bill.companyId || !historyHref(job))))
    ? "Search results could not be verified for your companies. Retry the search." : null;
  const matchesError = matches.error || matchesScopeError;
  const jobs = matchesScopeError ? [] : matches.data?.jobs ?? [];
  const bills = matchesScopeError ? [] : matches.data?.bills ?? [];
  const crmSearchReady = !manualEntryOnly && searchReady && submittedQuery.length >= 2;
  const crm = useApi<CrmJobSearch>(crmSearchReady ? `/api/jobs/search?${params}` : null);
  const crmScopeError = crm.data && (crm.data.companyId !== null || crm.data.jobs.some((job) =>
    !companyNames.has(job.companyId) || !job.externalCrmId || !job.crmOrganizationId || !job.booksOrganizationId ||
    !job.sourceId || !job.dataCenter || !["production", "sandbox"].includes(job.environment)))
    ? "CRM results could not be verified for your companies. Retry the search." : null;
  const crmJobs = crmScopeError ? [] : crm.data?.jobs ?? [];
  const crmError = crm.error || crmScopeError;
  const hideEmptySavedResults = crmSearchReady && !!matches.data && !matches.loading &&
    !matchesError && jobs.length === 0 && bills.length === 0 && (crm.loading || crmJobs.length > 0);
  const scopeKey = JSON.stringify([submittedQuery, query.trim()]);
  const [selection, setSelection] = useState<{ key: string; suggestion: CrmJobSuggestion; pending: boolean; error: string | null } | null>(null);
  const currentSelection = selection?.key === scopeKey ? selection : null;
  const selectionRequest = useRef<AbortController | null>(null);
  const selectionVersion = useRef(0);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      selectionVersion.current += 1;
      selectionRequest.current?.abort();
    };
  }, []);

  function cancelSelection() {
    selectionVersion.current += 1;
    selectionRequest.current?.abort();
    setSelection(null);
  }

  function retryCrmSearch() {
    cancelSelection();
    crm.reload();
  }

  async function selectCrmJob(suggestion: CrmJobSuggestion) {
    if (!crmSearchReady || !companyNames.has(suggestion.companyId) || currentSelection?.pending) return;
    cancelSelection();
    const controller = new AbortController();
    selectionRequest.current = controller;
    const version = ++selectionVersion.current;
    setSelection({ key: scopeKey, suggestion, pending: true, error: null });
    try {
      const { job } = await api<{ job: Job; stage: string | null }>("/api/jobs/resolve", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({ companyId: suggestion.companyId, externalCrmId: suggestion.externalCrmId,
          sourceId: suggestion.sourceId, crmOrganizationId: suggestion.crmOrganizationId,
          dataCenter: suggestion.dataCenter, environment: suggestion.environment,
          booksOrganizationId: suggestion.booksOrganizationId }),
      });
      if (!mounted.current || controller.signal.aborted || selectionVersion.current !== version) return;
      if (!job?.id || job.companyId !== suggestion.companyId || job.externalCrmId !== suggestion.externalCrmId)
        throw new Error("The selected CRM job could not be verified. Search again before continuing.");
      router.push(`/jobs/${encodeURIComponent(job.id)}`);
    } catch (cause) {
      if (!mounted.current || controller.signal.aborted || selectionVersion.current !== version) return;
      setSelection({ key: scopeKey, suggestion, pending: false, error: errorMessage(cause) });
    }
  }

  if (!canEnter) return <Notice>Manual bill entry is available to authorized finance and data entry staff.</Notice>;

  return <>
    <PageHeader eyebrow="MANUAL ENTRY" title="Manual bill entry"
      description="Find a job by its ID, name or an existing bill number. Review its bill history and attachments, then add your invoice." />
    <Card className="manual-job-search-card">
      <form className="manual-job-search" onSubmit={(event) => {
        event.preventDefault();
        const next = query.trim();
        if (next.length < 2) return;
        cancelSelection();
        if (next === submittedQuery) { matches.reload(); crm.reload(); }
        else setSubmittedQuery(next);
      }}>
        <Field label="Job ID, bill number or job name" htmlFor="manual-job-query" required hint="Enter at least 2 characters, for example 5383, JOB-5383, an invoice number or a project name.">
          <Input id="manual-job-query" value={query} onChange={(event) => { cancelSelection(); setQuery(event.target.value); }}
            required minLength={2} maxLength={100} autoComplete="off" placeholder="Search a job or existing bill" />
        </Field>
        <Button type="submit" disabled={query.trim().length < 2 || companies.loading || !!companies.error || !visibleCompanies.length || matches.loading}>
          <Search size={17} />Search
        </Button>
      </form>
      <p className="manual-job-search-note">Search saved jobs and bills across your authorized companies. Choose the exact job and company to review its history; an unlinked bill cannot select a job.</p>
      {manualEntryOnly && user.role === "ADMIN" && <Link className="text-link" href="/jobs">Add or manage jobs</Link>}
    </Card>
    {companies.error && <Notice tone="error">
      <p>{companies.error}</p>
      <Button type="button" variant="secondary" onClick={companies.reload}>Retry companies</Button>
    </Notice>}
    {!companies.loading && companies.data && !visibleCompanies.length && <Notice>No active companies are available for this account.</Notice>}
    {!hideEmptySavedResults && <Card className="manual-job-results">
      {!searchReady ? <EmptyState title="Find the job before adding a bill"
        description="Search its ID, name or an existing bill number. Choose a matching job to review bills with verified links and their original files." />
        : matches.loading ? <LoadingPanel />
          : matchesError ? <div className="manual-job-search-error"><Notice tone="error">
            <p>{matchesError}</p>
            <Button type="button" variant="secondary" onClick={matches.reload}>Retry job search</Button>
          </Notice></div>
            : jobs.length || bills.length ? <>
              {jobs.length > 0 && <Table>
              <caption className="sr-only">{jobs.some(job => job.referenceKind === "CRM_DEAL") ? "Matching jobs and CRM deals" : "Matching jobs"}</caption>
              <thead><tr><th>Reference</th><th>Name</th><th>Company</th><th>Customer</th><th><span className="sr-only">Open history</span></th></tr></thead>
              <tbody>{jobs.map((job) => <tr key={job.id}>
                <td><strong>{historyReference(job)}</strong><span className="table-secondary">{job.referenceKind === "CRM_DEAL" ? "CRM deal · Read only" : "Job ID"}</span></td>
                <td>{job.name}</td>
                <td>{job.companyId ? companyNames.get(job.companyId) : job.companyName}
                  {job.referenceKind === "CRM_DEAL" && !!job.historyCompanies?.length && <span className="table-secondary">Bill history: {job.historyCompanies.map(company => company.name).join(", ")}</span>}
                </td>
                <td>{job.customer}</td>
                <td><Button asChild variant="secondary" size="sm"><Link href={job.href}
                  aria-label={`${job.referenceKind === "CRM_DEAL" ? "View CRM deal history" : job.canonicalJobId ? "View job history" : "Review job"} ${historyReference(job)} for ${job.companyId ? companyNames.get(job.companyId) : job.companyName}`}>
                  {job.referenceKind === "CRM_DEAL" ? "View CRM deal history" : job.canonicalJobId ? "View job history" : "Review job"}<ArrowRight size={15} />
                </Link></Button></td>
              </tr>)}</tbody>
            </Table>}
              {bills.length > 0 && <section className={searchStyles.group} aria-label="Matching bills">
                <h3>Matching bills</h3>
                {bills.map(bill => {
                  const relatedJobs = bill.relatedJobs?.length ? bill.relatedJobs : bill.jobId ? [{ id: bill.jobId,
                    jobNumber: bill.jobNumber || bill.jobId, companyId: bill.companyId, companyName: bill.companyName,
                    canonicalJobId: bill.jobId, href: `/jobs/${encodeURIComponent(bill.jobId)}` }] : [];
                  return <article key={`${bill.source}:${bill.id}`} className={searchStyles.row} style={{ flexWrap: "wrap" }}>
                    <div className={searchStyles.identity}><strong>{bill.billNumber}</strong><span>{bill.vendorName}</span>
                      <small>{companyNames.get(bill.companyId)} · {bill.source === "BOOKS" ? "Zoho Books" : "Workspace bill"}</small>
                      {!relatedJobs.length && <small>No verified job link</small>}
                      {relatedJobs.some(job => job.canonicalJobId === null) && <small>Verified CRM deal history · Read only</small>}
                      {relatedJobs.length > 1 && <small>Related to multiple {relatedJobs.some(job => job.canonicalJobId === null) ? "source records" : "jobs"}. Choose the history to review.</small>}
                    </div>
                    <strong className={searchStyles.amount}>{money(bill.total, bill.currency)}</strong>
                    <div className={searchStyles.actions}>
                      <Button asChild variant="secondary" size="sm"><Link href={bill.href}
                        aria-label={`View bill ${bill.billNumber} for ${companyNames.get(bill.companyId)}`}>View bill</Link></Button>
                      {relatedJobs.map(job => <Button key={job.id} asChild variant="secondary" size="sm">
                        <Link href={historyHref(job)!}
                          aria-label={`View ${job.canonicalJobId === null ? "CRM deal" : "job"} history ${historyReference(job)} for bill ${bill.billNumber} in ${companyNames.get(job.companyId)}`}>
                          {job.canonicalJobId === null ? `CRM deal ${historyReference(job)} history` : relatedJobs.length > 1 ? `Job ${historyReference(job)} history` : "View job history"}<ArrowRight size={15} />
                        </Link>
                      </Button>)}
                    </div>
                  </article>;
                })}
              </section>}
              {matches.data?.hasMore && <p className="manual-job-search-note">More matches are available. Enter a more specific job reference, bill number or name.</p>}
            </> : <EmptyState title="No saved matching job or bill"
                description={manualEntryOnly ? "Check the reference or name, or ask an administrator to add the job." : "Check the reference or name. You can also review the Zoho CRM results below."} />}
    </Card>}
    {!manualEntryOnly && <Card className="manual-crm-results" role="region" aria-label="Zoho CRM job search">
      <div className="panel-heading">
        <div><h2>Zoho CRM matches</h2><p>Choose a CRM job to review its amounts and bills.</p></div>
        {user.role === "ADMIN" && <Button asChild variant="secondary" size="sm"><Link href="/account/crm-authorization">Connect Zoho CRM</Link></Button>}
      </div>
      {!searchReady ? <p className="manual-crm-message">Enter a job reference and select Search to search Zoho CRM.</p>
          : !crmSearchReady ? <p className="manual-crm-message">Enter at least 2 characters to search Zoho CRM.</p>
          : crm.loading ? <div className="manual-crm-message" role="status"><LoaderCircle size={17} className="spin" />Searching Zoho CRM jobs…</div>
            : <>
              {(crmError || crm.data?.warning) && <div className="manual-job-search-error"><Notice tone={crmError ? "error" : "info"}>
                <p>{crmError || crm.data?.warning}</p>
                <Button type="button" variant="secondary" onClick={retryCrmSearch}>Retry CRM search</Button>
                {user.role !== "ADMIN" && <p>Ask an administrator to connect Zoho CRM.</p>}
              </Notice></div>}
              {currentSelection?.pending && <p className="manual-crm-message" role="status"><LoaderCircle size={17} className="spin" />Selecting CRM job…</p>}
              {currentSelection?.error && <div className="manual-job-search-error"><Notice tone="error">
                <p>{currentSelection.error}</p>
                <Button type="button" variant="secondary" onClick={() => void selectCrmJob(currentSelection.suggestion)}>Retry CRM selection</Button>
              </Notice></div>}
              {crmJobs.length ? <Table>
                <caption className="sr-only">Zoho CRM matches</caption>
                <thead><tr><th>Job ID</th><th>Job name</th><th>Company</th><th>Customer</th><th>CRM stage</th><th>Contract value</th><th><span className="sr-only">Use job</span></th></tr></thead>
                <tbody>{crmJobs.map((job) => <tr key={`${job.companyId}:${job.sourceId}:${job.externalCrmId}`}>
                  <td><strong>{job.jobNumber}</strong></td><td>{job.name}</td><td>{companyNames.get(job.companyId)}</td><td>{job.customer}</td>
                  <td>{job.stage || "Not provided"}</td><td>{money(job.contractValue, job.currency)}</td>
                  <td><Button type="button" variant="secondary" size="sm" disabled={!!currentSelection?.pending}
                    aria-label={`Use CRM job ${job.jobNumber} for ${companyNames.get(job.companyId)}`}
                    onClick={() => void selectCrmJob(job)}>Use CRM job<ArrowRight size={15} /></Button></td>
                </tr>)}</tbody>
              </Table> : !crmError && !crm.data?.warning ? <EmptyState title="No matching CRM job"
                description="Try the exact job ID or a different reference." /> : null}
              {crm.data?.hasMore && !crmError && <p className="manual-crm-message">Refine the job reference to narrow the CRM results.</p>}
              {crmJobs.length > 0 && <p className="manual-crm-message">CRM stage comes from Zoho. Job expenses and bill statuses are calculated here.</p>}
            </>}
    </Card>}
  </>;
}
