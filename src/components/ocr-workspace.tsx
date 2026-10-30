"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Camera, FileScan, RefreshCw, Upload } from "lucide-react";
import { api, dateTime, errorMessage, useApi } from "./api";
import { useUser } from "./app-shell";
import { BillEditor } from "./bill-form";
import { OcrTemplates } from "./ocr-templates";
import { CompanySelect } from "./company-select";
import type { Bill } from "./types";
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
  Table,
} from "./ui";

type OcrDocument = {
  id: string;
  companyId?: string;
  version: number;
  status: string;
  fileName: string;
  scannerSourceName?: string | null;
  billId?: string | null;
  lastError?: string | null;
  failureCode?: string | null;
  warnings?: string[];
  bill?: {
    id: string;
    invoiceNumber: string;
    status: string;
    version: number;
    createdById: string;
  } | null;
  suggestedInput?: Partial<Bill>;
  verifiedInput?: Partial<Bill> | null;
  extraction?: {
    fields?: Partial<Bill>;
    confidence?: Record<string, number>;
    warnings?: string[];
    text?: string;
    vendorName?: string;
    vendorTrn?: string;
    jobNumber?: string;
    subtotal?: string;
    vatAmount?: string;
    total?: string;
    sourceLines?: {
      amount?: string;
      taxAmount?: string;
      taxRate?: string;
      currency?: string;
    }[];
    taxDetails?: {
      amount?: string;
      rate?: string;
      currency?: string;
    }[];
  } | null;
};
type OcrBatch = {
  id: string;
  createdAt: string;
  documents: OcrDocument[];
  counts?: Record<string, number>;
};
type OcrListing = {
  provider: { status: string; configured: boolean; message: string };
  batches: OcrBatch[];
  nextCursor?: string | null;
};
const activeStates = ["QUEUED", "PROCESSING", "SUBMITTED", "POLLING"];

function confidenceLabel(name: string) {
  const labels: Record<string, string> = {
    vendorName: "Supplier name",
    vendorTrn: "Supplier tax number",
    invoiceNumber: "Invoice number",
    invoiceDate: "Invoice date",
    dueDate: "Due date",
    orderNumber: "Purchase order",
    currency: "Currency",
    subtotal: "Subtotal",
    vatAmount: "Tax amount",
    vatRate: "Tax rate",
    total: "Total",
    description: "description",
    quantity: "quantity",
    unitPrice: "unit price",
    amount: "amount",
    taxAmount: "tax amount",
    taxRate: "tax rate",
  };
  const line = /^lines\.(\d+)\.(.+)$/.exec(name);
  const tax = /^taxDetails\.(\d+)\.(.+)$/.exec(name);
  if (tax)
    return `Tax detail ${Number(tax[1]) + 1} ${tax[2] === "rate" ? "rate" : (labels[tax[2]] ?? tax[2])}`;
  return line
    ? `Line ${Number(line[1]) + 1} ${labels[line[2]] ?? line[2]}`
    : (labels[name] ?? name);
}

function OcrStatus({ status }: { status: string }) {
  if (status === "REVIEW_REQUIRED")
    return <Badge tone="warning">Review required</Badge>;
  if (status === "FAILED" || status === "UNKNOWN")
    return <Badge tone="danger">OCR failed</Badge>;
  if (status === "POSTED") return <Badge tone="success">Saved to bill</Badge>;
  if (status === "QUEUED") return <Badge tone="info">Queued for OCR</Badge>;
  return <Badge tone="info">OCR processing</Badge>;
}

function processingDescription(document: OcrDocument) {
  if (document.billId)
    return "Saved to the bill workflow. Books synchronization and payment are tracked separately.";
  if (document.status === "REVIEW_REQUIRED")
    return "Extraction completed. Check and correct every field, then Save and sync.";
  if (["FAILED", "UNKNOWN"].includes(document.status))
    return (
      document.lastError ||
      "Processing failed. Retry when available or enter the bill from the stored original."
    );
  if (document.status === "QUEUED")
    return "Waiting for the OCR worker. You can leave this page and return later.";
  return "Azure analysis is in progress. No bill has been created.";
}

export function OcrWorkspace({ batch = false }: { batch?: boolean }) {
  const user = useUser();
  const [cursors, setCursors] = useState<string[]>([""]);
  const cursor = cursors[cursors.length - 1];
  const state = useApi<OcrListing>(
    cursor ? `/api/ocr?cursor=${encodeURIComponent(cursor)}` : "/api/ocr",
  );
  const [companyId, setCompanyId] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const processing = state.data?.batches.some((b) =>
    b.documents.some((d) => activeStates.includes(d.status)),
  );
  const { reload } = state;
  useEffect(() => {
    if (busy || files.length) return;
    const timer = setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        !document.activeElement?.closest("form")
      )
        reload();
    }, processing ? 5000 : 30000);
    return () => clearInterval(timer);
  }, [processing, reload, busy, files.length]);
  const canUpload = user.role !== "MANAGEMENT";
  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");
    const form = event.currentTarget;
    if (!companyId) {
      setError("Select a company before uploading.");
      return;
    }
    if (!files.length || files.length > (batch ? 10 : 1)) {
      setError(`Select ${batch ? "1–10 files" : "one invoice"}.`);
      return;
    }
    if (files.some((file) => file.size > 10 * 1024 * 1024)) {
      setError("Each invoice must be no larger than 10 MB.");
      return;
    }
    if (files.reduce((sum, file) => sum + file.size, 0) > 40 * 1024 * 1024) {
      setError("The complete batch must be no larger than 40 MB.");
      return;
    }
    setBusy(true);
    try {
      const data = new FormData();
      files.forEach((file) => data.append("files", file));
      const result = await api<{ batch: OcrBatch }>(
        `/api/ocr?companyId=${encodeURIComponent(companyId)}`,
        {
          method: "POST",
          body: data,
        },
      );
      setFiles([]);
      form.reset();
      if (
        result.batch.documents.some((document) => document.status === "FAILED")
      )
        setError(
          "Originals were stored, but processing needs attention. See each document's setup or processing error below.",
        );
      else
        setSuccess(
          "Documents queued. Review each extraction before creating a bill.",
        );
      setCursors([""]);
      state.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function retry(document: OcrDocument) {
    const acknowledgeUnknown = document.failureCode === "SUBMISSION_UNKNOWN";
    if (
      acknowledgeUnknown &&
      !window.confirm(
        "The earlier OCR submission outcome is unknown. Check provider operations first. Retry anyway and accept that another analysis charge may apply?",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/ocr/documents/${document.id}/retry`, {
        method: "POST",
        body: JSON.stringify({ acknowledgeUnknown }),
      });
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
        eyebrow="DOCUMENT AUTOMATION"
        title={batch ? "Batch bill processing" : "Single bill OCR"}
        description="Upload, extract, then verify every invoice before it enters the bill workflow."
      >
        {canUpload && (
          <Button variant="secondary" asChild>
            <Link href="/bills/new">Enter bill manually</Link>
          </Button>
        )}
        <Button variant="secondary" onClick={state.reload}>
          <RefreshCw size={15} />
          Refresh
        </Button>
      </PageHeader>
      {error && <Notice tone="error">{error}</Notice>}
      {success && <Notice tone="success">{success}</Notice>}
      {state.error ? (
        <ErrorState message={state.error} retry={state.reload} />
      ) : state.loading ? (
        <LoadingPanel />
      ) : (
        <>
          {!state.data?.provider.configured && (
            <Notice>
              <strong>OCR setup required. </strong>
              {state.data?.provider.message} No extraction results are available
              until a provider processes your document. Manual bill entry
              remains available while setup is completed.
            </Notice>
          )}
          {state.data?.provider.configured && (
            <Notice>
              OCR provider configured. Review every extracted field, then Save
              and sync. You can also keep an unfinished bill as a draft.
            </Notice>
          )}
          {canUpload && (
            <Card className="form-card ocr-upload-panel">
              <div className="panel-heading compact">
                <h2>
                  <FileScan size={20} />{" "}
                  {batch ? "Add invoices" : "Add an invoice"}
                </h2>
                <Badge>PDF · JPEG · PNG</Badge>
              </div>
              <form onSubmit={upload}>
                <CompanySelect
                  id="ocr-company"
                  value={companyId}
                  onChange={setCompanyId}
                  disabled={busy}
                />
                <Field
                  label={batch ? "Invoice files" : "Invoice file"}
                  htmlFor="ocr-files"
                  hint="Up to 10 MB per file and 40 MB per batch. A multipage PDF is treated as one invoice; split PDFs containing separate invoices before uploading."
                >
                  <Input
                    id="ocr-files"
                    type="file"
                    accept="application/pdf,image/jpeg,image/png"
                    multiple={batch}
                    onChange={(event) =>
                      setFiles(Array.from(event.target.files ?? []))
                    }
                  />
                </Field>
                {!batch && (
                  <Field label="Take an invoice photo" htmlFor="ocr-camera">
                    <Input
                      id="ocr-camera"
                      type="file"
                      accept="image/jpeg,image/png"
                      capture="environment"
                      onChange={(event) =>
                        setFiles(Array.from(event.target.files ?? []))
                      }
                    />
                  </Field>
                )}
                <div className="button-row">
                  <Button
                    type="submit"
                    disabled={
                      busy || !files.length || !state.data?.provider.configured
                    }
                  >
                    <Upload size={16} />
                    {busy ? "Uploading…" : "Upload for extraction"}
                  </Button>
                  <span className="muted small">
                    {files.length ? (
                      `${files.length} selected: ${files.map((f) => f.name).join(", ")}`
                    ) : (
                      <>
                        <Camera size={14} /> Camera capture is available on
                        supported mobile devices.
                      </>
                    )}
                  </span>
                </div>
              </form>
            </Card>
          )}
          {!state.data?.batches.length ? (
            <EmptyState
              title="No OCR documents yet"
              description="Your uploaded invoices and processing progress will appear here."
            />
          ) : (
            state.data.batches.map((b) => (
              <Card key={b.id} className="ocr-batch-card">
                <div className="panel-heading">
                  <div>
                    <h2>Invoice batch</h2>
                    <p>
                      {dateTime(b.createdAt)} · {b.documents.length} documents ·{" "}
                      {
                        b.documents.filter(
                          (d) => !activeStates.includes(d.status),
                        ).length
                      }{" "}
                      processed
                    </p>
                  </div>
                  <a
                    className="text-link"
                    href={`/api/ocr/batches/${b.id}/errors`}
                  >
                    Export errors CSV
                  </a>
                </div>
                <Table>
                  <thead>
                    <tr>
                      <th>Document</th>
                      <th>Status</th>
                      <th>Review / error</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.documents.map((d) => (
                      <tr key={d.id}>
                        <td>
                          <a
                            href={`/api/ocr/documents/${d.id}/file`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-link"
                          >
                            {d.fileName}
                          </a>
                          {d.scannerSourceName && (
                            <div>
                              <Badge tone="info">
                                Scanner: {d.scannerSourceName}
                              </Badge>
                            </div>
                          )}
                        </td>
                        <td>
                          <OcrStatus status={d.status} />
                        </td>
                        <td className="ocr-error-cell">
                          {processingDescription(d)}
                        </td>
                        <td>
                          {d.billId ? (
                            <Link
                              className="text-link"
                              href={`/bills/${d.billId}`}
                            >
                              Open bill
                            </Link>
                          ) : d.status === "REVIEW_REQUIRED" ? (
                            <Link
                              className="text-link"
                              href={`/ocr/documents/${d.id}`}
                            >
                              {canUpload ? "Review invoice" : "View extraction"}
                            </Link>
                          ) : ["FAILED", "UNKNOWN"].includes(d.status) &&
                            canUpload ? (
                            <div className="button-row">
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={
                                  busy || !state.data?.provider.configured
                                }
                                onClick={() => retry(d)}
                              >
                                Retry
                              </Button>
                              {d.status === "FAILED" && (
                                <Link
                                  className="text-link"
                                  href={`/ocr/documents/${d.id}`}
                                >
                                  Enter from original
                                </Link>
                              )}
                              {state.data?.provider.configured && (
                                <span className="small muted">
                                  Retry available
                                </span>
                              )}
                            </div>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            ))
          )}
          {(cursor || state.data?.nextCursor) && (
            <nav className="button-row" aria-label="OCR invoice pages">
              {cursor && (
                <>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => setCursors((current) => current.slice(0, -1))}
                  >
                    Newer invoices
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setCursors([""])}
                  >
                    Newest invoices
                  </Button>
                </>
              )}
              {state.data?.nextCursor && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    const next = state.data?.nextCursor;
                    if (next) setCursors((current) => [...current, next]);
                  }}
                >
                  Older invoices
                </Button>
              )}
            </nav>
          )}
          {batch && (
            <Card className="scanner-note">
              <h2>Scanner imports</h2>
              <p>
                When scanner import is configured, received invoices appear in
                this queue with their scanner source and are sent to Azure OCR.
                Review the extraction, then Save and sync without a separate
                approval step. If OCR fails, authorized users can retry or enter
                the bill from the original. Saving does not record payment.
                The queue refreshes automatically while this page is visible and
                you are not editing.
              </p>
            </Card>
          )}
          <OcrTemplates />
        </>
      )}
    </>
  );
}

export function OcrReviewPage({ id }: { id: string }) {
  const state = useApi<{ document: OcrDocument }>(`/api/ocr/documents/${id}`);
  const user = useUser();
  const [manual, setManual] = useState(false);
  if (state.loading) return <LoadingPanel />;
  if (state.error || !state.data)
    return (
      <ErrorState
        message={state.error ?? "Document unavailable"}
        retry={state.reload}
      />
    );
  const document = state.data.document;
  if (document.billId)
    return (
      <Notice tone="success">
        This document has already been verified.{" "}
        <Link className="text-link" href={`/bills/${document.billId}`}>
          Open saved bill
        </Link>
      </Notice>
    );
  const evidence = document.extraction;
  const manualReview =
    manual && document.status === "FAILED" && user.role !== "MANAGEMENT";
  const missingFields = [
    !evidence?.vendorName && "supplier name",
    !evidence?.fields?.invoiceNumber && "invoice number",
    !evidence?.fields?.invoiceDate && "invoice date",
    !evidence?.fields?.currency && "currency",
    (evidence?.fields?.vatRate === undefined ||
      evidence.fields.vatRate === "") &&
      "VAT rate",
    !evidence?.fields?.lines?.length && "line items",
  ].filter(Boolean);
  return (
    <>
      <PageHeader
        eyebrow="OCR REVIEW"
        title={document.fileName}
        description={
          manualReview
            ? "OCR did not complete. Enter the bill from the stored original, then confirm your review."
            : "Compare extracted evidence with the original invoice. Correct the bill below, then confirm verification."
        }
      >
        <Button asChild variant="secondary">
          <a
            href={`/api/ocr/documents/${id}/file`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open original invoice
          </a>
        </Button>
      </PageHeader>
      {document.scannerSourceName && (
        <Notice>
          Imported from scanner: {document.scannerSourceName}. Check the stored
          original and every extracted field before saving the bill.
        </Notice>
      )}
      {document.status !== "REVIEW_REQUIRED" && !manualReview ? (
        <Notice>
          {document.lastError ||
            `Document is ${document.status.toLowerCase().replaceAll("_", " ")}.`}{" "}
          <Link className="text-link" href="/ocr/batch">
            Return to processing
          </Link>
          {document.status === "FAILED" && user.role !== "MANAGEMENT" && (
            <div className="button-row">
              <Button onClick={() => setManual(true)}>
                Enter bill manually
              </Button>
              <span>
                The stored original will be reused. This does not mark OCR as
                successful.
              </span>
            </div>
          )}
        </Notice>
      ) : (
        <>
          {manualReview ? (
            <Notice>
              OCR failed. Complete all values from the original invoice, then
              Save and sync. You can keep a draft instead. Saving does not
              record payment.
            </Notice>
          ) : (
            <Card className="form-card ocr-evidence">
              <h2>Extracted evidence · unverified</h2>
              {missingFields.length > 0 && (
                <Notice>
                  Missing or unconfirmed fields: {missingFields.join(", ")}.
                  Complete these from the original invoice.
                </Notice>
              )}
              {evidence?.vendorName && (
                <p>
                  Vendor: {evidence.vendorName}
                  {evidence.vendorTrn ? ` · TRN ${evidence.vendorTrn}` : ""}
                </p>
              )}
              {evidence?.jobNumber && (
                <p>Detected job reference: {evidence.jobNumber}</p>
              )}
              {[
                ...new Set([
                  ...(evidence?.warnings ?? []),
                  ...(document.warnings ?? []),
                ]),
              ].map((warning, i) => (
                <Notice key={i}>{warning}</Notice>
              ))}
              <div className="ocr-confidence">
                {Object.entries(evidence?.confidence ?? {}).map(
                  ([name, confidence]) => (
                    <Badge
                      key={name}
                      tone={confidence < 0.85 ? "warning" : "info"}
                    >
                      {confidenceLabel(name)}: {Math.round(confidence * 100)}%
                    </Badge>
                  ),
                )}
              </div>
              {!!evidence?.sourceLines?.length && (
                <div aria-label="Extracted line amounts and taxes">
                  <h3>Source line amounts and taxes</h3>
                  <p className="muted small">
                    Unverified source evidence. The editable bill uses one
                    bill-level VAT rate; mixed taxes require accounting review.
                  </p>
                  <Table>
                    <thead>
                      <tr>
                        <th>Line</th>
                        <th>Amount</th>
                        <th>Tax amount</th>
                        <th>Tax rate</th>
                        <th>Currency</th>
                      </tr>
                    </thead>
                    <tbody>
                      {evidence.sourceLines.map((line, index) => (
                        <tr key={index}>
                          <td>{index + 1}</td>
                          <td>{line.amount ?? "Not extracted"}</td>
                          <td>{line.taxAmount ?? "Not extracted"}</td>
                          <td>
                            {line.taxRate === undefined
                              ? "Not extracted"
                              : `${line.taxRate}%`}
                          </td>
                          <td>{line.currency ?? "Not extracted"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              )}
              {!!evidence?.taxDetails?.length && (
                <div aria-label="Extracted tax details">
                  <h3>Source tax details</h3>
                  <Table>
                    <thead>
                      <tr>
                        <th>Tax amount</th>
                        <th>Tax rate</th>
                        <th>Currency</th>
                      </tr>
                    </thead>
                    <tbody>
                      {evidence.taxDetails.map((tax, index) => (
                        <tr key={index}>
                          <td>{tax.amount ?? "Not extracted"}</td>
                          <td>
                            {tax.rate === undefined
                              ? "Not extracted"
                              : `${tax.rate}%`}
                          </td>
                          <td>{tax.currency ?? "Not extracted"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              )}
              <details>
                <summary>View extracted text and fields</summary>
                <pre>{JSON.stringify(evidence?.fields ?? {}, null, 2)}</pre>
                <pre>{evidence?.text || "No extracted text returned."}</pre>
              </details>
            </Card>
          )}
          <BillEditor
            draft={{
              ...(manualReview
                ? {}
                : (document.suggestedInput ?? evidence?.fields ?? {})),
              companyId: document.companyId,
            }}
            review={{
              documentId: id,
              version: document.version,
              ...(manualReview
                ? { mode: "manual" as const }
                : {
                    sourceTotals: {
                      subtotal: evidence?.subtotal,
                      vatAmount: evidence?.vatAmount,
                      total: evidence?.total,
                      currency: evidence?.fields?.currency,
                    },
                  }),
            }}
          />
        </>
      )}
    </>
  );
}
