import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  actOnBill,
  createBill,
  getBill,
  listBills,
  updateBill,
} from "@/lib/services/bills";
import {
  auditEvents,
  createJob,
  createVendor,
  dashboard,
  getJob,
} from "@/lib/services/catalog";
import { attachDocument, downloadDocument } from "@/lib/services/documents";
import { syncProvider } from "@/lib/services/integrations";
import { hashPassword } from "@/lib/password";
import { expenseReport, exportExpenseReport } from "@/lib/services/reports";
import { assertMySqlTestDatabase, createTestCompany } from "./company-fixtures";

const cookieState = vi.hoisted(() => ({
  values: new Map<string, string>(),
  options: {} as Record<string, unknown>,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieState.values.has(name)
        ? { value: cookieState.values.get(name) }
        : undefined,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      cookieState.values.set(name, value);
      cookieState.options = options;
    },
    delete: (name: string) => cookieState.values.delete(name),
  }),
}));

let staff: Actor;
let otherStaff: Actor;
let accounts: Actor;
let admin: Actor;
let management: Actor;
let vendorId: string;
let jobId: string;
let usdJobId: string;
const tag = randomUUID().slice(0, 8);

describe("permissioned expense reports", () => {
  it("reconciles filtered reports to finalized records and preserves lifetime budgets", async () => {
    const job = await createJob(admin, {
      jobNumber: `REPORT-${tag}`,
      name: "Fictional report project",
      customer: "Fictional customer",
      contractValue: "1000.00",
      currency: "AED",
    });
    const bill = await createBill(
      staff,
      input({
        jobId: job.id,
        invoiceNumber: `REPORT-${tag}`,
        invoiceDate: "2026-10-12",
        submit: true,
      }),
    );
    expect(bill.status).toBe("READY");
    await createBill(
      staff,
      input({ jobId: job.id, invoiceDate: "2026-11-01" }),
    );
    const filters = new URLSearchParams({
      currency: "AED",
      jobId: job.id,
      from: "2026-10-01",
      to: "2026-10-31",
      vendorId,
      category: "MATERIALS",
    });
    const report = await expenseReport(management, filters);
    expect(report.count).toBe(1);
    expect(report.totals).toEqual({
      invoiced: "199.50",
      recognized: "190.00",
      paid: "0.00",
      outstanding: "199.50",
    });
    expect(report.rows[0].invoiceNumber).toBe(`REPORT-${tag}`);
    expect(exportExpenseReport(report)).toContain(`REPORT-${tag}`);
    filters.set("from", "2026-11-01");
    filters.set("to", "2026-11-30");
    const november = await expenseReport(management, filters);
    expect(november.count).toBe(1);
    expect(november.totals.recognized).toBe("0.00");
    const lifetime = await getJob(management, job.id);
    expect(lifetime.job.recognizedExpenses).toBe("190.00");
    expect(lifetime.job.estimatedProfit).toBe("810.00");
    await expect(expenseReport(staff, filters)).rejects.toMatchObject({
      status: 403,
    });
  });
});

const input = (changes: Record<string, unknown> = {}) => ({
  vendorId,
  jobId,
  invoiceNumber: `TEST-${tag}-${randomUUID()}`,
  invoiceDate: "2026-10-27",
  category: "MATERIALS",
  currency: "AED",
  discount: "10.00",
  vatRate: "5",
  lines: [
    {
      description: "Fictional testing materials",
      quantity: "2",
      unitPrice: "100.00",
    },
  ],
  submit: false,
  ...changes,
});

beforeAll(async () => {
  assertMySqlTestDatabase();
  process.env.UPLOAD_DIR = path.resolve(".local", `test-uploads-${tag}`);
  process.env.APP_URL = "http://127.0.0.1:3000";
  const passwordHash = await hashPassword("Fictional-test-password-928!");
  const actors = await Promise.all(
    (
      ["DATA_ENTRY", "DATA_ENTRY", "ACCOUNTS", "ADMIN", "MANAGEMENT"] as const
    ).map((role, index) =>
      db.user.create({
        data: {
          email: `test-${tag}-${index}@example.invalid`,
          name: `Fictional ${role} ${index}`,
          role,
          passwordHash,
        },
      }),
    ),
  );
  [staff, otherStaff, accounts, admin, management] = actors;
  await createTestCompany(`manual workflows ${tag}`, actors);
  vendorId = (
    await createVendor(admin, {
      name: `Fictional Test Vendor ${tag}`,
      currency: "AED",
    })
  ).id;
  jobId = (
    await createJob(admin, {
      jobNumber: `TEST-${tag}`,
      name: "Fictional testing project",
      customer: "Fictional test customer",
      contractValue: "1000.00",
      currency: "AED",
    })
  ).id;
  usdJobId = (
    await createJob(admin, {
      jobNumber: `USD-${tag}`,
      name: "Fictional USD project",
      customer: "Fictional customer",
      contractValue: "2000.00",
      currency: "USD",
    })
  ).id;
});
afterAll(async () => {
  await db.$disconnect();
});

describe("core bill workflow on real MySQL", () => {
  it("manual-only finalization persists totals and payments without queueing any integration work", async () => {
    vi.stubEnv("MANUAL_ENTRY_ONLY", "true");
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Manual entry must not use external networking."); });
    try {
      const job = await createJob(admin, { jobNumber: `MANUAL-${tag}`, name: "Manual deployment project",
        customer: "Fictional local customer", contractValue: "1000.00", currency: "AED" });
      const draft = await createBill(staff, input({ jobId: job.id }));
      const saved = await actOnBill(staff, draft.id, { action: "submit", version: draft.version });
      expect(saved).toMatchObject({ status: "READY", total: "199.50", paidAmount: "0.00" });
      expect(saved.syncRecords.every(record => record.status === "NOT_CONFIGURED" && !record.lastError)).toBe(true);
      expect(await db.integrationJob.count({ where: { billId: saved.id } })).toBe(0);
      expect(await db.auditLog.count({ where: { entityId: saved.id, action: "SYNC_CONFIGURATION_BLOCKED" } })).toBe(0);
      expect((await getJob(accounts, job.id)).job).toMatchObject({ recognizedExpenses: "190.00", outstanding: "199.50" });
      await actOnBill(accounts, saved.id, { action: "payment", version: saved.version, amount: "50.00", reference: `MANUAL-PAY-${tag}` });
      expect((await getBill(staff, saved.id))).toMatchObject({ status: "READY", paidAmount: "50.00", outstanding: "149.50" });
      expect((await expenseReport(management, new URLSearchParams({ jobId: job.id, currency: "AED" }))).totals)
        .toEqual({ invoiced: "199.50", recognized: "190.00", paid: "50.00", outstanding: "149.50" });
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("persists recalculated lines, canonical bill, audit and unsynchronized destinations atomically", async () => {
    const bill = await createBill(staff, input());
    expect(bill.total).toBe("199.50");
    expect(bill.subtotal).toBe("200.00");
    expect(bill.vatAmount).toBe("9.50");
    expect(bill.status).toBe("DRAFT");
    expect(bill.syncRecords).toHaveLength(2);
    expect(
      bill.syncRecords.every((record) => record.status === "NOT_CONFIGURED"),
    ).toBe(true);
    expect((await getBill(staff, bill.id)).auditLogs[0].action).toBe(
      "BILL_CREATED",
    );
    await expect(
      syncProvider("ZOHO").createApprovedBill({
        internalBillId: bill.id,
        approvedVersion: bill.version,
        idempotencyKey: bill.id,
      }),
    ).rejects.toThrow();
    expect(await db.bill.findUnique({ where: { id: bill.id } })).not.toBeNull();
  });

  it("rejects duplicate normalized invoices including simultaneous submissions", async () => {
    const number = `DUPLICATE-${tag}`;
    await createBill(staff, input({ invoiceNumber: number }));
    await expect(
      createBill(staff, input({ invoiceNumber: ` ${number.toLowerCase()} ` })),
    ).rejects.toMatchObject({ code: "P2002" });
    const concurrent = input({ invoiceNumber: `RACE-${tag}` });
    const results = await Promise.allSettled([
      createBill(staff, concurrent),
      createBill(staff, concurrent),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await db.bill.count({
        where: {
          vendorId,
          normalizedInvoiceNumber: `RACE-${tag}`.toUpperCase(),
        },
      }),
    ).toBe(1);
  });

  it("persists order references and calculated terms through edits with complete audit history", async () => {
    const original = input({
      invoiceDate: "2026-12-20",
      orderNumber: " PO-ORIGINAL ",
      paymentTerms: "NET_15",
      description: "Preserved invoice summary",
    });
    const draft = await createBill(staff, original);
    expect(draft.orderNumber).toBe("PO-ORIGINAL");
    expect(draft.paymentTerms).toBe("NET_15");
    expect(draft.dueDate).toBe("2027-01-04");
    const edited = await updateBill(staff, draft.id, {
      ...original,
      invoiceDate: "2026-12-25",
      orderNumber: "PO-REVISED",
      paymentTerms: "NET_30",
      version: draft.version,
    });
    expect(edited.dueDate).toBe("2027-01-24");
    const history = await getBill(staff, draft.id);
    expect(history.auditLogs[0].details).toEqual(
      expect.objectContaining({
        before: expect.objectContaining({
          orderNumber: "PO-ORIGINAL",
          paymentTerms: "NET_15",
          dueDate: "2027-01-04",
        }),
        after: expect.objectContaining({
          orderNumber: "PO-REVISED",
          paymentTerms: "NET_30",
          dueDate: "2027-01-24",
        }),
      }),
    );

    // An older client omitting the new fields must not erase reviewed metadata.
    const legacyEdit = input({
      invoiceNumber: original.invoiceNumber,
      invoiceDate: "2026-12-26",
      version: edited.version,
    });
    const preserved = await updateBill(staff, draft.id, legacyEdit);
    expect(preserved.orderNumber).toBe("PO-REVISED");
    expect(preserved.paymentTerms).toBe("NET_30");
    expect(preserved.dueDate).toBe("2027-01-25");
    expect(preserved.description).toBe("Preserved invoice summary");
    await expect(
      updateBill(staff, draft.id, {
        ...legacyEdit,
        version: preserved.version,
        paymentTerms: "NET_30",
        dueDate: "2027-01-26",
      }),
    ).rejects.toThrow();
    expect((await getBill(staff, draft.id)).version).toBe(preserved.version);
  });

  it("preserves a legacy custom due date on edits and supports explicitly clearing the order reference", async () => {
    const original = input({ orderNumber: "PO-LEGACY", dueDate: "2026-11-16" });
    const draft = await createBill(staff, original);
    expect(draft.paymentTerms).toBe("CUSTOM");
    const edited = await updateBill(
      staff,
      draft.id,
      input({
        invoiceNumber: original.invoiceNumber,
        orderNumber: "",
        version: draft.version,
      }),
    );
    expect(edited.orderNumber).toBeNull();
    expect(edited.paymentTerms).toBe("CUSTOM");
    expect(edited.dueDate).toBe("2026-11-16");
    await expect(
      updateBill(staff, draft.id, {
        ...original,
        version: edited.version,
        paymentTerms: null,
      }),
    ).rejects.toThrow();
    expect((await getBill(staff, draft.id)).version).toBe(edited.version);
  });

  it("enforces role scope on read, write, and management operations", async () => {
    const bill = await createBill(staff, input());
    await expect(getBill(otherStaff, bill.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(createBill(management, input())).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      createVendor(staff, { name: "Forbidden Vendor" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createJob(accounts, { jobNumber: "FORBIDDEN" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(auditEvents(staff)).rejects.toMatchObject({ status: 403 });
    expect(
      (
        await listBills(
          otherStaff,
          new URLSearchParams({ q: bill.invoiceNumber }),
        )
      ).total,
    ).toBe(0);
    expect((await getJob(staff, jobId)).job.contractValue).toBeNull();
  });

  it("finalizes without a separate approver, leaves payment untouched and protects stale edits", async () => {
    const original = input();
    const draft = await createBill(staff, original);
    const edited = await updateBill(staff, draft.id, {
      ...original,
      notes: "Corrected",
      version: draft.version,
    });
    expect(edited.version).toBe(draft.version + 1);
    const history = await getBill(staff, draft.id);
    expect(history.auditLogs[0].details).toEqual(
      expect.objectContaining({
        after: expect.objectContaining({
          notes: "Corrected",
          invoiceDate: "2026-10-27",
          vatRate: "5",
          lines: expect.arrayContaining([
            expect.objectContaining({
              description: "Fictional testing materials",
              quantity: "2",
              unitPrice: "100",
            }),
          ]),
        }),
      }),
    );
    await expect(
      updateBill(staff, draft.id, { ...original, version: draft.version }),
    ).rejects.toMatchObject({ status: 409 });
    const ready = await actOnBill(staff, draft.id, {
      action: "submit",
      version: edited.version,
    });
    await expect(
      actOnBill(staff, draft.id, {
        action: "approve",
        version: ready.version,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(ready).toMatchObject({
      status: "READY",
      approvedById: null,
      approvedAt: null,
      paidAmount: "0.00",
    });
    expect(await db.payment.count({ where: { billId: draft.id } })).toBe(0);
    expect(
      await db.auditLog.count({
        where: { entityId: draft.id, action: "BILL_APPROVE" },
      }),
    ).toBe(0);
    expect(
      await db.auditLog.count({
        where: {
          entityId: draft.id,
          actorId: staff.id,
          action: "BILL_FINALIZED",
        },
      }),
    ).toBe(1);
    await expect(
      updateBill(staff, draft.id, { ...original, version: ready.version }),
    ).rejects.toMatchObject({ status: 403 });
    const own = await createBill(accounts, input({ submit: true }));
    expect(own).toMatchObject({
      status: "READY",
      approvedById: null,
      approvedAt: null,
    });
    await expect(
      actOnBill(accounts, own.id, { action: "approve", version: own.version }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("tracks partial/full payments, blocks overpayment, and rolls back rejected mutations", async () => {
    let bill = await createBill(staff, input({ submit: true }));
    bill = await actOnBill(accounts, bill.id, {
      action: "payment",
      version: bill.version,
      amount: "50",
      reference: `PAY-${tag}-1`,
    });
    expect(bill.paymentStatus).toBe("PARTIALLY_PAID");
    const before = await db.payment.count({ where: { billId: bill.id } });
    await expect(
      actOnBill(accounts, bill.id, {
        action: "payment",
        version: bill.version,
        amount: "1",
        reference: ` pay-${tag}-1 `,
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      actOnBill(accounts, bill.id, {
        action: "payment",
        version: bill.version,
        amount: "200",
        reference: "TOO-MUCH",
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await db.payment.count({ where: { billId: bill.id } })).toBe(before);
    expect((await getBill(accounts, bill.id)).version).toBe(bill.version);
    await expect(
      actOnBill(accounts, bill.id, {
        action: "cancel",
        version: bill.version,
        reason: "Cannot reverse a payment",
      }),
    ).rejects.toMatchObject({ status: 409 });
    bill = await actOnBill(accounts, bill.id, {
      action: "payment",
      version: bill.version,
      amount: "149.50",
      reference: `PAY-${tag}-2`,
    });
    expect(bill.paymentStatus).toBe("PAID");
    expect(bill.outstanding).toBe("0.00");
  });

  it("recognizes finalized net costs immediately and removes cancelled costs", async () => {
    const before = (await getJob(accounts, jobId)).job.recognizedExpenses;
    const bill = await createBill(staff, input({ submit: true }));
    expect(Number((await getJob(accounts, jobId)).job.recognizedExpenses)).toBe(
      Number(before) + 190,
    );
    const cancelled = await actOnBill(accounts, bill.id, {
      action: "cancel",
      version: bill.version,
      reason: "Fictional cancellation",
    });
    expect(cancelled.outstanding).toBe("0.00");
    expect((await getJob(accounts, jobId)).job.recognizedExpenses).toBe(before);
  });

  it("rejects unknown jobs, mixed currencies, invalid totals, and untrusted calculated fields", async () => {
    await expect(
      createBill(staff, input({ jobId: "missing-job" })),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      createBill(staff, input({ jobId: usdJobId })),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      createBill(staff, input({ discount: "999.00" })),
    ).rejects.toMatchObject({ status: 422 });
    await expect(createBill(staff, input({ total: "0.01" }))).rejects.toThrow();
  });

  it("supports finalized/payment/date filters and safe job currency totals", async () => {
    const result = await listBills(
      accounts,
      new URLSearchParams({
        jobId,
        status: "READY",
        paymentStatus: "PAID",
        dateFrom: "2026-10-01",
        dateTo: "2026-10-31",
        sort: "total_desc",
      }),
    );
    expect(result.bills.length).toBeGreaterThan(0);
    expect(
      result.bills.every(
        (bill) => bill.paymentStatus === "PAID" && bill.status === "READY",
      ),
    ).toBe(true);
    const data = await dashboard(
      management,
      new URLSearchParams({ currency: "USD", jobId: usdJobId }),
    );
    expect(data.metrics.jobValue).toBe("2000.00");
    expect(data.metrics.recognizedExpenses).toBe("0.00");
    const restricted = await dashboard(
      staff,
      new URLSearchParams({ currency: "AED" }),
    );
    expect(restricted.metrics.jobValue).toBeNull();
    expect(restricted.metrics.estimatedProfit).toBeNull();
  });

  it("stores documents privately and denies unauthorized download or finalized-document changes", async () => {
    const bill = await createBill(staff, input());
    const document = await attachDocument(
      staff,
      bill.id,
      new File(["%PDF-1.4\nFictional test document\n%%EOF"], "../invoice.pdf", {
        type: "application/pdf",
      }),
    );
    expect(document.fileName).toBe("invoice.pdf");
    expect(document).not.toHaveProperty("storageKey");
    expect(
      (await downloadDocument(staff, document.id)).bytes.toString(),
    ).toContain("Fictional");
    await expect(
      downloadDocument(otherStaff, document.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      attachDocument(
        staff,
        bill.id,
        new File(["<svg>malicious content</svg>"], "invoice.pdf", {
          type: "application/pdf",
        }),
      ),
    ).rejects.toMatchObject({ status: 415 });
    const current = await getBill(staff, bill.id);
    const ready = await actOnBill(staff, bill.id, {
      action: "submit",
      version: current.version,
    });
    expect(ready.status).toBe("READY");
    expect(ready.documents.map((item) => item.id)).toContain(document.id);
    await expect(
      attachDocument(
        staff,
        bill.id,
        new File(["%PDF-1.4\nChanged"], "changed.pdf", {
          type: "application/pdf",
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("recovers a lost attachment response once and refuses unseen concurrent edits", async () => {
    const payload = input();
    const bill = await createBill(staff, payload);
    const file = new File(
      ["%PDF-1.4\nFictional retry original\n%%EOF"],
      "retry.pdf",
      { type: "application/pdf" },
    );
    const first = await attachDocument(staff, bill.id, file, bill.version);
    expect(first).toMatchObject({
      billVersion: bill.version + 1,
      alreadyAttached: false,
    });
    const retry = await attachDocument(staff, bill.id, file, bill.version);
    expect(retry).toMatchObject({
      id: first.id,
      billVersion: first.billVersion,
      alreadyAttached: true,
    });
    expect(await db.document.count({ where: { billId: bill.id } })).toBe(1);
    expect(
      await db.auditLog.count({
        where: { entityId: bill.id, action: "DOCUMENT_ATTACHED" },
      }),
    ).toBe(1);
    await updateBill(staff, bill.id, {
      ...payload,
      version: first.billVersion,
      notes: "Concurrent unseen correction",
    });
    await expect(
      attachDocument(staff, bill.id, file, first.billVersion),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      actOnBill(staff, bill.id, {
        action: "submit",
        version: first.billVersion,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await getBill(staff, bill.id)).status).toBe("DRAFT");
    expect(await db.integrationJob.count({ where: { billId: bill.id } })).toBe(
      0,
    );
  });

  it("rejects public and Next static document storage configurations", async () => {
    const bill = await createBill(staff, input());
    const previous = process.env.UPLOAD_DIR;
    try {
      for (const directory of ["public/invoices", ".next/static/invoices"]) {
        process.env.UPLOAD_DIR = path.resolve(directory);
        await expect(
          attachDocument(
            staff,
            bill.id,
            new File(["%PDF-1.4\nFictional"], "invoice.pdf", {
              type: "application/pdf",
            }),
          ),
        ).rejects.toMatchObject({ status: 503 });
      }
    } finally {
      process.env.UPLOAD_DIR = previous;
    }
    expect(await db.document.count({ where: { billId: bill.id } })).toBe(0);
  });
});

describe("database-backed sessions", () => {
  it("issues hashed, expiring, httpOnly sessions, checks active users, and revokes logout", async () => {
    const { signIn, getCurrentUser, signOut, SESSION_COOKIE } =
      await import("@/lib/auth");
    expect(await getCurrentUser()).toBeNull();
    await signIn(staff.email, "Fictional-test-password-928!");
    const token = cookieState.values.get(SESSION_COOKIE)!;
    expect(cookieState.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
    const stored = await db.session.findFirstOrThrow({
      where: { userId: staff.id },
    });
    expect(stored.tokenHash).not.toBe(token);
    expect((await getCurrentUser())?.id).toBe(staff.id);
    await db.user.update({ where: { id: staff.id }, data: { active: false } });
    expect(await getCurrentUser()).toBeNull();
    await db.user.update({ where: { id: staff.id }, data: { active: true } });
    await db.session.update({
      where: { id: stored.id },
      data: { expiresAt: new Date(0) },
    });
    expect(await getCurrentUser()).toBeNull();
    await signOut();
    expect(await getCurrentUser()).toBeNull();
    expect(await db.session.count({ where: { userId: staff.id } })).toBe(0);
  });
  it("rate limits repeated failed sign-ins without revealing whether an account exists", async () => {
    const { signIn } = await import("@/lib/auth");
    const email = `absent-${tag}@example.invalid`;
    for (let index = 0; index < 5; index++)
      await expect(
        signIn(email, "incorrect-test-password"),
      ).rejects.toMatchObject({
        status: 401,
        message: "The email or password is incorrect.",
      });
    await expect(
      signIn(email, "incorrect-test-password"),
    ).rejects.toMatchObject({ status: 429 });
  });
  it("fails closed when production origin does not use HTTPS", async () => {
    const { signIn, getCurrentUser } = await import("@/lib/auth");
    process.env.APP_ENV = "production";
    try {
      await expect(
        signIn(staff.email, "Fictional-test-password-928!"),
      ).rejects.toMatchObject({ status: 503 });
      await expect(getCurrentUser()).rejects.toMatchObject({ status: 503 });
    } finally {
      process.env.APP_ENV = "test";
    }
  });
  it("protects HTTP handlers and rejects cross-origin mutations", async () => {
    cookieState.values.clear();
    const bills = await import("@/app/api/bills/route");
    const documents = await import("@/app/api/documents/[id]/route");
    expect(
      (await bills.GET(new Request("http://127.0.0.1:3000/api/bills"))).status,
    ).toBe(401);
    expect(
      (
        await documents.GET(
          new Request("http://127.0.0.1:3000/api/documents/unknown"),
          { params: Promise.resolve({ id: "unknown" }) },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await bills.POST(
          new Request("http://127.0.0.1:3000/api/bills", {
            method: "POST",
            headers: {
              origin: "https://attacker.example",
              "content-type": "application/json",
            },
            body: JSON.stringify(input()),
          }),
        )
      ).status,
    ).toBe(403);
  });
});
