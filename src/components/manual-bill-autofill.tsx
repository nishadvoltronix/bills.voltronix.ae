"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { InvoiceAutofillCapability, InvoiceAutofillResponse } from "@/lib/manual-bill-autofill-types";
import { api, errorMessage, useApi } from "./api";
import { Button } from "./ui";
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
  const [revision, setRevision] = useState(0), [pausedKey, setPausedKey] = useState<string | null>(null);
  const paused = useRef<string | null>(null), active = useRef(false), mounted = useRef(true);
  const [settled, setSettled] = useState(0);
  const [reading, setReading] = useState<Reading | null>(null);
  const key = JSON.stringify([companyId, jobId, currency, files.map(file => [file.id, file.file.size, file.file.type])]);
  const current = reading?.key === key ? reading : null;
  const available = capability.data?.enabled === true && capability.data.configured === true;
  const canRead = eligible && !!companyId && !!jobId && files.length > 0 && !checking && available && pausedKey !== key;
  const latest = useRef({ key, revision, canRead });
  useLayoutEffect(() => { latest.current = { key, revision, canRead }; }, [key, revision, canRead]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    callbacks.current.invalidate();
    // A cancelled browser fetch does not release the server's provider lock.
    // Let the active read settle, then read only the newest complete file batch.
    if (!canRead || active.current || current && current.revision === revision && current.status !== "reading") return;
    const isCurrent = () => mounted.current && paused.current !== key && latest.current.canRead &&
      latest.current.key === key && latest.current.revision === revision;
    const timer = setTimeout(async () => {
      if (!isCurrent() || active.current) return;
      active.current = true;
      const requestId = crypto.randomUUID();
      setReading({ key, revision, status: "reading" });
      try {
        const body = new FormData();
        body.set("companyId", companyId); body.set("jobId", jobId); body.set("requestId", requestId);
        for (const file of files) body.append("files", file.file);
        const result = await api<InvoiceAutofillResponse>("/api/bills/autofill", { method: "POST", body });
        if (!isCurrent()) return;
        if (!matchesSource(result, requestId, companyId, jobId, currency, files))
          throw new Error("The reading did not match these originals and the selected job. Retry reading or enter this invoice manually.");
        const applied = callbacks.current.apply(result);
        setReading({ key, revision, status: "ready", preview: result.preview, kept: applied.kept });
      } catch (failure) {
        if (isCurrent()) setReading({ key, revision, status: "failed", message: errorMessage(failure) });
      } finally {
        active.current = false;
        if (mounted.current) setSettled(value => value + 1);
      }
    }, 300);
    return () => clearTimeout(timer);
    // The key binds the exact ordered Files. Form edits update only callbacks,
    // so typing never restarts a provider request or authorizes overwriting them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, canRead, revision, settled]);
  const stop = useCallback(() => {
    paused.current = key; setPausedKey(key);
  }, [key]);
  const retry = () => { paused.current = null; setPausedKey(null); setRevision(value => value + 1); if (!available) capability.reload(); };
  const waiting = eligible && scoped && files.length > 0 && pausedKey !== key && (capability.loading || canRead && (!current || current.status === "reading" || current.revision !== revision));
  const queued = waiting && reading?.status === "reading" && reading.key !== key;
  return { capability, available, current, waiting, queued, canRead, scoped, stop, retry, hasFiles: files.length > 0,
    preview: current?.status === "ready" ? current.preview : undefined };
}

export function ManualBillAutofill({ reading, jobNumber }: { reading: ReturnType<typeof useManualBillAutofill>; jobNumber?: string }) {
  const preview = reading.preview;
  const jobMismatch = preview?.evidence.jobNumber && jobNumber && preview.evidence.jobNumber.toUpperCase().replace(/^JOB[- ]?/, "") !== jobNumber.toUpperCase().replace(/^JOB[- ]?/, "");
  const failed = reading.current?.status === "failed";
  const status = reading.queued ? "Waiting to read all selected pages…" : reading.waiting ? "Reading invoice…" : failed
    ? reading.current?.message : preview ? `Details filled. Review before saving.${reading.current?.kept ? " Your edits were kept." : ""}${preview.warnings.length || jobMismatch ? " Some details need checking." : ""}`
    : !reading.scoped ? "Select a company and job to begin." : !reading.available && !reading.capability.loading
      ? "Unavailable. Enter the invoice details below." : "Add the invoice files to begin.";
  return <div className={styles.panel} aria-label="Invoice automatic reading">
    <h3 className={styles.heading}>AI reading</h3>
    <p className={styles.status} role="status">{reading.waiting && <LoaderCircle size={14} className="spin" />}{status}</p>
    {failed && <Button type="button" variant="ghost" size="sm" disabled={reading.waiting} onClick={reading.retry}>Retry reading</Button>}
  </div>;
}
