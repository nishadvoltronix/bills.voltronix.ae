import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { IntegrationError } from "@/lib/integrations/config";
import {
  runIncomingBooksSync,
  syncIncomingBooksAttachments,
} from "@/lib/services/incoming-books-sync";
import {
  describeBooksAttachments,
  downloadBooksBillAttachment,
} from "@/lib/services/books-attachments";
import { loadFinancialLedger } from "@/lib/services/financial-ledger";
import type { IncomingSyncInput } from "@/lib/services/incoming-sync-types";
import { assertMySqlTestDatabase } from "./company-fixtures";

type Source = Prisma.InputJsonObject;
const tag = randomUUID().slice(0, 8);
let sequence = 0,
  actor: Actor;
const pdf = Buffer.from("%PDF-1.4\nFictional incoming original\n%%EOF\n");
const document = {
  document_id: "7001",
  file_name: "Original.pdf",
  file_type: "pdf",
  file_size: String(pdf.length),
  uploaded_on: "2026-10-29",
};
const row = (externalId = "1001", extra: Source = {}): Source => ({
  bill_id: externalId,
  vendor_id: "9001",
  vendor_name: "Fictional supplier",
  bill_number: `B-${externalId}`,
  status: "open",
  currency_code: "AED",
  date: "2026-10-01",
  due_date: "2026-11-01",
  total: "105.00",
  balance: "105.00",
  last_modified_time: "2026-10-29T10:00:00+0400",
  ...extra,
});
const detail = (source: Source, extra: Source = {}) => ({
  code: 0,
  bill: {
    ...source,
    sub_total: "100.00",
    tax_total: "5.00",
    payment_made: "0.00",
    vendor_credits_applied: "0.00",
    line_items: [],
    payments: [],
    vendor_credits: [],
    documents: [],
    ...extra,
  },
});
const page = (rows: Source[], number = 1, more = false) => ({
  code: 0,
  bills: rows,
  page_context: { page: number, has_more_page: more },
});
const unavailable = () =>
  new IntegrationError(
    "INCOMING_RATE_LIMITED",
    "Fictional retryable provider limit.",
    "RETRY",
  );
const absent = () =>
  new IntegrationError(
    "INCOMING_REMOTE_NOT_FOUND",
    "Fictional missing provider record.",
    "BLOCKED",
  );
async function context() {
  const organizationId = `88${BigInt(`0x${tag}`).toString()}${++sequence}`;
  const company = await db.company.create({
    data: {
      name: `Fictional incoming ${sequence}`,
      isDemo: false,
      liveAccountingEnabled: true,
      memberships: { create: { userId: actor.id } },
      integrationDestinations: {
        create: {
          target: "ZOHO",
          organizationId,
          dataCenter: "US",
          environment: "production",
          liveEnabled: true,
          verifiedAt: new Date(),
          verificationReference: "Fictional reviewed Books source",
          verifiedConfigurationHash: "a".repeat(64),
        },
      },
    },
  });
  const state: { checkpoint: Prisma.InputJsonValue | null; rows: Source[] } = {
    checkpoint: null,
    rows: [row()],
  };
  const get = vi.fn(
    async (path: string, query?: Record<string, string>): Promise<unknown> => {
      if (path === "/books/v3/bills")
        return page(state.rows, Number(query?.page ?? 1));
      const source = state.rows.find(
        (row) => path === `/books/v3/bills/${row.bill_id}`,
      );
      if (!source) throw absent();
      return detail(source);
    },
  );
  const input: IncomingSyncInput = {
    actor,
    source: {
      target: "ZOHO",
      companyId: company.id,
      organizationId,
      dataCenter: "US",
      environment: "production",
      organizationName: company.name,
    },
    mode: "reconcile",
    watermark: null,
    continuation: null,
    get: async (path, query) =>
      path === `/books/v3/organizations/${organizationId}`
        ? { code: 0, organization: { organization_id: organizationId } }
        : get(path, query),
    maxRequests: 40,
    stopped: () => false,
    assertLease: vi.fn(async () => undefined),
    checkpoint: async (value) => {
      state.checkpoint = value === null ? null : structuredClone(value);
    },
  };
  return { input, state, get, companyId: company.id };
}
async function baseline(c: Awaited<ReturnType<typeof context>>) {
  const result = await runIncomingBooksSync(c.input);
  expect(result.complete).toBe(true);
  c.input.mode = "incremental";
  c.input.watermark = result.watermark!;
  c.input.continuation = null;
  c.get.mockClear();
  return db.booksBill.findFirstOrThrow({ where: { companyId: c.companyId } });
}
const nativeCounts = () =>
  Promise.all([
    db.bill.count(),
    db.payment.count(),
    db.integrationJob.count(),
    db.job.count(),
  ]);
beforeAll(async () => {
  assertMySqlTestDatabase();
  actor = await db.user.create({
    data: {
      email: `incoming-books-${tag}@example.invalid`,
      name: "Fictional incoming operator",
      role: "ADMIN",
      passwordHash: "fixture-unusable",
    },
  });
  vi.stubEnv("ZOHO_BOOKS_WRITE_ENABLED", "true");
  vi.stubEnv("ZOHO_BOOKS_LIVE_ENABLED", "true");
  vi.stubEnv("ALLOW_PRODUCTION_ACCOUNTING_WRITES", "true");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Real provider requests are forbidden in fixtures.");
    }),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await db.$disconnect();
});

describe("incoming Books synchronization with outbound gates enabled", () => {
  it("rolls back run creation when its atomic checkpoint cannot commit", async () => {
    const c = await context();
    const checkpoint = vi.fn(
      async (
        _value: Prisma.InputJsonValue | null,
        tx?: Prisma.TransactionClient,
      ) => {
        expect(tx).toBeDefined();
        throw new Error("Fictional checkpoint crash");
      },
    );
    await expect(
      runIncomingBooksSync({ ...c.input, checkpoint }),
    ).rejects.toThrow("Fictional checkpoint crash");
    expect(
      await db.booksImportRun.count({ where: { companyId: c.companyId } }),
    ).toBe(0);
    expect(c.get).not.toHaveBeenCalled();
  });
  it("resumes a request-bounded page and never creates native financial records", async () => {
    const c = await context(),
      before = await nativeCounts();
    const first = await runIncomingBooksSync({ ...c.input, maxRequests: 2 });
    expect(first.complete).toBe(false);
    expect(c.get).toHaveBeenCalledTimes(1);
    expect(
      await db.booksBill.count({ where: { companyId: c.companyId } }),
    ).toBe(0);
    c.get.mockClear();
    const second = await runIncomingBooksSync({
      ...c.input,
      continuation: c.state.checkpoint,
      maxRequests: 1,
    });
    expect(second).toMatchObject({
      complete: true,
      reconciled: true,
      processed: 1,
    });
    expect(c.get).toHaveBeenCalledTimes(1);
    expect(c.get.mock.calls[0][0]).toBe("/books/v3/bills/1001");
    expect(await nativeCounts()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("updates paid status, payments, credits and details atomically with the modified-time filter", async () => {
    const c = await context();
    await baseline(c);
    c.state.rows = [
      row("1001", {
        status: "paid",
        balance: "0",
        last_modified_time: "2026-10-29T11:00:00+0400",
      }),
    ];
    c.get.mockImplementation(async (path) =>
      path === "/books/v3/bills"
        ? page(c.state.rows)
        : detail(c.state.rows[0], {
            payment_made: "95.00",
            vendor_credits_applied: "10.00",
            payments: [{ payment_id: "5001", amount: "95.00" }],
          }),
    );
    expect((await runIncomingBooksSync(c.input)).complete).toBe(true);
    const bill = await db.booksBill.findFirstOrThrow({
      where: { companyId: c.companyId },
    });
    expect(bill).toMatchObject({
      status: "paid",
      balance: "0",
      paymentMade: "95.00",
      vendorCreditsApplied: "10.00",
    });
    expect(bill.lastImportRunId).toBe(bill.detailImportRunId);
    expect(c.get.mock.calls[0][1]).toMatchObject({
      filter_by: "Status.All",
      sort_column: "created_time",
      sort_order: "A",
      last_modified_time: expect.any(String),
    });
    expect(
      (
        await db.booksImportRun.findUniqueOrThrow({
          where: { id: bill.lastImportRunId },
        })
      ).runKind,
    ).toBe("INCREMENTAL");
  });
  it("keeps unchanged current details without extra detail requests", async () => {
    const c = await context(),
      before = await baseline(c);
    await runIncomingBooksSync(c.input);
    const after = await db.booksBill.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(c.get).toHaveBeenCalledTimes(1);
    expect(after.sourceDetail).toEqual(before.sourceDetail);
    expect(after.detailFetchedAt).toEqual(before.detailFetchedAt);
    expect(after.lastImportRunId).toBe(after.detailImportRunId);
  });
  it("preserves good snapshots and a complete full baseline when a changed detail fetch fails", async () => {
    const c = await context(),
      before = await baseline(c);
    c.get.mockImplementation(async (path) => {
      if (path === "/books/v3/bills")
        return page([
          row("1001", {
            total: "210",
            last_modified_time: "2026-10-29T12:00:00+0400",
          }),
        ]);
      throw unavailable();
    });
    await expect(runIncomingBooksSync(c.input)).rejects.toMatchObject({
      code: "INCOMING_RATE_LIMITED",
    });
    const after = await db.booksBill.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(after.sourceDetail).toEqual(before.sourceDetail);
    expect(after.total).toBe("105.00");
    expect(after.lastImportRunId).toBe(before.lastImportRunId);
    expect(
      (await loadFinancialLedger(actor, c.companyId, "AED"))
        .booksListingComplete,
    ).toBe(true);
    expect(c.state.checkpoint).toMatchObject({
      phase: "LIST",
      pendingIndex: 0,
    });
  });
  it("does not stale unseen bills on incremental pages or on failed deletion confirmation", async () => {
    const c = await context(),
      before = await baseline(c);
    c.state.rows = [];
    await runIncomingBooksSync(c.input);
    expect(
      (await db.booksBill.findUniqueOrThrow({ where: { id: before.id } }))
        .isStale,
    ).toBe(false);
    c.get.mockImplementation(async (path) => {
      if (path === "/books/v3/bills") return page([]);
      throw unavailable();
    });
    await expect(
      runIncomingBooksSync({ ...c.input, mode: "reconcile" }),
    ).rejects.toMatchObject({ code: "INCOMING_RATE_LIMITED" });
    expect(
      (await db.booksBill.findUniqueOrThrow({ where: { id: before.id } }))
        .isStale,
    ).toBe(false);
    c.get.mockImplementation(async () => {
      throw absent();
    });
    await runIncomingBooksSync({
      ...c.input,
      continuation: c.state.checkpoint,
    });
    expect(
      (await db.booksBill.findUniqueOrThrow({ where: { id: before.id } }))
        .isStale,
    ).toBe(true);
  });
  it("recovers a record missed by shifting pagination instead of falsely deleting it", async () => {
    const c = await context(),
      before = await baseline(c);
    c.get.mockImplementation(async (path) =>
      path === "/books/v3/bills" ? page([]) : detail(row()),
    );
    expect(
      (await runIncomingBooksSync({ ...c.input, mode: "reconcile" }))
        .reconciled,
    ).toBe(true);
    expect(
      (await db.booksBill.findUniqueOrThrow({ where: { id: before.id } }))
        .isStale,
    ).toBe(false);
    expect(c.get.mock.calls.map((call) => call[0])).toEqual([
      "/books/v3/bills",
      "/books/v3/bills/1001",
    ]);
  });
  it("rejects cross-source checkpoints and a rebound destination before any read", async () => {
    const first = await context();
    await runIncomingBooksSync({ ...first.input, maxRequests: 1 });
    const other = await context();
    await expect(
      runIncomingBooksSync({
        ...other.input,
        continuation: first.state.checkpoint,
      }),
    ).rejects.toMatchObject({ code: "INCOMING_BOOKS_CHECKPOINT_INVALID" });
    expect(other.get).not.toHaveBeenCalled();
    await db.companyIntegrationDestination.updateMany({
      where: { companyId: first.companyId },
      data: { environment: "sandbox", liveEnabled: false },
    });
    first.get.mockClear();
    await expect(
      runIncomingBooksSync({
        ...first.input,
        continuation: first.state.checkpoint,
      }),
    ).rejects.toMatchObject({ code: "INCOMING_BOOKS_SOURCE_CHANGED" });
    expect(first.get).not.toHaveBeenCalled();
  });
  it("requires the exact provider organization before importing any bill", async () => {
    const c = await context();
    await expect(
      runIncomingBooksSync({
        ...c.input,
        get: async () => ({
          code: 0,
          organization: { organization_id: "999999" },
        }),
      }),
    ).rejects.toMatchObject({ code: "INCOMING_BOOKS_ORGANIZATION_MISMATCH" });
    expect(
      await db.booksBill.count({ where: { companyId: c.companyId } }),
    ).toBe(0);
  });
  it("restarts duplicate pagination without deleting current copies or advancing a cursor", async () => {
    const c = await context();
    await baseline(c);
    c.get.mockImplementation(async (_path, query) =>
      page([row()], Number(query?.page ?? 1), true),
    );
    await expect(
      runIncomingBooksSync({ ...c.input, mode: "reconcile" }),
    ).rejects.toMatchObject({ code: "INCOMING_BOOKS_DUPLICATE_PAGE" });
    expect(c.state.checkpoint).toMatchObject({
      page: 1,
      seenIds: [],
      phase: "LIST",
    });
    expect(
      await db.booksBill.count({
        where: { companyId: c.companyId, isStale: false },
      }),
    ).toBe(1);
  });
  it("downloads only pending originals without changing metadata progress and remains idempotent", async () => {
    const c = await context();
    c.get.mockImplementation(async (path) =>
      path === "/books/v3/bills"
        ? page([row("1001", { has_attachment: true })])
        : detail(row(), { documents: [document] }),
    );
    const bill = await baseline(c),
      checkpoint = structuredClone(c.state.checkpoint);
    const getBytes = vi.fn(async () => new Uint8Array(pdf));
    expect(
      await syncIncomingBooksAttachments({
        ...c.input,
        getBytes,
        maxRequests: 1,
      }),
    ).toEqual({ processed: 1, pending: 0, failed: 0 });
    expect(getBytes).toHaveBeenCalledWith(
      "/books/v3/bills/1001/documents/7001",
    );
    expect(c.state.checkpoint).toEqual(checkpoint);
    const stored = await db.booksBillAttachment.findFirstOrThrow({
      where: { billId: bill.id },
    });
    expect(
      (await downloadBooksBillAttachment(actor, bill.id, stored.id)).bytes,
    ).toEqual(pdf);
    expect(
      await syncIncomingBooksAttachments({
        ...c.input,
        getBytes,
        maxRequests: 1,
      }),
    ).toEqual({ processed: 0, pending: 0, failed: 0 });
    expect(getBytes).toHaveBeenCalledTimes(1);
  });
  it("does not attach old bytes to metadata changed during the GET", async () => {
    const c = await context();
    c.get.mockImplementation(async (path) =>
      path === "/books/v3/bills"
        ? page([row("1001", { has_attachment: true })])
        : detail(row(), { documents: [document] }),
    );
    const bill = await baseline(c);
    const getBytes = vi.fn(async () => {
      await db.booksBill.update({
        where: { id: bill.id },
        data: {
          sourceDetail: detail(row(), {
            documents: [{ ...document, uploaded_on: "2026-10-30" }],
          }).bill,
        },
      });
      return new Uint8Array(pdf);
    });
    expect(
      await syncIncomingBooksAttachments({
        ...c.input,
        getBytes,
        maxRequests: 1,
      }),
    ).toEqual({ processed: 0, pending: 1, failed: 1 });
    expect(
      await db.booksBillAttachment.count({ where: { billId: bill.id } }),
    ).toBe(0);
    const latest = await db.booksBill.findUniqueOrThrow({
      where: { id: bill.id },
    });
    expect(describeBooksAttachments(latest, []).documents[0].downloaded).toBe(
      false,
    );
  });
});
