import { describe, expect, it } from "vitest";
import { savedBillNotice, savedBillState } from "../src/lib/bill-save-outcome";

const expected = { id: "fictional-saved-bill", companyId: "fictional-company", jobId: "fictional-job" };
const bill = (status: string, externalId: string | null = null, lastError: string | null = null) => ({
  ...expected, status: "READY", syncRecords: [{ target: "ZOHO", status, externalId, lastError }],
});

describe("saved bill provider outcome", () => {
  it("requires a confirmed external identity before reporting synchronization success", () => {
    expect(savedBillNotice(bill("SYNCED", "99001"), false)).toMatchObject({ tone: "success", message: "Bill saved and synchronized with Zoho Books." });
    expect(savedBillNotice(bill("SYNCED"), false)).toMatchObject({ tone: "error" });
  });

  it("distinguishes queued creation from confirmed creation with a pending attachment", () => {
    expect(savedBillNotice(bill("PENDING"), false)).toMatchObject({ tone: "info", message: expect.stringContaining("Provider confirmation is pending") });
    expect(savedBillNotice(bill("PENDING", "99001"), false)).toMatchObject({ tone: "info", message: expect.stringContaining("Attachment synchronization is still pending") });
  });

  it("shows definite rejection and uncertain outcomes without implying another create is safe", () => {
    expect(savedBillNotice(bill("FAILED", null, "Fictional supplier tax configuration needs review."), false)).toMatchObject({
      tone: "error", message: expect.stringContaining("Fictional supplier tax configuration needs review."),
    });
    expect(savedBillNotice(bill("UNKNOWN"), false)).toMatchObject({ tone: "error", message: expect.stringContaining("Reconcile this bill before retrying") });
  });

  it("states that drafts were not sent and keeps manual-only outcomes local", () => {
    expect(savedBillNotice({ ...bill("SYNCED", "99001"), status: "DRAFT" }, false).message).toBe("Draft saved. It has not been sent to Zoho Books.");
    expect(savedBillNotice(bill("NOT_CONFIGURED"), true).message).toBe("Bill saved successfully.");
  });

  it("describes a pending or failed update against an existing ID without claiming attachment completion or another create", () => {
    const update = (status: string) => ({ ...bill(status, "99001", "Fictional update rejected."), syncOperation: "UPDATE_BILL" as const });
    expect(savedBillNotice(update("PENDING"), false)).toMatchObject({ tone: "info", message: expect.stringContaining("Confirmation of the changes is pending") });
    expect(savedBillNotice(update("PENDING"), false).message).not.toMatch(/Attachment|created/);
    expect(savedBillNotice(update("FAILED"), false)).toMatchObject({ tone: "error", message: expect.stringContaining("Fictional update rejected.") });
    expect(savedBillNotice(update("UNKNOWN"), false)).toMatchObject({ tone: "error", message: expect.stringContaining("Reconcile the existing bill") });
    expect(savedBillNotice(update("SYNCED"), false)).toEqual({ tone: "success", message: "Bill changes saved and synchronized with Zoho Books." });
    expect(savedBillNotice({ ...update("SYNCED"), syncRecords: [] }, false).tone).toBe("error");
  });
});

describe("saved outcome response scope", () => {
  it("accepts only the exact bill, company and job before using returned status", () => {
    expect(savedBillState(bill("FAILED"), expected)).toMatchObject({ status: "READY" });
    for (const changed of [{ id: "another-bill" }, { companyId: "another-company" }, { jobId: "another-job" }])
      expect(savedBillState({ ...bill("FAILED"), ...changed }, expected)).toBeNull();
  });

  it("rejects incomplete or invalid data and retains only an independent safe status snapshot", () => {
    expect(savedBillState({ ...expected, status: "READY" }, expected)).toBeNull();
    expect(savedBillState({ ...bill("PENDING"), syncRecords: [{ target: "ZOHO", status: "PENDING", externalId: 99001 }] }, expected)).toBeNull();
    const source = { ...bill("FAILED", null, "Original failure."), notes: "Unrelated private invoice notes." };
    const snapshot = savedBillState(source, expected);
    source.syncRecords[0].lastError = "A later unrelated change.";
    expect(snapshot).toEqual({ status: "READY", syncRecords: [{ target: "ZOHO", status: "FAILED", externalId: null, lastError: "Original failure." }] });
    expect(snapshot).not.toHaveProperty("notes");
    expect(savedBillState({ ...source, syncOperation: "UPDATE_BILL" }, expected)).toMatchObject({ syncOperation: "UPDATE_BILL" });
    expect(savedBillState({ ...source, syncOperation: "UNREVIEWED_OPERATION" }, expected)).toBeNull();
  });
});
