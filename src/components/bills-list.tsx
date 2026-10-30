"use client";
import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Plus,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { useApi, billTotal } from "./api";
import type { Bill, Job, Vendor } from "./types";
import { useManualEntryOnly, useUser } from "./app-shell";
import {
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  LoadingPanel,
  PageHeader,
  Select,
} from "./ui";
import { BillTable } from "./records";
import { CompanySelect } from "./company-select";

export function BillsList({ approvals = false }: { approvals?: boolean }) {
  const user = useUser();
  const manualEntryOnly = useManualEntryOnly();
  const search = useSearchParams();
  const [q, setQ] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [status, setStatus] = useState(
    approvals ? "PENDING_APPROVAL" : (search.get("status") ?? ""),
  );
  const [paymentStatus, setPaymentStatus] = useState("");
  const [jobId, setJobId] = useState(search.get("jobId") ?? "");
  const [vendorId, setVendorId] = useState("");
  const [category, setCategory] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sort, setSort] = useState("date_desc");
  const [page, setPage] = useState(1);
  const [advanced, setAdvanced] = useState(false);
  const query = new URLSearchParams({ page: String(page), sort });
  for (const [key, value] of Object.entries({
    companyId,
    q,
    status,
    paymentStatus,
    jobId,
    vendorId,
    category,
    dateFrom,
    dateTo,
  }))
    if (value) query.set(key, value);
  const state = useApi<{
    bills: Bill[];
    total: number;
    page: number;
    pageSize: number;
  }>(`/api/bills?${query}`);
  const jobs = useApi<{ jobs: Job[] }>("/api/jobs");
  const vendors = useApi<{ vendors: Vendor[] }>("/api/vendors");
  function exportPage() {
    if (!state.data) return;
    const cell = (v: unknown) => {
      const text = String(v ?? "");
      return `"${(/^[\s]*[=+\-@\t\r]/.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`;
    };
    const rows: unknown[][] = [
      [
        "Invoice",
        "Vendor",
        "Job",
        "Date",
        "Category",
        "Bill status",
        "Payment",
        "Currency",
        "Total",
      ],
      ...state.data.bills.map((b) => [
        b.invoiceNumber,
        b.vendor?.name,
        b.job?.jobNumber,
        b.invoiceDate.slice(0, 10),
        b.category,
        b.status,
        b.paymentStatus,
        b.currency,
        billTotal(b),
      ]),
    ];
    const url = URL.createObjectURL(
      new Blob(
        ["\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\r\n")],
        { type: "text/csv;charset=utf-8;" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `voltronix-bills-page-${page}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <PageHeader
        eyebrow="BILL MANAGEMENT"
        title={approvals ? "Bills awaiting final save" : "Bills & expenses"}
        description={
          approvals
            ? `Open a previously submitted bill and choose ${manualEntryOnly ? "Save bill" : "Save and sync"}. No separate approval is required.`
            : user.role === "DATA_ENTRY"
              ? "Track your invoices, review their status, and keep every document connected."
              : manualEntryOnly ? "Your invoices and payments in one organized view." : "Your invoices, synchronization, and payments in one organized view."
        }
      >
        {!approvals && user.role !== "DATA_ENTRY" && (
          <Button asChild variant="secondary">
            <Link href="/bills/books">Zoho Books bills</Link>
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={exportPage}
          disabled={!state.data?.bills.length || state.loading}
        >
          <Download size={16} />
          Export current page
        </Button>
        {!approvals && user.role !== "MANAGEMENT" && (
          <Button asChild>
            <Link href="/bills/new">
              <Plus size={17} />
              Create bill
            </Link>
          </Button>
        )}
      </PageHeader>
      <Card className="bills-card">
        <div className="list-toolbar">
          <CompanySelect
            id="bill-list-company"
            required={false}
            value={companyId}
            onChange={(value) => {
              setCompanyId(value);
              setJobId("");
              setVendorId("");
              setPage(1);
            }}
          />
          <div className="search-input">
            <Search size={17} />
            <Input
              aria-label="Search bills"
              placeholder="Search invoice number or vendor…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          </div>
          {!approvals && (
            <Select
              aria-label="Bill status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All bill statuses</option>
              {[
                "DRAFT",
                "READY",
                "PENDING_APPROVAL",
                "APPROVED",
                "REJECTED",
                "CANCELLED",
              ].map((s) => (
                <option key={s} value={s}>
                  {s === "READY" ? (manualEntryOnly ? "Saved" : "Ready to sync") : s === "PENDING_APPROVAL" ? "Awaiting final save" : s === "APPROVED" ? "Approved (legacy)" : s.toLowerCase().replaceAll("_", " ")}
                </option>
              ))}
            </Select>
          )}
          <Select
            aria-label="Sort bills"
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              setPage(1);
            }}
          >
            <option value="date_desc">Newest first</option>
            <option value="date_asc">Oldest first</option>
            <option value="total_desc">Highest amount</option>
            <option value="total_asc">Lowest amount</option>
          </Select>
          <Button variant="secondary" onClick={() => setAdvanced(!advanced)}>
            <SlidersHorizontal size={15} />
            Filters
          </Button>
        </div>
        {advanced && (
          <div className="advanced-filters">
            <Field label="Payment status" htmlFor="filter-payment">
              <Select
                id="filter-payment"
                value={paymentStatus}
                onChange={(e) => {
                  setPaymentStatus(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All payments</option>
                <option value="UNPAID">Unpaid</option>
                <option value="PARTIALLY_PAID">Partially paid</option>
                <option value="PAID">Paid</option>
              </Select>
            </Field>
            <Field label="Job" htmlFor="filter-job">
              <Select
                id="filter-job"
                value={jobId}
                onChange={(e) => {
                  setJobId(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All jobs</option>
                {jobs.data?.jobs
                  .filter((j) => !companyId || j.companyId === companyId)
                  .map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.jobNumber} · {j.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Vendor" htmlFor="filter-vendor">
              <Select
                id="filter-vendor"
                value={vendorId}
                onChange={(e) => {
                  setVendorId(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All vendors</option>
                {vendors.data?.vendors
                  .filter((v) => !companyId || v.companyId === companyId)
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Category" htmlFor="filter-category">
              <Select
                id="filter-category"
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All categories</option>
                {["MATERIALS", "LABOUR", "EQUIPMENT", "TRANSPORT", "OTHER"].map(
                  (c) => (
                    <option key={c} value={c}>
                      {c.charAt(0) + c.slice(1).toLowerCase()}
                    </option>
                  ),
                )}
              </Select>
            </Field>
            <Field label="Invoice date from" htmlFor="filter-from">
              <Input
                id="filter-from"
                type="date"
                value={dateFrom}
                onChange={(e) => {
                  setDateFrom(e.target.value);
                  setPage(1);
                }}
              />
            </Field>
            <Field label="Invoice date to" htmlFor="filter-to">
              <Input
                id="filter-to"
                type="date"
                value={dateTo}
                onChange={(e) => {
                  setDateTo(e.target.value);
                  setPage(1);
                }}
              />
            </Field>
            <Button
              variant="ghost"
              onClick={() => {
                setPaymentStatus("");
                setJobId("");
                setVendorId("");
                setCategory("");
                setDateFrom("");
                setDateTo("");
                setPage(1);
              }}
            >
              Clear filters
            </Button>
          </div>
        )}
        {state.error ? (
          <ErrorState message={state.error} retry={state.reload} />
        ) : state.loading ? (
          <LoadingPanel />
        ) : (
          <BillTable bills={state.data?.bills ?? []} />
        )}
        <div className="pagination">
          <span>
            {state.data?.total
              ? `${(page - 1) * state.data.pageSize + 1}–${Math.min(page * state.data.pageSize, state.data.total)} of ${state.data.total} bills`
              : "0 bills"}
          </span>
          <div>
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1 || state.loading}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft size={15} />
              Previous
            </Button>
            <span>Page {page}</span>
            <Button
              variant="secondary"
              size="sm"
              disabled={
                state.loading ||
                !state.data ||
                page * state.data.pageSize >= state.data.total
              }
              onClick={() => setPage((p) => p + 1)}
            >
              Next
              <ChevronRight size={15} />
            </Button>
          </div>
        </div>
      </Card>
    </>
  );
}
