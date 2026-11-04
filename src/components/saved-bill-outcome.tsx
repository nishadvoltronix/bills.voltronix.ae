"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { savedBillNotice, savedBillState, type BillSaveState } from "@/lib/bill-save-outcome";
import { useApi } from "./api";
import { Button, Notice } from "./ui";

export type SavedJobBill = { id: string; invoiceNumber: string; isDraft: boolean; outcome: BillSaveState | null };

export function SavedBillOutcome({ receipt, job, manualEntryOnly }: {
  receipt: SavedJobBill;
  job: { id: string; companyId: string; jobNumber: string };
  manualEntryOnly: boolean;
}) {
  const state = useApi<{ bill: unknown }>(!manualEntryOnly && !receipt.isDraft
    ? `/api/bills/${encodeURIComponent(receipt.id)}` : null, { keepPreviousData: true });
  const expected = { id: receipt.id, companyId: job.companyId, jobId: job.id };
  const current = state.data ? savedBillState(state.data.bill, expected) : null;
  const verificationError = state.error || state.refreshError || (state.data && !current
    ? "The saved bill status did not match this job. Open the saved bill to review its current status." : null);
  const bill = current ?? receipt.outcome ?? (receipt.isDraft || manualEntryOnly
    ? { status: receipt.isDraft ? "DRAFT" : "READY" } : null);
  const outcome = bill ? savedBillNotice(bill, manualEntryOnly) : {
    tone: verificationError ? "error" as const : "info" as const,
    message: verificationError
      ? "Bill saved, but its Zoho Books status could not be checked. Open the saved bill before retrying synchronization."
      : "Bill saved. Checking its Zoho Books status…",
  };
  const pending = !verificationError && bill?.syncRecords?.some(record => record.target === "ZOHO" && record.status === "PENDING");
  const [pollingExpired, setPollingExpired] = useState(false);
  const refreshInFlight = useRef(false);
  const reload = state.reload;
  useEffect(() => { refreshInFlight.current = state.loading || state.refreshing; }, [state.loading, state.refreshing]);
  useEffect(() => {
    if (!pending || pollingExpired || receipt.isDraft || manualEntryOnly) return;
    // Status checks only read the saved bill; they never enqueue or retry writes.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible" && !refreshInFlight.current) reload();
    }, 5000);
    const deadline = setTimeout(() => { clearInterval(interval); setPollingExpired(true); }, 120000);
    return () => { clearInterval(interval); clearTimeout(deadline); };
  }, [pending, pollingExpired, receipt.id, receipt.isDraft, manualEntryOnly, reload]);

  return <Notice tone={verificationError ? "error" : outcome.tone}>
    <strong>{receipt.isDraft ? "Draft" : "Bill"} {receipt.invoiceNumber} saved.</strong>
    <p>{verificationError && bill ? "Last verified result: " : ""}{outcome.message}</p>
    {verificationError && bill && <p role="alert">The latest status could not be verified. {verificationError}</p>}
    {pollingExpired && pending && <p>Confirmation is still pending. Refresh the status or open the saved bill.</p>}
    <p>Enter another bill for {job.jobNumber}. The form is ready for a new invoice.</p>
    <div className="button-row">
      <Link className="text-link" href={`/bills/${encodeURIComponent(receipt.id)}?saved=1`}>View saved bill</Link>
      <Link className="text-link" href={`/jobs/${encodeURIComponent(job.id)}`}>View job history</Link>
      {!manualEntryOnly && !receipt.isDraft && <Button type="button" variant="secondary" size="sm"
        disabled={state.loading || state.refreshing} onClick={() => { setPollingExpired(false); reload(); }}>
        Refresh saved bill status
      </Button>}
    </div>
  </Notice>;
}
