import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BillStatus } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { actOnBill } from "@/lib/services/bills";
import { assertMySqlTestDatabase, createTestCompany } from "./company-fixtures";

const tag = randomUUID().slice(0, 8);
const fixedDate = new Date("2026-11-06T00:00:00.000Z");
let admin: Actor, accounts: Actor, staff: Actor;
let companyId: string, vendorId: string, jobId: string;

async function fixture(status: BillStatus = "READY", paidAmount = "750.00", confirmedHistory = false, owner = staff) {
  const invoiceNumber = `FICTIONAL-CANCEL-HISTORY-${tag}-${randomUUID()}`;
  const bill = await db.bill.create({ data: {
    companyId, vendorId, jobId, createdById: owner.id, invoiceNumber, normalizedInvoiceNumber: invoiceNumber,
    invoiceDate: fixedDate, category: "MATERIALS", currency: "AED", status, version: 4,
    subtotal: "750.00", discount: "0.00", vatRate: "0.00", vatAmount: "0.00", total: "750.00", paidAmount,
    ...(status === "APPROVED" ? { approvedById: admin.id, approvedAt: fixedDate } : {}),
    lines: { create: { description: "FICTIONAL original historical materials", quantity: "5.000", unitPrice: "150.00", lineTotal: "750.00" } },
    documents: { create: { storageKey: `${randomUUID()}.pdf`, fileName: "fictional-original.pdf", mimeType: "application/pdf",
      byteSize: 123, sha256: createHash("sha256").update(invoiceNumber).digest("hex"), uploadedById: owner.id } },
  } });
  if (Number(paidAmount) > 0) {
    const payment = await db.payment.create({ data: { billId: bill.id, amount: paidAmount, createdById: owner.id,
      reference: `FICTIONAL-ORIGINAL-PAYMENT-${tag}`, paymentDate: fixedDate, paymentMode: "Cash", paidThroughAccountId: "9000001" } });
    if (confirmedHistory) {
      await db.paymentBooksSync.create({ data: { paymentId: payment.id, billId: bill.id, companyId, initiatedById: owner.id,
        organizationId: "9950000001", dataCenter: "US", environment: "sandbox", status: "SYNCED", snapshot: { fictional: true, amount: paidAmount },
        sourceHash: "a".repeat(64), externalBillId: bill.id, externalPaymentId: payment.id, attempts: 1, submittedAt: fixedDate, completedAt: fixedDate } });
      await db.syncRecord.create({ data: { billId: bill.id, target: "ZOHO", organizationId: "9950000001", status: "SYNCED",
        externalId: bill.id, attempts: 1, lastSyncedAt: fixedDate } });
      await db.integrationJob.create({ data: { billId: bill.id, target: "ZOHO", operation: "CREATE_BILL", status: "SUCCEEDED",
        organizationId: "9950000001", initiatedById: owner.id, sourceVersion: 4, idempotencyKey: `FICTIONAL:${bill.id}`,
        snapshot: { fictional: true, billId: bill.id, sourceVersion: 4 }, payloadHash: "b".repeat(64), externalId: bill.id, attempts: 1, completedAt: fixedDate,
        history: { create: { operation: "CREATE_BILL", outcome: "SUCCEEDED", externalId: bill.id, startedAt: fixedDate, finishedAt: fixedDate } } } });
    }
  }
  await db.auditLog.create({ data: { actorId: owner.id, companyId, action: "FICTIONAL_ORIGINAL_HISTORY", entityType: "Bill", entityId: bill.id,
    details: { version: 4, subtotal: "750.00", total: "750.00", paidAmount } } });
  return bill;
}

async function ledger(id: string) {
  const bill = await db.bill.findUniqueOrThrow({ where: { id }, include: {
    lines: { orderBy: { id: "asc" } }, payments: { orderBy: { id: "asc" } }, documents: { orderBy: { id: "asc" } },
    paymentBooksSyncs: { orderBy: { id: "asc" } }, syncRecords: { orderBy: { id: "asc" } },
    integrationJobs: { orderBy: { id: "asc" }, include: { history: { orderBy: { id: "asc" } } } },
  } });
  const audits = await db.auditLog.findMany({ where: { companyId, entityType: "Bill", entityId: id }, orderBy: { id: "asc" } });
  return JSON.parse(JSON.stringify({ bill, audits }));
}

beforeAll(async () => {
  assertMySqlTestDatabase();
  const actors = await Promise.all((["ADMIN", "ACCOUNTS", "DATA_ENTRY"] as const).map(role => db.user.create({ data: {
    email: `cancel-history-${role}-${tag}@example.invalid`, name: `FICTIONAL history ${role}`, role, passwordHash: "fixture-no-login",
  } })));
  [admin, accounts, staff] = actors;
  companyId = (await createTestCompany(`cancelled history ${tag}`, actors)).id;
  vendorId = (await db.vendor.create({ data: { companyId, name: `FICTIONAL history supplier ${tag}`, currency: "AED" } })).id;
  jobId = (await db.job.create({ data: { companyId, jobNumber: `FICTIONAL-HISTORY-${tag}`, name: "FICTIONAL original job", customer: "FICTIONAL", currency: "AED" } })).id;
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No provider network is allowed in this local history fixture."); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
afterAll(async () => { await db.$disconnect(); });

describe("cancelled bill payment-history constraint", () => {
  it("retains the enforced named check and only the finalized/history payment states", async () => {
    const rows = await db.$queryRaw<Array<{ name: string; enforced: string; clause: string }>>`
      SELECT tc.CONSTRAINT_NAME AS name, tc.ENFORCED AS enforced, cc.CHECK_CLAUSE AS clause
      FROM information_schema.TABLE_CONSTRAINTS tc
      JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_SCHEMA=DATABASE() AND tc.CONSTRAINT_NAME='Bill_payments_only_approved'`;
    expect(rows).toHaveLength(1); expect(rows[0].enforced).toBe("YES");
    expect(rows[0].clause).toContain("paidAmount");
    // MySQL may escape literal quotes or add charset introducers in metadata.
    // Check the exact state names; the negative writes below verify semantics.
    expect(rows[0].clause.toUpperCase().match(/\b(READY|APPROVED|CANCELLED|DRAFT|REJECTED|PENDING_APPROVAL)\b/g))
      .toEqual(["READY", "APPROVED", "CANCELLED"]);
  });

  it.each(["READY", "APPROVED"] as const)("retains every original %s paid ledger row when separately fenced into CANCELLED history", async status => {
    const bill = await fixture(status, "750.00", true), before = await ledger(bill.id);
    const changed = await db.$executeRaw`UPDATE Bill SET status='CANCELLED', version=version+1 WHERE id=${bill.id} AND version=${bill.version}`;
    expect(changed).toBe(1);
    const after = await ledger(bill.id);
    expect(after).toEqual({ ...before, bill: { ...before.bill, status: "CANCELLED", version: before.bill.version + 1 } });
    expect(after.bill.payments).toHaveLength(1); expect(after.bill.payments[0].amount).toBe("750");
    expect(after.bill.paymentBooksSyncs[0].status).toBe("SYNCED");
    expect(after.bill.total).toBe("750"); expect(after.bill.paidAmount).toBe("750");
    expect(after.bill.documents).toHaveLength(1); expect(after.bill.integrationJobs[0].history).toHaveLength(1);
  });

  it.each(["DRAFT", "REJECTED", "PENDING_APPROVAL"] as const)("still rejects positive paidAmount in %s and rolls back every row", async status => {
    const bill = await fixture("READY"), before = await ledger(bill.id);
    await expect(db.$executeRaw`UPDATE Bill SET status=${status} WHERE id=${bill.id}`).rejects.toThrow(/Bill_payments_only_approved/);
    expect(await ledger(bill.id)).toEqual(before);
    await expect(fixture(status, "1.00")).rejects.toThrow(/Bill_payments_only_approved/);
  });

  it("keeps cancelled-history amount bounds instead of permitting negative or excessive payments", async () => {
    const bill = await fixture("READY", "250.00");
    await db.$executeRaw`UPDATE Bill SET status='CANCELLED' WHERE id=${bill.id}`;
    const before = await ledger(bill.id);
    await expect(db.$executeRaw`UPDATE Bill SET paidAmount=-1 WHERE id=${bill.id}`).rejects.toThrow(/Bill_amounts_valid/);
    await expect(db.$executeRaw`UPDATE Bill SET paidAmount=750.01 WHERE id=${bill.id}`).rejects.toThrow(/Bill_amounts_valid/);
    expect(await ledger(bill.id)).toEqual(before);
  });

  it.each(["ADMIN", "ACCOUNTS"] as const)("continues rejecting ordinary %s cancellation of a paid bill without changing payment or audit history", async role => {
    const bill = await fixture("READY", "750.00", false, role === "ADMIN" ? admin : accounts), before = await ledger(bill.id);
    await expect(actOnBill(role === "ADMIN" ? admin : accounts, bill.id, { action: "cancel", version: bill.version,
      reason: "FICTIONAL normal cancellation must remain blocked" })).rejects.toMatchObject({ status: 409,
      message: "Only an unpaid, active bill can be cancelled by Accounts or Admin. Paid bills require a separately reviewed reversal." });
    expect(await ledger(bill.id)).toEqual(before);
  });

  it("continues allowing ordinary cancellation of an unpaid active bill", async () => {
    const bill = await fixture("READY", "0.00");
    const result = await actOnBill(admin, bill.id, { action: "cancel", version: bill.version, reason: "FICTIONAL unpaid cancellation" });
    expect(result).toMatchObject({ id: bill.id, status: "CANCELLED", total: "750.00", paidAmount: "0.00" });
    expect(await db.payment.count({ where: { billId: bill.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { entityId: bill.id, action: "BILL_CANCEL" } })).toBe(1);
  });
});
