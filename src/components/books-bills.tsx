"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  RefreshCw,
  Search,
} from "lucide-react";
import type {
  BooksBillDetail as BooksBillData,
  BooksBillListResult,
} from "@/lib/services/books-import";
import { date, dateTime, useApi } from "./api";
import { CompanySelect } from "./company-select";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingPanel,
  Notice,
  PageHeader,
  Select,
  Table,
} from "./ui";
import styles from "./books-bills.module.css";

function companyName(name: string) {
  return name.replace(/^\s*\[CONNECTION CHECK\]\s*/i, "");
}

function SourceStatus({ status }: { status: string }) {
  const tone =
    status === "paid"
      ? "success"
      : status === "overdue"
        ? "danger"
        : status === "open"
          ? "info"
          : "neutral";
  return <Badge tone={tone}>{status || "Not provided"}</Badge>;
}

// Native amounts are strings. Never round, convert to a JS number, or combine currencies.
function sourceMoney(value: string | null, currency: string) {
  return value === null ? "Not provided" : `${currency} ${value}`;
}

function fileSize(bytes: number | null) {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function BooksBillsList({ initialCompanyId = "" }: { initialCompanyId?: string }) {
  const [companyId, setCompanyId] = useState(initialCompanyId);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [currencyCode, setCurrencyCode] = useState("");
  const [page, setPage] = useState(1);
  const query = new URLSearchParams({ page: String(page) });
  for (const [key, value] of Object.entries({
    companyId,
    q,
    status,
    currencyCode,
  }))
    if (value) query.set(key, value);
  const state = useApi<BooksBillListResult>(`/api/bills/books?${query}`);
  const result = state.data;
  const pages = result
    ? Math.max(1, Math.ceil(result.total / result.pageSize))
    : 1;

  return (
    <>
      <PageHeader
        eyebrow="ZOHO BOOKS"
        title="Zoho Books bills"
        description="Imported bills from your authorized companies, with the original Zoho amounts and payment status."
      >
        <Button
          variant="secondary"
          onClick={state.reload}
          disabled={state.loading}
        >
          <RefreshCw size={16} /> Refresh view
        </Button>
        <Button variant="secondary" asChild>
          <Link href="/bills">Manual bills</Link>
        </Button>
      </PageHeader>
      <Notice>
        These are read-only copies. Changes made in Zoho appear after the next
        import. Open a bill to see when its details were downloaded.
      </Notice>
      {result && result.runs.length > 0 && (
        <div className={styles.imports} aria-label="Import progress">
          {result.runs
            .filter(
              (run, index, runs) =>
                runs.findIndex(
                  (item) =>
                    item.companyId === run.companyId &&
                    item.organizationId === run.organizationId,
                ) === index,
            )
            .map((run) => (
              <Card className={styles.importCard} key={run.id}>
                <strong>{companyName(run.companyName)}</strong>
                <span>
                  {run.listedCount} bills listed · {run.detailCount} detailed
                  bills · {run.status.toLowerCase().replaceAll("_", " ")}
                </span>
                <small>
                  {run.completedAt
                    ? `Finished ${dateTime(run.completedAt)}`
                    : `Started ${dateTime(run.startedAt)}`}{" "}
                  Dubai
                </small>
                {run.lastErrorCode && (
                  <span>
                    {run.lastErrorCode === "DETAILS_PENDING"
                      ? "More bill details remain to be downloaded."
                      : run.lastErrorCode === "LISTING_INCOMPLETE"
                        ? "The bill listing is incomplete; more bills remain to be downloaded."
                        : "The import needs attention. Previously downloaded bills remain available."}
                  </span>
                )}
              </Card>
            ))}
        </div>
      )}
      <Card className="bills-card">
        <div className={`list-toolbar ${styles.toolbar}`}>
          <CompanySelect
            id="books-bills-company"
            required={false}
            value={companyId}
            onChange={(value) => {
              setCompanyId(value);
              setStatus("");
              setCurrencyCode("");
              setPage(1);
            }}
          />
          <div className="search-input">
            <Search size={17} />
            <Input
              aria-label="Search Zoho Books bills"
              placeholder="Bill number or supplier…"
              value={q}
              onChange={(event) => {
                setQ(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <Field label="Zoho status" htmlFor="books-bills-status">
            <Select
              id="books-bills-status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              {[
                ...new Set([
                  ...(result?.filters.statuses ?? []),
                  ...(status ? [status] : []),
                ]),
              ].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Currency" htmlFor="books-bills-currency">
            <Select
              id="books-bills-currency"
              value={currencyCode}
              onChange={(event) => {
                setCurrencyCode(event.target.value);
                setPage(1);
              }}
            >
              <option value="">All currencies</option>
              {[
                ...new Set([
                  ...(result?.filters.currencies ?? []),
                  ...(currencyCode ? [currencyCode] : []),
                ]),
              ].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {state.loading ? (
          <LoadingPanel />
        ) : state.error ? (
          <ErrorState message={state.error} retry={state.reload} />
        ) : (
          result && (
            <>
              {result.bills.length ? (
                <Table>
                  <thead>
                    <tr>
                      <th>Bill / supplier</th>
                      <th>Company</th>
                      <th>Bill date</th>
                      <th>Due date</th>
                      <th>Zoho status</th>
                      <th className="align-right">Total</th>
                      <th className="align-right">Balance</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.bills.map((bill) => (
                      <tr key={bill.id}>
                        <td>
                          <Link
                            className="text-link"
                            href={`/bills/books/${encodeURIComponent(bill.id)}`}
                          >
                            {bill.billNumber || bill.externalBillId}
                          </Link>
                          <span className={styles.secondary}>
                            {bill.vendorName || "Supplier not provided"}
                          </span>
                        </td>
                        <td>{companyName(bill.companyName)}</td>
                        <td>{date(bill.billDate)}</td>
                        <td>{date(bill.dueDate)}</td>
                        <td>
                          <SourceStatus status={bill.status} />
                        </td>
                        <td className="align-right">
                          {sourceMoney(bill.total, bill.currencyCode)}
                        </td>
                        <td className="align-right">
                          {sourceMoney(bill.balance, bill.currencyCode)}
                        </td>
                        <td>
                          {bill.detailAvailable ? "Downloaded" : "Summary only"}
                          {bill.isStale && (
                            <span className={styles.secondary}>
                              Refresh needed
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <EmptyState
                  title="No imported bills found"
                  description={
                    q || companyId || status || currencyCode
                      ? "Change the filters to see more imported bills."
                      : "Bills will appear here when a Zoho Books import has been completed for an authorized company."
                  }
                />
              )}
              <div className="pagination">
                <span>{result.total} matching bills</span>
                <div>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label="Previous page"
                    disabled={page <= 1}
                    onClick={() => setPage(page - 1)}
                  >
                    <ChevronLeft size={15} />
                  </Button>
                  <span>
                    Page {result.page} of {pages}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label="Next page"
                    disabled={page >= pages}
                    onClick={() => setPage(page + 1)}
                  >
                    <ChevronRight size={15} />
                  </Button>
                </div>
              </div>
            </>
          )
        )}
      </Card>
    </>
  );
}

export function BooksBillDetail({ id }: { id: string }) {
  const state = useApi<{ bill: BooksBillData }>(
    `/api/bills/books/${encodeURIComponent(id)}`,
  );
  if (state.loading) return <LoadingPanel />;
  if (state.error)
    return <ErrorState message={state.error} retry={state.reload} />;
  if (!state.data) return null;
  return <BooksBillRecord bill={state.data.bill} />;
}

export function BooksBillRecord({ bill }: { bill: BooksBillData }) {
  const amounts = [
    ["Subtotal", bill.subtotal],
    ["Tax", bill.taxTotal],
    ["Total", bill.total],
    ["Payments made", bill.paymentMade],
    ["Vendor credits applied", bill.vendorCreditsApplied],
    ["Balance", bill.balance],
  ] as const;
  return (
    <>
      <PageHeader
        eyebrow="IMPORTED FROM ZOHO BOOKS"
        title={bill.billNumber || bill.externalBillId}
        description={`${bill.vendorName || "Supplier not provided"} · ${companyName(bill.companyName)}`}
      >
        <Button variant="secondary" asChild>
          <Link href="/bills/books">
            <ArrowLeft size={16} /> All Zoho bills
          </Link>
        </Button>
      </PageHeader>
      <Notice>
        {bill.detailAvailable
          ? "Read-only Zoho Books record. Manage this bill and its payments in Zoho Books."
          : "Only the bill summary has been downloaded. Line items, payments, credits and attachment details are not available yet."}
      </Notice>
      {bill.isStale && (
        <Notice tone="error">
          This bill was not confirmed in the latest completed listing. Its saved
          details may be out of date.
        </Notice>
      )}
      <div className={`bill-detail-layout ${styles.detail}`}>
        <div className="detail-main">
          <Card className={styles.section}>
            <h2>Bill details</h2>
            <dl className="detail-grid">
              <div>
                <dt>Zoho status</dt>
                <dd>
                  <SourceStatus status={bill.status} />
                </dd>
              </div>
              <div>
                <dt>Supplier</dt>
                <dd>{bill.vendorName || "Not provided"}</dd>
              </div>
              <div>
                <dt>Bill date</dt>
                <dd>{date(bill.billDate)}</dd>
              </div>
              <div>
                <dt>Due date</dt>
                <dd>{date(bill.dueDate)}</dd>
              </div>
              <div>
                <dt>Reference</dt>
                <dd>{bill.referenceNumber || "Not provided"}</dd>
              </div>
              <div>
                <dt>Currency</dt>
                <dd>{bill.currencyCode}</dd>
              </div>
            </dl>
            {bill.notes && (
              <div className="invoice-notes">
                <strong>Notes from Zoho</strong>
                <p>{bill.notes}</p>
              </div>
            )}
            {bill.terms && (
              <div className="invoice-notes">
                <strong>Terms from Zoho</strong>
                <p>{bill.terms}</p>
              </div>
            )}
          </Card>
          <Card>
            <div className={styles.sectionHeading}>
              <h2>Line items</h2>
            </div>
            {!bill.detailAvailable ? (
              <p className="small-empty">
                Line items have not been downloaded.
              </p>
            ) : !bill.lines.length ? (
              <p className="small-empty">
                No line items were returned by Zoho.
              </p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th>Item / description</th>
                    <th>Account / project</th>
                    <th className="align-right">Quantity</th>
                    <th className="align-right">Rate</th>
                    <th>Tax</th>
                    <th className="align-right">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {bill.lines.map((line, index) => (
                    <tr key={`${line.id ?? "line"}-${index}`}>
                      <td className={styles.wrap}>
                        {line.name || line.description || "Not provided"}
                        {line.name && line.description && (
                          <span className={styles.secondary}>
                            {line.description}
                          </span>
                        )}
                      </td>
                      <td className={styles.wrap}>
                        {line.accountName || "Not provided"}
                        {line.projectName && (
                          <span className={styles.secondary}>
                            {line.projectName}
                          </span>
                        )}
                      </td>
                      <td className="align-right">
                        {line.quantity ?? "Not provided"}
                      </td>
                      <td className="align-right">
                        {sourceMoney(line.rate, bill.currencyCode)}
                      </td>
                      <td>
                        {line.taxName || "Not provided"}
                        {line.taxPercentage !== null && (
                          <span className={styles.secondary}>
                            {line.taxPercentage}%
                          </span>
                        )}
                      </td>
                      <td className="align-right">
                        {sourceMoney(line.total, bill.currencyCode)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <div className={styles.sectionHeading}>
              <h2>Payments recorded in Zoho</h2>
            </div>
            {!bill.detailAvailable ? (
              <p className="small-empty">Payments have not been downloaded.</p>
            ) : !bill.payments.length ? (
              <p className="small-empty">
                No payment records were returned by Zoho.
              </p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Reference</th>
                    <th>Mode</th>
                    <th className="align-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {bill.payments.map((payment, index) => (
                    <tr key={`${payment.id ?? "payment"}-${index}`}>
                      <td>{date(payment.date)}</td>
                      <td>{payment.referenceNumber || "Not provided"}</td>
                      <td>{payment.paymentMode || "Not provided"}</td>
                      <td className="align-right">
                        {sourceMoney(payment.amount, bill.currencyCode)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <div className={styles.sectionHeading}>
              <h2>Vendor credits recorded in Zoho</h2>
            </div>
            {!bill.detailAvailable ? (
              <p className="small-empty">
                Vendor credits have not been downloaded.
              </p>
            ) : !bill.credits.length ? (
              <p className="small-empty">
                No vendor credit records were returned by Zoho.
              </p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th>Credit number</th>
                    <th>Date</th>
                    <th className="align-right">Amount applied</th>
                  </tr>
                </thead>
                <tbody>
                  {bill.credits.map((credit, index) => (
                    <tr key={`${credit.id ?? "credit"}-${index}`}>
                      <td>{credit.number || "Not provided"}</td>
                      <td>{date(credit.date)}</td>
                      <td className="align-right">
                        {sourceMoney(credit.amount, bill.currencyCode)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card className={styles.section}>
            <h2>Attachments</h2>
            <p className={styles.explanation}>
              {!bill.detailAvailable
                ? "Attachment details have not been downloaded."
                : bill.downloadedAttachmentCount > 0
                  ? `${bill.downloadedAttachmentCount} of ${bill.attachmentCount} original files downloaded from Zoho Books. Open or download the files below.`
                  : bill.documents.length || bill.hasAttachment
                    ? "Original files have not been downloaded into this app yet."
                    : "No attachments were reported by Zoho for this bill."}
            </p>
            {bill.documents.length > 0 && (
              <ul className={styles.documents}>
                {bill.documents.map((document, index) => {
                  const name =
                    document.fileName ||
                    document.name ||
                    "Unnamed Zoho document";
                  const available =
                    document.downloaded && document.attachmentId;
                  const href = available
                    ? `/api/bills/books/${encodeURIComponent(bill.id)}/attachments/${encodeURIComponent(document.attachmentId!)}`
                    : null;
                  return (
                    <li key={`${document.id ?? "document"}-${index}`}>
                      <div className={styles.documentInfo}>
                        <strong>{name}</strong>
                        <span className={styles.secondary}>
                          {available
                            ? `Downloaded${document.byteSize !== null ? ` · ${fileSize(document.byteSize)}` : ""}`
                            : "Not downloaded yet"}
                        </span>
                      </div>
                      {href && (
                        <div className={styles.documentActions}>
                          <Button variant="secondary" size="sm" asChild>
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`Open ${name}`}
                            >
                              <ExternalLink size={14} /> Open
                            </a>
                          </Button>
                          <Button variant="secondary" size="sm" asChild>
                            <a
                              href={`${href}?download=1`}
                              aria-label={`Download ${name}`}
                            >
                              <Download size={14} /> Download
                            </a>
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
        <aside className="detail-aside">
          <Card className={styles.section}>
            <h2>Amounts from Zoho</h2>
            {amounts.map(([label, value]) => (
              <div
                className={`amount-row ${label === "Total" || label === "Balance" ? "amount-row-strong" : ""}`}
                key={label}
              >
                <span>{label}</span>
                <strong>{sourceMoney(value, bill.currencyCode)}</strong>
              </div>
            ))}
            <p className={styles.explanation}>
              Amounts are shown in the bill currency exactly as downloaded.
              Payments and credits are shown separately.
            </p>
          </Card>
          <Card className={styles.section}>
            <h2>Source & import</h2>
            <dl className={styles.provenance}>
              <div>
                <dt>Source</dt>
                <dd>Zoho Books</dd>
              </div>
              <div>
                <dt>Organization</dt>
                <dd>{bill.organizationId}</dd>
              </div>
              <div>
                <dt>Zoho bill ID</dt>
                <dd>{bill.externalBillId}</dd>
              </div>
              <div>
                <dt>Latest source read</dt>
                <dd>{dateTime(bill.lastSeenAt)} Dubai</dd>
              </div>
              <div>
                <dt>First imported</dt>
                <dd>{dateTime(bill.importedAt)} Dubai</dd>
              </div>
              <div>
                <dt>Details downloaded</dt>
                <dd>
                  {bill.detailFetchedAt
                    ? `${dateTime(bill.detailFetchedAt)} Dubai`
                    : "Not yet downloaded"}
                </dd>
              </div>
              <div>
                <dt>Last modified in Zoho</dt>
                <dd>
                  {bill.sourceModifiedAt
                    ? `${dateTime(bill.sourceModifiedAt)} Dubai`
                    : "Not provided"}
                </dd>
              </div>
            </dl>
          </Card>
        </aside>
      </div>
    </>
  );
}
