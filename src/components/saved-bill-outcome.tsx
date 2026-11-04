"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { savedBillNotice, savedBillState, type BillSaveState } from "@/lib/bill-save-outcome";
import { useApi } from "./api";
import { Button, Notice } from "./ui";
import type { Bill } from "./types";

export type SavedJobBill = { id: string; invoiceNumber: string; isDraft: boolean; outcome: BillSaveState | null };
export type SavedBillRead = { bill: Bill; refreshing?: boolean; error?: string | null; reload: () => void };

export function SavedBillOutcome({ receipt, job, manualEntryOnly, continuation = "entry", navigationBusy = false, billRead }: {
  receipt: SavedJobBill;
  job: { id: string; companyId: string; jobNumber: string };
  manualEntryOnly: boolean;
  continuation?: "entry" | "payment";
  navigationBusy?: boolean;
  billRead?: SavedBillRead;
}) {
  const state = useApi<{ bill: Bill }>(!billRead && !manualEntryOnly && !receipt.isDraft
    ? `/api/bills/${encodeURIComponent(receipt.id)}` : null, { keepPreviousData: true });
  const data = billRead?.bill ?? state.data?.bill;
  const loading = !billRead && state.loading;
  const refreshing = billRead ? !!billRead.refreshing : state.refreshing;
  const expected = { id: receipt.id, companyId: job.companyId, jobId: job.id };
  const current = data ? savedBillState(data, expected) : null;
  const editEligibility = current ? data?.editEligibility : undefined;
  const verificationError = (billRead ? billRead.error : state.error || state.refreshError) || (data && !current
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
  const pollingStarted = useRef<number | null>(null);
  const reload = billRead?.reload ?? state.reload;
  useEffect(() => { refreshInFlight.current = loading || refreshing; }, [loading, refreshing]);
  useEffect(() => {
    if (!pending || pollingExpired || receipt.isDraft || manualEntryOnly) return;
    const started = pollingStarted.current ?? Date.now();
    pollingStarted.current = started;
    let timer: ReturnType<typeof setTimeout>;
    // Status checks only read the saved bill; they never enqueue or retry writes.
    const tick = () => {
      const elapsed = Date.now() - started;
      if (elapsed >= 120000) { setPollingExpired(true); return; }
      if (!navigationBusy && document.visibilityState === "visible" && !refreshInFlight.current) {
        refreshInFlight.current = true;
        reload();
      }
      timer = setTimeout(tick, Math.min(elapsed < 15000 ? 1000 : 3000, 120000 - elapsed));
    };
    timer = setTimeout(tick, Math.min(Date.now() - started < 15000 ? 1000 : 3000, Math.max(0, 120000 - (Date.now() - started))));
    return () => clearTimeout(timer);
  }, [pending, pollingExpired, receipt.id, receipt.isDraft, manualEntryOnly, navigationBusy, reload]);

  return <Notice tone={verificationError ? "error" : outcome.tone}>
    <strong>{receipt.isDraft ? "Draft" : "Bill"} {receipt.invoiceNumber} saved.</strong>
    <p>{verificationError && bill ? "Last verified result: " : ""}{outcome.message}</p>
    {verificationError && bill && <p role="alert">The latest status could not be verified. {verificationError}</p>}
    {pollingExpired && pending && <p>Confirmation is still pending. Refresh the status or open the saved bill.</p>}
    <p>{continuation === "payment"
      ? `Record a payment below, or add another bill for ${job.jobNumber} without recording a payment.`
      : `Enter another bill for ${job.jobNumber}. The form is ready for a new invoice.`}</p>
    <div className="button-row">
      {navigationBusy ? <span className="text-link" aria-disabled="true">View saved bill</span>
        : <Link className="text-link" href={`/bills/${encodeURIComponent(receipt.id)}?saved=1`}>View saved bill</Link>}
      {(receipt.isDraft || editEligibility?.allowed) && (navigationBusy ? <span className="text-link" aria-disabled="true">Edit saved bill</span>
        : <Link className="text-link" href={`/bills/${encodeURIComponent(receipt.id)}/edit`}>Edit saved bill</Link>)}
      {navigationBusy ? <span className="text-link" aria-disabled="true">View job history</span>
        : <Link className="text-link" href={`/jobs/${encodeURIComponent(job.id)}`}>View job history</Link>}
      {!manualEntryOnly && !receipt.isDraft && <Button type="button" variant="secondary" size="sm"
        disabled={navigationBusy || loading || refreshing} onClick={() => {
          if (refreshInFlight.current || navigationBusy) return;
          pollingStarted.current = null; refreshInFlight.current = true; setPollingExpired(false); reload();
        }}>
        Refresh saved bill status
      </Button>}
    </div>
    {editEligibility?.allowed === false && editEligibility.reason && <p>{editEligibility.reason}</p>}
  </Notice>;
}
