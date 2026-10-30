"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  BriefcaseBusiness,
  LoaderCircle,
  Plus,
  Search,
  TrendingUp,
  Wallet,
  CircleDollarSign,
  RefreshCw,
} from "lucide-react";
import { api, dateTime, errorMessage, money, summary, useApi } from "./api";
import type { Bill, ImportedBillSummary, Job, JobBooksHistory, JobFinancialCompleteness } from "./types";
import { useUser } from "./app-shell";
import {
  Badge,
  Button,
  Card,
  ErrorState,
  EmptyState,
  Field,
  Input,
  LoadingPanel,
  Notice,
  PageHeader,
  Select,
  StatusBadge,
} from "./ui";
import { BillTable, JobTable, Metric } from "./records";
import { CompanySelect } from "./company-select";
import { ImportedBillsTable } from "./imported-bills-table";
import styles from "./dashboard-overview.module.css";

export function JobsPage() {
  const user = useUser();
  const search = useSearchParams();
  const [q, setQ] = useState("");
  const [budget, setBudget] = useState(search.get("budget") ?? "");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const state = useApi<{ jobs: Job[] }>(`/api/jobs?q=${encodeURIComponent(q)}`);
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          companyId: form.get("companyId"),
          jobNumber: form.get("jobNumber"),
          name: form.get("name"),
          customer: form.get("customer"),
          contractValue: form.get("contractValue") || null,
          approvedVariations: form.get("approvedVariations") || "0",
          currency: form.get("currency"),
        }),
      });
      setAdding(false);
      setSuccess("Job created. You can now allocate bills to it.");
      state.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="PROJECT FINANCIALS"
        title="Jobs & projects"
        description="Follow each job from its contract value to its recorded expenses."
      >
        {user.role === "ADMIN" && (
          <Button onClick={() => setAdding(!adding)}>
            <Plus size={17} />
            {adding ? "Close form" : "Add job"}
          </Button>
        )}
      </PageHeader>
      {success && (
        <Notice tone="success" onClose={() => setSuccess("")}>
          {success}
        </Notice>
      )}
      {error && (
        <Notice tone="error" onClose={() => setError("")}>
          {error}
        </Notice>
      )}
      {adding && user.role === "ADMIN" && (
        <Card className="form-card inline-create">
          <div className="panel-heading compact">
            <h2>Add a job</h2>
            <Badge>Administrator</Badge>
          </div>
          <form onSubmit={create}>
            <div className="form-grid three-columns">
              <CompanySelect id="new-job-company" />
              <Field label="Job number" htmlFor="new-job-number" required>
                <Input
                  id="new-job-number"
                  name="jobNumber"
                  required
                  maxLength={80}
                  placeholder="e.g. VX-2026-001"
                />
              </Field>
              <Field label="Job name" htmlFor="new-job-name" required>
                <Input
                  id="new-job-name"
                  name="name"
                  required
                  maxLength={200}
                  placeholder="Project name"
                />
              </Field>
              <Field label="Customer" htmlFor="new-job-customer" required>
                <Input
                  id="new-job-customer"
                  name="customer"
                  required
                  maxLength={200}
                />
              </Field>
              <Field
                label="Contract value"
                htmlFor="new-job-value"
                hint="Leave blank if not yet known"
              >
                <Input
                  id="new-job-value"
                  name="contractValue"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                />
              </Field>
              <Field label="Approved variations" htmlFor="new-job-variations">
                <Input
                  id="new-job-variations"
                  name="approvedVariations"
                  type="number"
                  step="0.01"
                  defaultValue="0"
                  required
                />
              </Field>
              <Field label="Currency" htmlFor="new-job-currency">
                <Select
                  id="new-job-currency"
                  name="currency"
                  defaultValue="AED"
                >
                  {["AED", "USD", "EUR", "GBP", "SAR"].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="form-footer">
              <p>
                Use the actual business job reference. These records are local
                until an integration is configured.
              </p>
              <Button disabled={busy} type="submit">
                {busy && <LoaderCircle className="spin" size={16} />}Create job
              </Button>
            </div>
          </form>
        </Card>
      )}
      <Card>
        <div className="list-toolbar">
          <div className="search-input">
            <Search size={17} />
            <Input
              aria-label="Search jobs"
              placeholder="Search job number, name, or customer…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <Select
            aria-label="Budget status"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          >
            <option value="">All budget statuses</option>
            <option value="WITHIN_BUDGET">Within budget</option>
            <option value="NEAR_LIMIT">Near budget limit</option>
            <option value="OVER_BUDGET">Over budget</option>
            <option value="VALUE_UNAVAILABLE">Value unavailable</option>
          </Select>
        </div>
        {state.error ? (
          <ErrorState message={state.error} retry={state.reload} />
        ) : state.loading ? (
          <LoadingPanel />
        ) : (
          <JobTable
            jobs={(state.data?.jobs ?? []).filter(
              (j) => !budget || summary(j).budgetStatus === budget,
            )}
          />
        )}
      </Card>
      <p className="page-footnote">
        Estimated job profit is provisional. Recognized expenses include
        finalized bills net of VAT; drafts and cancellations are excluded.
      </p>
    </>
  );
}
export function JobDetail({ id }: { id: string }) {
  const state = useApi<{ job: Job; bills: Bill[]; booksBills?: ImportedBillSummary[]; booksHistory?: JobBooksHistory; financialCompleteness?: JobFinancialCompleteness }>(`/api/jobs/${encodeURIComponent(id)}`, { keepPreviousData: true });
  const user = useUser();
  const refreshControl = useRef({ busy: true, blocked: false });
  useEffect(() => {
    refreshControl.current = { busy: state.loading || state.refreshing, blocked: !!state.error };
  }, [state.loading, state.refreshing, state.error]);
  const reload = state.reload;
  const refreshJob = useCallback(() => {
    if (refreshControl.current.busy) return;
    refreshControl.current.busy = true;
    reload();
  }, [reload]);
  useEffect(() => {
    const refreshVisibleJob = () => {
      if (document.visibilityState === "visible" && !refreshControl.current.blocked) refreshJob();
    };
    const interval = setInterval(refreshVisibleJob, 15_000);
    window.addEventListener("focus", refreshVisibleJob);
    window.addEventListener("pageshow", refreshVisibleJob);
    document.addEventListener("visibilitychange", refreshVisibleJob);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", refreshVisibleJob);
      window.removeEventListener("pageshow", refreshVisibleJob);
      document.removeEventListener("visibilitychange", refreshVisibleJob);
    };
  }, [id, refreshJob]);
  if (state.loading) return <LoadingPanel />;
  if (state.error || !state.data)
    return (
      <ErrorState
        message={state.error ?? "Job unavailable"}
        retry={refreshJob}
      />
    );
  const { job, bills, booksBills, booksHistory, financialCompleteness } = state.data;
  const historyPending = !!(booksHistory?.verificationPending || booksHistory?.refreshPausedUntil);
  const incomplete = financialCompleteness?.complete === false;
  const s = { ...summary(job), ...(incomplete ? { estimatedProfit: null, remainingBudget: null, expensePercentage: null, budgetStatus: "VALUE_UNAVAILABLE" } : {}) };
  return (
    <>
      <Link href="/jobs" className="back-link">
        <ArrowLeft size={15} />
        Back to jobs
      </Link>
      <PageHeader
        eyebrow={job.jobNumber}
        title={job.name}
        description={`${job.customer} · ${job.currency}`}
      >
        {job.stage && <Badge>{job.stage}</Badge>}
        <StatusBadge status={s.budgetStatus} />
        <Button type="button" variant="secondary" disabled={state.refreshing} onClick={refreshJob}>
          <RefreshCw size={16} className={state.refreshing ? "spin" : undefined} />Refresh job
        </Button>
        {user.role !== "MANAGEMENT" && (
          <Button asChild>
            <Link href={`/bills/new?jobId=${encodeURIComponent(id)}`}>
              <Plus size={16} />
              Add bill
            </Link>
          </Button>
        )}
      </PageHeader>
      <div className={styles.profileSource}>
        <span>Company: <strong>{job.companyName || job.companyId}</strong></span>
        {job.externalCrmId && <span>CRM job: <strong>{job.externalCrmId}</strong></span>}
        {job.sourceUpdatedAt && <span>CRM source updated: <strong>{dateTime(job.sourceUpdatedAt)} Dubai</strong></span>}
      </div>
      <p className="job-refresh-status" role="status">
        {state.refreshing ? "Refreshing job totals and bills…" : "Job totals and bills update automatically while this page is visible."}
      </p>
      {state.refreshError && <Notice tone="error">
        <p>Job totals could not be refreshed. Displayed amounts may be out of date. {state.refreshError}</p>
        <Button type="button" variant="secondary" disabled={state.refreshing} onClick={refreshJob}>Retry job refresh</Button>
      </Notice>}
      {incomplete && <Notice>
        <strong>Historical job costs are incomplete</strong>
        <p>Profit and budget usage remain unavailable until the imported invoice history can be assigned reliably.</p>
        {financialCompleteness.notes.map(note => <p key={note}>{note}</p>)}
        <Link className="text-link" href={`/bills/books?companyId=${encodeURIComponent(job.companyId)}`}>Review this company&apos;s Books bills</Link>
      </Notice>}
      {s.budgetStatus === "OVER_BUDGET" && (
        <Notice tone="error">
          Over budget: recognized expenses exceed the adjusted job value.
          Estimated loss:{" "}
          {money(
            s.estimatedProfit === null ? null : String(s.estimatedProfit).replace(/^-/, ""),
            job.currency,
          )}
          .
        </Notice>
      )}
      {s.adjustedValue === null && (
        <Notice>
          Job value not available. Profit and budget percentages are not
          calculated.
        </Notice>
      )}
      <div className="metrics-grid">
        <Metric
          label="Recorded contract value"
          value={money(job.contractValue, job.currency)}
          note="Source contract amount"
          icon={<BriefcaseBusiness size={18} />}
        />
        <Metric
          label="Recognized expenses"
          value={money(s.recognizedExpenses, job.currency)}
          note={s.recognizedExpenses === null ? "Complete job costs are unavailable" : "Verified finalized costs · excluding VAT"}
          icon={<Wallet size={18} />}
        />
        <Metric
          label="Outstanding bills"
          value={money(s.outstanding, job.currency)}
          note={s.outstanding === null ? "Complete job balances are unavailable" : "Including VAT"}
          icon={<CircleDollarSign size={18} />}
        />
        <Metric
          label="Estimated profit / loss"
          value={money(s.estimatedProfit, job.currency)}
          note={incomplete ? "Historical job costs are incomplete" : "Provisional · before other costs"}
          icon={<TrendingUp size={18} />}
          accent
          negative={Number(s.estimatedProfit) < 0}
        />
      </div>
      <Card className="job-detail-summary">
        <div>
          <span>Adjusted job value</span>
          <strong>{money(s.adjustedValue, job.currency)}</strong>
        </div>
        <div>
          <span>Approved variations</span>
          <strong>{money(job.approvedVariations, job.currency)}</strong>
        </div>
        <div>
          <span>Paid expenses · gross</span>
          <strong>{money(s.paidExpenses, job.currency)}</strong>
        </div>
        <div>
          <span>Remaining budget</span>
          <strong>{money(s.remainingBudget, job.currency)}</strong>
        </div>
        <div>
          <span>Expense percentage</span>
          <strong>
            {s.expensePercentage === null
              ? "—"
              : `${Number(s.expensePercentage).toFixed(1)}%`}
          </strong>
        </div>
      </Card>
      {booksBills && <Card className={styles.history}>
        <div className="panel-heading"><div><h2>Linked Zoho Books bills</h2><p>Related invoices and their original files for this job and company. Amounts are full invoice totals; job cost allocation may be unverified.</p></div><Badge>{historyPending && !booksBills.length ? "Verification pending" : `${booksBills.length} bills`}</Badge></div>
        {historyPending && <Notice>
          <strong>{booksHistory?.verificationPending ? "Bill history needs verification" : "Books refresh is paused"}</strong>
          {booksHistory?.warnings.map((warning) => <p key={warning}>{warning}</p>)}
          {booksHistory?.refreshPausedUntil && <p>Zoho Books refresh is paused by its API quota. Next Books update retry after {dateTime(booksHistory.refreshPausedUntil)} Dubai. Missing job links still require source verification.</p>}
        </Notice>}
        {!booksBills.length && historyPending
          ? <EmptyState title="No verified related bills yet" description="A complete history is not available yet. This does not confirm that the job has no bills." />
          : <ImportedBillsTable bills={booksBills} showJob={false} showAttachments />}
      </Card>}
      <Card>
        <div className="panel-heading">
          <div>
            <h2>Linked workspace bills</h2>
            <p>Invoices entered in this app for {job.jobNumber}</p>
          </div>
          <Badge>{bills.length} bills</Badge>
        </div>
        <BillTable bills={bills} showJob={false} showAttachments />
      </Card>
      <p className="page-footnote">
        Recognized expenses include finalized invoices only. Paid and outstanding
        amounts include VAT. Estimated profit remains provisional until all
        relevant costs and revenue are recorded.
      </p>
    </>
  );
}
