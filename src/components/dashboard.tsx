"use client";
import Link from "next/link";
import { useState } from "react";
import Decimal from "decimal.js";
import {
  ArrowRight,
  ArrowUpRight,
  BriefcaseBusiness,
  Wallet,
  CircleDollarSign,
  TrendingUp,
  Plus,
  PenLine,
  ScanLine,
  Layers3,
  ShieldCheck,
  AlertTriangle,
  ChevronRight,
  CalendarDays,
  Clock3,
  FileCheck2,
} from "lucide-react";
import { useApi, money, number, dateTime } from "./api";
import type { Dashboard } from "./types";
import { useManualEntryOnly, useOcrWorkspaceEnabled, useUser } from "./app-shell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Notice,
  PageHeader,
  Select,
  Skeleton,
} from "./ui";
import { BillTable, JobTable, Metric } from "./records";
import { ExpenseReport, OperationAttention } from "./expense-report";
import { CompanySelect } from "./company-select";
import { DashboardSearch } from "./dashboard-search";
import { ImportedBillsTable } from "./imported-bills-table";
import { accountDisplayName } from "./account-display-name";
import { IncomingSyncStatusPanel } from "./incoming-sync-status";
import styles from "./dashboard-overview.module.css";

export function DashboardPage({
  management = false,
}: {
  management?: boolean;
}) {
  const user = useUser();
  const manualEntryOnly = useManualEntryOnly();
  const ocrWorkspaceEnabled = useOcrWorkspaceEnabled();
  const [currency, setCurrency] = useState("AED");
  const [companyId, setCompanyId] = useState("");
  const [job, setJob] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(management);
  const params = new URLSearchParams({ currency });
  if (companyId) params.set("companyId", companyId);
  if (job) params.set("jobId", job);
  const state = useApi<Dashboard>(`/api/dashboard?${params}`);
  const canCreate = user.role !== "MANAGEMENT";
  const d = state.data;
  const m = d?.metrics;
  const jobPreview = d?.jobs.slice(0, 10) ?? [];
  const ownScope = user.role === "DATA_ENTRY";
  const profit = d?.source?.jobFinancialsComplete === false ? null : m?.estimatedProfit;
  const count = (value: number | undefined) => value === undefined ? "—" : number(value);
  const currencies = [...new Set([currency, ...(d?.currencies ?? ["AED", "USD", "EUR", "GBP", "SAR"])])];
  return (
    <>
      <PageHeader
        eyebrow={
          management ? "BUSINESS INTELLIGENCE" : "YOUR FINANCIAL WORKSPACE"
        }
        title={management ? "Management overview" : "Finance overview"}
        description={
          ownScope
            ? "Your recorded bills, synchronization progress, and finalized expenses. Company job values are restricted."
            : management
              ? "A clear view of job performance, costs, and outstanding commitments."
              : `Welcome back, ${accountDisplayName(user.name).split(" ")[0] || "there"}. Here’s where your finances stand.`
        }
      >
        <Button
          variant="secondary"
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          <CalendarDays size={16} />
          Filters
        </Button>
        {canCreate && (
          <Button asChild>
            <Link href="/bills/new">
              <Plus size={17} />
              Create bill
            </Link>
          </Button>
        )}
      </PageHeader>
      <DashboardSearch companyId={companyId} />
      {filtersOpen && (
        <Card className="filter-panel dashboard-filters">
          <CompanySelect
            id="dash-company"
            required={false}
            value={companyId}
            onChange={(value) => {
              setCompanyId(value);
              setJob("");
            }}
          />
          <Field label="Currency" htmlFor="dash-currency">
            <Select
              id="dash-currency"
              value={currency}
              onChange={(e) => { setCurrency(e.target.value); setJob(""); }}
            >
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label="Job" htmlFor="dash-job">
            <Select
              id="dash-job"
              value={job}
              disabled={state.loading || !!state.error || !d?.jobOptions}
              onChange={(e) => setJob(e.target.value)}
            >
              <option value="">All jobs</option>
              {d?.jobOptions
                ?.filter((j) => !companyId || j.companyId === companyId)
                .map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.jobNumber} · {j.name}
                  </option>
                ))}
            </Select>
          </Field>
          <p className="filter-footnote">
            Lifetime values in {currency}; currencies are never combined.{" "}
            <Link href="/bills" className="text-link">
              Filter individual bills by date, vendor, or category →
            </Link>
          </p>
        </Card>
      )}
      {!ownScope && !manualEntryOnly && <IncomingSyncStatusPanel companyId={companyId} onUpdated={state.reload} />}
      {state.error ? (
        <ErrorState message={state.error} retry={state.reload} />
      ) : (
        <>
          {d?.source && !ownScope && <Card className={styles.source} aria-label="Financial data sources">
            <div className={styles.sourceHeading}>
              <h2>Recorded financial data · {currency}</h2>
              <Link href="/bills/books" className="text-link">View Zoho Books history <ArrowRight size={14} /></Link>
            </div>
            <p>{number(d.source.booksBillCount)} Zoho Books bills and {number(d.source.nativeBillCount)} workspace bills in this view.
              {d.source.excludedDuplicateNativeCount > 0 && ` ${number(d.source.excludedDuplicateNativeCount)} linked workspace ${d.source.excludedDuplicateNativeCount === 1 ? "bill is" : "bills are"} already counted in Books and excluded from duplicate totals.`}
            </p>
            {d.source.crmJobCount !== undefined && <p>{number(d.source.crmJobCount)} imported CRM records with a job reference in the selected companies.
              {d.source.crmReviewJobCount !== undefined && d.source.crmReviewJobCount > 0 && ` ${number(d.source.crmReviewJobCount)} ${d.source.crmReviewJobCount === 1 ? "record requires review and is" : "records require review and are"} excluded from the contract total.`}
            </p>}
            <p>{d.source.booksLatestImportAt ? `Latest Books import: ${dateTime(d.source.booksLatestImportAt)} Dubai.` : "No Books import time is available."}
              {" "}{d.source.booksListingComplete ? "The imported bill listing is complete." : "The Books bill listing is incomplete; totals may not cover all invoices."}
            </p>
            {d.source.notes.length > 0 && <ul>{d.source.notes.map(note => <li key={note}>{note}</li>)}</ul>}
          </Card>}
          <div className={`metrics-grid ${styles.metrics}`}>
            {state.loading || !m ? (
              [1, 2, 3, 4, 5, 6].map((i) => (
                <Card className="metric-card" key={i}>
                  <Skeleton className="skeleton-label" />
                  <Skeleton className="skeleton-value" />
                  <Skeleton className="skeleton-note" />
                </Card>
              ))
            ) : (
              <>
                <Metric
                  label={
                    ownScope
                      ? "Job value · restricted"
                      : "Recorded contract value"
                  }
                  value={money(m.recordedContractValue, currency)}
                  note={
                    ownScope
                      ? "Not available for your role"
                      : "Verified source contract amounts"
                  }
                  icon={<BriefcaseBusiness size={19} />}
                />
                <Metric label="Recorded invoice total" value={money(m.invoicedTotal, currency)}
                  note="Recognized bills · including VAT"
                  icon={<FileCheck2 size={19} />} />
                <Metric
                  label={
                    ownScope
                      ? "Your recognized expenses"
                      : "Recognized expenses"
                  }
                  value={money(m.recognizedExpenses, currency)}
                  note={m.recognizedExpenses === null ? "Complete expense details are unavailable" : "Recorded finalized costs · excluding VAT"}
                  icon={<Wallet size={19} />}
                />
                <Metric label={ownScope ? "Your recorded payments" : "Recorded payments"} value={money(m.paidExpenses, currency)}
                  note={m.paidExpenses === null ? "Complete payment details are unavailable" : "Source payments · including VAT"}
                  icon={<CircleDollarSign size={19} />} />
                <Metric
                  label={
                    ownScope ? "Your outstanding bills" : "Outstanding bills"
                  }
                  value={money(m.outstanding, currency)}
                  note={m.outstanding === null ? "Complete balances are unavailable" : "Recorded balances · including VAT"}
                  icon={<CircleDollarSign size={19} />}
                />
                <Metric
                  label="Estimated job profit"
                  value={money(profit, currency)}
                  note={
                    ownScope
                      ? "Not available for your role"
                      : profit === null || profit === undefined
                        ? d?.source?.jobFinancialsComplete === false ? "Historical job costs are incomplete" : "Requires complete job values and costs"
                        : "Provisional · before other costs"
                  }
                  icon={<TrendingUp size={19} />}
                  accent
                  negative={profit !== null && profit !== undefined && Number(profit) < 0}
                />
              </>
            )}
          </div>
          {!ownScope && d?.recentBooksBills && d.recentBooksBills.length > 0 && <Card className={styles.history}>
            <div className="panel-heading"><div><h2>Recent Zoho Books bills</h2><p>Imported invoices from the selected companies and currency</p></div>
              <Link href="/bills/books" className="text-link">View all Books bills <ArrowRight size={15} /></Link></div>
            <ImportedBillsTable bills={d.recentBooksBills} />
          </Card>}
          {!state.loading && !ownScope && Boolean(m?.missingJobValues) && (
            <Notice>
              Job value not available for {m?.missingJobValues}{" "}
              {m?.missingJobValues === 1 ? "job" : "jobs"}. The job value total
              includes known values only; overall estimated profit is
              unavailable until all selected jobs have valid values.
            </Notice>
          )}
          {!management && canCreate && (
            <section className="entry-section">
              <div className="section-label">
                <h2>Start with a bill</h2>
                <span>Choose how you’d like to add it</span>
              </div>
              <div className="entry-grid">
                <Link
                  className="entry-card entry-card-primary"
                  href="/bills/manual"
                >
                  <div className="entry-icon">
                    <PenLine size={22} />
                  </div>
                  <div>
                    <h3>Manual entry</h3>
                    <p>
                      Add invoice details and allocate
                      <br className="desktop-break" /> expenses to the right
                      job.
                    </p>
                  </div>
                  <span className="entry-arrow">
                    <ArrowUpRight size={19} />
                  </span>
                  <span className="entry-card-tag">READY TO USE</span>
                </Link>
                {ocrWorkspaceEnabled && <><Link className="entry-card" href="/ocr">
                  <div className="entry-icon">
                    <ScanLine size={22} />
                  </div>
                  <div>
                    <h3>Single bill OCR</h3>
                    <p>
                      Extract details from an invoice
                      <br className="desktop-break" /> with a human review step.
                    </p>
                  </div>
                  <ArrowUpRight className="entry-arrow" size={19} />
                  <span className="entry-card-tag muted">SETUP REQUIRED</span>
                </Link>
                <Link className="entry-card" href="/ocr/batch">
                  <div className="entry-icon">
                    <Layers3 size={22} />
                  </div>
                  <div>
                    <h3>Batch processing</h3>
                    <p>
                      A single workspace for multiple
                      <br className="desktop-break" /> invoices and review.
                    </p>
                  </div>
                  <ArrowUpRight className="entry-arrow" size={19} />
                  <span className="entry-card-tag muted">SETUP REQUIRED</span>
                </Link></>}
              </div>
            </section>
          )}
          <div className="overview-main">
            <Card className="recent-bills">
              <div className="panel-heading">
                <div>
                  <h2>Recent workspace bills</h2>
                  <p>The latest invoices entered in this app</p>
                </div>
                <Link href="/bills" className="text-link">
                  View all <ArrowRight size={15} />
                </Link>
              </div>
              {state.loading ? (
                <div className="table-skeleton">
                  {[1, 2, 3, 4].map((i) => (
                    <Skeleton key={i} className="skeleton-row" />
                  ))}
                </div>
              ) : (
                <BillTable bills={d?.recentBills ?? []} compact />
              )}
            </Card>
            <Card className="attention-card">
              <div className="panel-heading">
                <div>
                  <h2>Needs attention</h2>
                  <p>Keep your finances moving</p>
                </div>
                <span className="soft-icon">
                  <Clock3 size={19} />
                </span>
              </div>
              <div className="attention-items">
                <Link
                  href="/bills?status=READY"
                  className="attention-row"
                >
                  <span className="attention-icon amber">
                    <FileCheck2 size={18} />
                  </span>
                  <div>
                    <strong>{manualEntryOnly ? "Saved bills" : "Ready to sync"}</strong>
                    <span>{manualEntryOnly ? "Review finalized invoice details" : "Review Books synchronization status"}</span>
                  </div>
                  <b>{state.loading ? "—" : count(m?.readyCount)}</b>
                  <ChevronRight size={15} />
                </Link>
                <Link href="/bills?status=DRAFT" className="attention-row">
                  <span className="attention-icon blue">
                    <PenLine size={18} />
                  </span>
                  <div>
                    <strong>Draft bills</strong>
                    <span>{manualEntryOnly ? "Finish details, then save the bill" : "Finish details, then Save and sync"}</span>
                  </div>
                  <b>{state.loading ? "—" : count(m?.draftCount)}</b>
                  <ChevronRight size={15} />
                </Link>
                <Link href="/jobs?budget=OVER_BUDGET" className="attention-row">
                  <span className="attention-icon red">
                    <AlertTriangle size={18} />
                  </span>
                  <div>
                    <strong>Jobs over budget</strong>
                    <span>Review recorded costs</span>
                  </div>
                  <b>{state.loading || d?.source?.jobFinancialsComplete === false ? "—" : count(m?.overBudgetCount)}</b>
                  <ChevronRight size={15} />
                </Link>
              </div>
              <div className="attention-note">
                <ShieldCheck size={17} />
                <span>Financial changes are recorded in your audit trail.</span>
              </div>
            </Card>
          </div>
          {!manualEntryOnly && <OperationAttention />}
          <Card className="job-overview">
            <div className="panel-heading">
              <div>
                <h2>
                  {ownScope
                    ? "Your job expense overview"
                    : "Job budget overview"}
                </h2>
                <p>
                  {ownScope
                    ? "Finalized expenses from your recorded bills"
                    : "Recognized expenses against adjusted job value"}
                </p>
                {!state.loading && d && (
                  <p>Showing {number(jobPreview.length)} of {number(d.jobs.length)} jobs</p>
                )}
              </div>
              <Link href="/jobs" className="text-link">
                All jobs <ArrowRight size={15} />
              </Link>
            </div>
            {state.loading ? (
              <div className="table-skeleton">
                <Skeleton className="skeleton-row" />
                <Skeleton className="skeleton-row" />
              </div>
            ) : (
              <JobTable jobs={jobPreview} />
            )}
          </Card>
          {management && (
            <>
              <Card className="form-card">
                <div className="panel-heading compact">
                  <h2>Budget watch</h2>
                  {d?.source?.jobFinancialsComplete !== false && <Badge tone="warning">
                    {d?.jobs.filter((j) => j.budgetStatus === "NEAR_LIMIT")
                      .length ?? "—"}{" "}
                    near limit
                  </Badge>}
                </div>
                {d?.source?.jobFinancialsComplete === false ? <EmptyState title="Budget review unavailable"
                  description="Historical job costs must be complete before jobs can be classified against their budgets." /> : <JobTable
                  jobs={(d?.jobs ?? []).filter((j) =>
                    ["NEAR_LIMIT", "OVER_BUDGET"].includes(
                      j.budgetStatus ?? "",
                    ),
                  )}
                />}
              </Card>
              {d?.source && d.source.booksBillCount > 0 && <Notice>
                The expense report below covers workspace bills. Imported Books invoices remain available in Books history; the overview totals above include both sources.
              </Notice>}
              <ExpenseReport
                currency={currency}
                jobId={job}
                companyId={companyId}
              />
              <Card className="form-card">
                <div className="panel-heading compact">
                  <div>
                    <h2>Highest expense jobs</h2>
                    <p>Top five by lifetime recognized costs, excluding VAT.</p>
                  </div>
                </div>
                <JobTable
                  jobs={[...(d?.jobs ?? [])].filter(item => item.recognizedExpenses !== null && item.recognizedExpenses !== undefined)
                    .sort((a, b) =>
                      new Decimal(String(b.recognizedExpenses ?? 0)).comparedTo(
                        String(a.recognizedExpenses ?? 0),
                      ),
                    )
                    .slice(0, 5)}
                />
              </Card>
            </>
          )}
          {management && !state.loading && d && (
            <div className="two-column">
              <Card>
                <div className="panel-heading">
                  <div>
                    <h2>Monthly expense trend</h2>
                    <p>Finalized expenses, excluding VAT · {currency}</p>
                  </div>
                </div>
                <ExpenseBars
                  unavailable={Boolean(d.source?.unknownFinancialBillCount)}
                  values={d.monthlyExpenses.map((row) => ({
                    label: row.month,
                    amount: row.amount ?? row.total ?? row.expenses ?? null,
                  })).filter((row): row is { label: string; amount: string | number } => row.amount !== null)}
                  currency={currency}
                />
              </Card>
              <Card>
                <div className="panel-heading">
                  <div>
                    <h2>Vendor expenses</h2>
                    <p>Recorded finalized costs by supplier</p>
                  </div>
                </div>
                <ExpenseBars
                  unavailable={Boolean(d.source?.unknownFinancialBillCount)}
                  values={d.vendorExpenses.map((row) => ({
                    label: row.name ?? row.vendorName ?? "Vendor",
                    amount: row.amount ?? row.total ?? row.expenses ?? null,
                  })).filter((row): row is { label: string; amount: string | number } => row.amount !== null)}
                  currency={currency}
                />
              </Card>
              <Card className="management-footnote">
                <Badge tone="info">Provisional figures</Badge>
                <p>
                  Estimated profit uses adjusted job value less recognized
                  expenses. It excludes unrecorded costs and does not represent
                  final accounting profit. Paid and outstanding amounts include
                  VAT.
                </p>
                <strong>
                  Total paid expenses: {money(m?.paidExpenses, currency)}
                </strong>
              </Card>
            </div>
          )}
        </>
      )}
    </>
  );
}
function ExpenseBars({
  values,
  currency,
  unavailable = false,
}: {
  values: { label: string; amount: string | number }[];
  currency: string;
  unavailable?: boolean;
}) {
  const max = Math.max(...values.map((v) => Number(v.amount)), 1);
  if (!values.length)
    return (
      <EmptyState
        title={unavailable ? "Expense breakdown unavailable" : "No recorded expenses in this view"}
        description={unavailable ? "Complete source expense details are required for this breakdown." : "Change the company or currency filter to view other recorded costs."}
      />
    );
  return (
    <div className="expense-bars">
      {values.map((value, index) => (
        <div className="expense-bar-row" key={`${value.label}-${index}`}>
          <div>
            <span>{value.label}</span>
            <strong>{money(value.amount, currency)}</strong>
          </div>
          <div className="expense-bar-track">
            <span
              style={{
                width: `${Math.max((Number(value.amount) / max) * 100, 0)}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
