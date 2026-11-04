"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle, ScanText } from "lucide-react";
import type { InvoiceAutofillCapability, InvoiceAutofillResponse } from "@/lib/manual-bill-autofill-types";
import { api, errorMessage, useApi } from "./api";
import { Button, Notice } from "./ui";
import type { InvoiceFileSelection } from "./invoice-attachment-picker";
import styles from "./manual-bill-autofill.module.css";

type Applied = { kept: boolean };
type Reading = { key: string; revision: number; status: "reading" | "ready" | "failed"; preview?: InvoiceAutofillResponse["preview"]; message?: string; kept?: boolean };
function matchesSource(value: InvoiceAutofillResponse, requestId: string, companyId: string, jobId: string, currency: string, files: InvoiceFileSelection[]) {
  const source = value?.source, preview = value?.preview;
  if (value?.requestId !== requestId || source?.companyId !== companyId || source.jobId !== jobId || source.currency !== currency ||
    !/^[a-f0-9]{64}$/.test(source.fingerprint ?? "") || !Array.isArray(source.files) || source.files.length !== files.length ||
    !source.files.every((file, index) => file.index === index && file.sha256 === files[index].id && file.byteSize === files[index].file.size && file.mimeType === files[index].file.type) ||
    preview?.requiresHumanReview !== true || !preview.fields || typeof preview.fields !== "object" ||
    !preview.evidence || !Array.isArray(preview.warnings) || !preview.warnings.every(warning => typeof warning === "string")) return false;
  const fields = preview.fields;
  if (Object.keys(fields).some(key => !["invoiceNumber", "invoiceDate", "dueDate", "orderNumber", "description", "discount", "vatRate", "lines", "vendorId", "currency"].includes(key)) ||
    Object.entries(fields).some(([key, field]) => key !== "lines" && typeof field !== "string") ||
    fields.lines && (!Array.isArray(fields.lines) || fields.lines.length > 100 || !fields.lines.every(line =>
      line && typeof line.description === "string" && typeof line.quantity === "string" && typeof line.unitPrice === "string")) ||
    fields.currency && fields.currency !== currency || fields.vendorId && (!preview.vendor || preview.vendor.id !== fields.vendorId || preview.vendor.currency !== currency)) return false;
  return true;
}

export function useManualBillAutofill({ eligible, companyId, jobId, currency, files, checking, apply, invalidate }: {
  eligible: boolean; companyId: string; jobId: string; currency: string; files: InvoiceFileSelection[]; checking: boolean;
  apply: (result: InvoiceAutofillResponse) => Applied; invalidate: () => void;
}) {
  const scoped = !!companyId && !!jobId;
  const capability = useApi<InvoiceAutofillCapability>(eligible && scoped ? `/api/bills/autofill?${new URLSearchParams({ companyId, jobId })}` : null);
  const callbacks = useRef({ apply, invalidate });
  useLayoutEffect(() => { callbacks.current = { apply, invalidate }; }, [apply, invalidate]);
  const generation = useRef(0), controller = useRef<AbortController | null>(null);
  const [revision, setRevision] = useState(0), [manualKey, setManualKey] = useState<string | null>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const key = JSON.stringify([companyId, jobId, currency, files.map(file => [file.id, file.file.size, file.file.type])]);
  const current = reading?.key === key ? reading : null;
  const available = capability.data?.enabled === true && capability.data.configured === true;
  const canRead = eligible && !!companyId && !!jobId && files.length > 0 && !checking && available;
  const manual = manualKey === key;
  useEffect(() => {
    const version = ++generation.current;
    controller.current?.abort();
    callbacks.current.invalidate();
    if (!canRead || manual || current && current.revision === revision && current.status !== "reading") return;
    const active = new AbortController(); controller.current = active;
    const timer = setTimeout(async () => {
      if (active.signal.aborted) return;
      const requestId = crypto.randomUUID();
      setReading({ key, revision, status: "reading" });
      try {
        const body = new FormData();
        body.set("companyId", companyId); body.set("jobId", jobId); body.set("requestId", requestId);
        for (const file of files) body.append("files", file.file);
        const result = await api<InvoiceAutofillResponse>("/api/bills/autofill", { method: "POST", body, signal: active.signal });
        if (active.signal.aborted || generation.current !== version) return;
        if (!matchesSource(result, requestId, companyId, jobId, currency, files))
          throw new Error("The reading did not match these originals and the selected job. Retry reading or enter this invoice manually.");
        const applied = callbacks.current.apply(result);
        setReading({ key, revision, status: "ready", preview: result.preview, kept: applied.kept });
      } catch (failure) {
        if (!active.signal.aborted && generation.current === version) setReading({ key, revision, status: "failed", message: errorMessage(failure) });
      }
    }, 700);
    return () => { clearTimeout(timer); active.abort(); };
    // The key binds the exact ordered Files. Form edits update only callbacks,
    // so typing never restarts a provider request or authorizes overwriting them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, canRead, manual, revision]);
  const stop = useCallback(() => {
    generation.current++; controller.current?.abort(); setManualKey(key);
  }, [key]);
  const retry = () => { generation.current++; controller.current?.abort(); setManualKey(null); setRevision(value => value + 1); if (!available) capability.reload(); };
  const waiting = eligible && scoped && files.length > 0 && !manual && (capability.loading || canRead && (!current || current.status === "reading"));
  return { capability, available, current, manual, waiting, canRead, scoped, stop, retry,
    preview: current?.status === "ready" ? current.preview : undefined };
}

export function ManualBillAutofill({ reading, jobNumber }: { reading: ReturnType<typeof useManualBillAutofill>; jobNumber?: string }) {
  const preview = reading.preview;
  return <div className={styles.panel} aria-label="Invoice automatic reading">
    <div className={styles.heading}><ScanText size={19} /><strong>Read invoice details</strong></div>
    <p>Attach all pages of one invoice. AI fills the readable details; check the originals and correct the bill before saving.</p>
    {reading.waiting && <p className={styles.status} role="status"><LoaderCircle size={16} className="spin" />Reading invoice… Your edits will be kept.</p>}
    {reading.manual && <p role="status">Manual entry selected. Check the current originals and enter the bill below.</p>}
    {!reading.scoped && <p>Select a company and job before reading the invoice. The selected job will be kept.</p>}
    {reading.scoped && !reading.available && !reading.capability.loading && <p role="status">Automatic reading is unavailable. Manual entry remains available.</p>}
    {reading.current?.status === "failed" && !reading.manual && <Notice tone="error">{reading.current.message} You can continue manually.</Notice>}
    {preview && !reading.manual && <>
      <p role="status"><strong>Invoice details filled for review.</strong>{reading.current?.kept ? " Fields you edited were kept." : ""}</p>
      <dl className={styles.evidence}>
        <div><dt>Printed supplier</dt><dd>{preview.evidence.vendorName ?? "Not read"}{preview.evidence.vendorTrn && <span>TRN: {preview.evidence.vendorTrn}</span>}</dd></div>
        <div><dt>Printed subtotal</dt><dd>{preview.evidence.subtotal ?? "Not read"}</dd></div>
        <div><dt>Printed VAT</dt><dd>{preview.evidence.vatAmount ?? "Not read"}{preview.evidence.vatRate && <span>{preview.evidence.vatRate}%</span>}</dd></div>
        <div><dt>Printed total</dt><dd>{preview.evidence.total ?? "Not read"} {preview.evidence.currency ?? ""}</dd></div>
      </dl>
      {!preview.vendor && preview.evidence.vendorName && <p>Choose the matching supplier from Vendor Name. No supplier has been selected automatically.</p>}
      {preview.evidence.jobNumber && jobNumber && preview.evidence.jobNumber.toUpperCase().replace(/^JOB[- ]?/, "") !== jobNumber.toUpperCase().replace(/^JOB[- ]?/, "") &&
        <Notice>Printed job reference: {preview.evidence.jobNumber}. The selected job remains {jobNumber}; check the original before saving.</Notice>}
      {preview.warnings.length > 0 && <ul className={styles.warnings}>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      <p>Choose Books accounts, taxes and any customer attribution manually. Reading an invoice never saves a bill or records a payment.</p>
    </>}
    <div className="button-row">
      <Button type="button" variant="secondary" size="sm" disabled={reading.waiting || reading.capability.loading || !reading.canRead && reading.available}
        onClick={reading.retry}>{preview || reading.current?.status === "failed" ? "Read originals again" : "Retry automatic reading"}</Button>
      {!reading.manual && <Button type="button" variant="ghost" size="sm" onClick={reading.stop}>Continue manually</Button>}
    </div>
  </div>;
}
