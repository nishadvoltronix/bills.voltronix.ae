export type BillSaveState = {
  status: string;
  syncOperation?: "CREATE_BILL" | "UPDATE_BILL";
  syncRecords?: readonly {
    target?: string;
    status: string;
    externalId?: string | null;
    lastError?: string | null;
  }[];
};

/** The same provider-confirmation rules apply on bill detail and repeat entry. */
export function savedBillNotice(bill: BillSaveState, manualEntryOnly: boolean): { tone: "info" | "success" | "error"; message: string } {
  if (manualEntryOnly)
    return { tone: "success", message: ["DRAFT", "REJECTED"].includes(bill.status)
      ? "Draft saved. Open it again to finish entering the bill."
      : "Bill saved successfully." };
  if (["DRAFT", "REJECTED"].includes(bill.status))
    return { tone: "success", message: "Draft saved. It has not been sent to Zoho Books." };
  const sync = bill.syncRecords?.find(record => record.target === "ZOHO");
  if (bill.syncOperation === "UPDATE_BILL") {
    if (sync?.status === "SYNCED" && sync.externalId)
      return { tone: "success", message: "Bill changes saved and synchronized with Zoho Books." };
    if (sync?.status === "PENDING")
      return { tone: "info", message: "Bill changes saved. Zoho Books update queued. Confirmation of the changes is pending." };
    if (sync?.status === "UNKNOWN")
      return { tone: "error", message: "Bill changes saved. The Zoho Books update result is uncertain. Reconcile the existing bill before retrying." };
    return { tone: "error", message: `Bill changes saved, but the changes have not synchronized with Zoho Books. ${sync?.lastError || "Check the synchronization details before retrying the update."}` };
  }
  if (sync?.status === "SYNCED" && sync.externalId)
    return { tone: "success", message: "Bill saved and synchronized with Zoho Books." };
  if (sync?.status === "PENDING")
    return { tone: "info", message: sync.externalId
      ? "Bill created in Zoho Books. Attachment synchronization is still pending."
      : "Bill saved. Zoho Books synchronization queued. Provider confirmation is pending." };
  if (sync?.status === "UNKNOWN")
    return { tone: "error", message: "Bill saved. The Zoho Books result is uncertain. Reconcile this bill before retrying." };
  if (sync?.externalId)
    return { tone: "error", message: "Bill created in Zoho Books, but synchronization is incomplete. Check the synchronization details below." };
  return { tone: "error", message: `Bill saved, but it has not synchronized with Zoho Books. ${sync?.lastError || "Books synchronization is not ready for this bill. Check the synchronization details below."}` };
}

/** Keep only safe outcome fields after proving the response is this exact bill. */
export function savedBillState(value: unknown, expected: { id: string; companyId: string; jobId: string }): BillSaveState | null {
  if (!value || typeof value !== "object") return null;
  const bill = value as Record<string, unknown>;
  if (bill.id !== expected.id || bill.companyId !== expected.companyId || bill.jobId !== expected.jobId ||
    typeof bill.status !== "string" || !["DRAFT", "REJECTED", "PENDING_APPROVAL", "READY", "APPROVED", "CANCELLED"].includes(bill.status) ||
    !Array.isArray(bill.syncRecords)) return null;
  if (bill.syncOperation !== undefined && !["CREATE_BILL", "UPDATE_BILL"].includes(String(bill.syncOperation))) return null;
  const records = [];
  for (const value of bill.syncRecords) {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (typeof record.target !== "string" || typeof record.status !== "string" ||
      (record.externalId !== undefined && record.externalId !== null && typeof record.externalId !== "string") ||
      (record.lastError !== undefined && record.lastError !== null && typeof record.lastError !== "string")) return null;
    records.push({ target: record.target, status: record.status,
      externalId: typeof record.externalId === "string" ? record.externalId : null,
      lastError: typeof record.lastError === "string" ? record.lastError : null });
  }
  return { status: bill.status, syncRecords: records,
    ...(bill.syncOperation === "CREATE_BILL" || bill.syncOperation === "UPDATE_BILL" ? { syncOperation: bill.syncOperation } : {}) };
}
