import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { createBill, actOnBill } from "@/lib/services/bills";
import { createJob, createVendor } from "@/lib/services/catalog";
import { attachDocument } from "@/lib/services/documents";
import { hashPassword } from "@/lib/password";
import { IntegrationError } from "@/lib/integrations/config";
import {
  processIntegrationJobs,
  queueBill,
  scheduleIntegrationJob,
  listIntegrationJobs,
} from "@/lib/integrations/queue";
import { importCrmJob } from "@/lib/integrations/crm";
import { ZohoTransport } from "@/lib/integrations/transport";
import {
  assertMySqlTestDatabase,
  createTestCompany,
  addTestMemberships,
  bindTestDestination,
} from "./company-fixtures";
import {
  getConfig,
  booksTestConfigurationHash,
} from "@/lib/integrations/config";
import { beginOAuth, completeOAuth } from "@/lib/integrations/oauth";
import { BooksAdapter, snapshotSchema, stableReference, type SupplierBillAdapter } from "@/lib/integrations/books";
import type {
  BooksMapping,
  BooksTestAuthorization,
} from "@/lib/integrations/config";
import {
  mapBooksVendor,
  listBooksVendorMappings,
} from "@/lib/integrations/vendor-mapping";
import { integrationStatus } from "@/lib/services/integrations";

let admin: Actor,
  accounts: Actor,
  staff: Actor,
  management: Actor,
  vendorId: string,
  jobId: string,
  companyId: string;
const tag = randomUUID().slice(0, 8);
beforeAll(async () => {
  assertMySqlTestDatabase();
  const passwordHash = await hashPassword("Fictional-queue-test-password-123!");
  [admin, accounts, staff, management] = await Promise.all(
    (["ADMIN", "ACCOUNTS", "DATA_ENTRY", "MANAGEMENT"] as const).map((role) =>
      db.user.create({
        data: {
          name: `Fictional queue ${role}`,
          email: `queue-${tag}-${role}@example.invalid`,
          role,
          passwordHash,
        },
      }),
    ),
  );
  const company = await createTestCompany(`integration queue ${tag}`, [
    admin,
    accounts,
    staff,
    management,
  ]);
  companyId = company.id;
  // Both destinations belong to this fictional company, so existing routing tests
  // can isolate immutable destination behavior from company authorization tests.
  await bindTestDestination(companyId, {
    target: "ZOHO",
    organizationId: "100",
  });
  await bindTestDestination(companyId, {
    target: "ZOHO",
    organizationId: "200",
  });
  await bindTestDestination(companyId, {
    target: "CRM",
    organizationId: "200",
  });
  // Authorize fictional EU destinations too, so DC-drift tests reach immutable
  // snapshot/vendor-mapping guards instead of failing company access first.
  await bindTestDestination(companyId, {
    target: "ZOHO",
    organizationId: "100",
    dataCenter: "EU",
  });
  await bindTestDestination(companyId, {
    target: "ZOHO",
    organizationId: "200",
    dataCenter: "EU",
  });
  const vendor = await createVendor(admin, {
    name: `Fictional queue vendor ${tag}`,
    currency: "AED",
  });
  vendorId = vendor.id;
  await db.vendor.update({
    where: { id: vendorId },
    data: { externalZohoId: `91${Date.now()}` },
  });
  await db.vendorBooksMapping.create({
    data: {
      vendorId,
      organizationId: "100",
      dataCenter: "US",
      environment: "sandbox",
      externalVendorId: `91${Date.now()}`,
    },
  });
  jobId = (
    await createJob(admin, {
      jobNumber: `QUEUE-${tag}`,
      name: "Fictional queue job",
      customer: "Fictional customer",
      contractValue: "10000",
      currency: "AED",
    })
  ).id;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(() => db.$disconnect());
function configure() {
  for (const [name, value] of Object.entries({
    ZOHO_BOOKS_ORGANIZATIONS_JSON: "",
    INTEGRATION_NETWORK_ENABLED: "true",
    ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
    INTEGRATION_TEST_MODE: "true",
    ZOHO_BOOKS_WRITE_ENABLED: "true",
    ZOHO_BOOKS_DC: "US",
    ZOHO_BOOKS_ENVIRONMENT: "sandbox",
    ZOHO_BOOKS_ORGANIZATION_ID: "100",
    ZOHO_BOOKS_CLIENT_ID: "fictional-client",
    ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret",
    ZOHO_BOOKS_MAPPING_JSON: JSON.stringify({
      verified: true,
      baseCurrency: "AED",
      currencies: { AED: { id: "101" } },
      taxes: { "5.00": { id: "102", percentage: "5" } },
      categories: { MATERIALS: { accountId: "103" } },
    }),
  }))
    vi.stubEnv(name, value);
  const config = getConfig("ZOHO");
  vi.stubEnv(
    "ZOHO_BOOKS_TEST_AUTHORIZATION_JSON",
    JSON.stringify({
      mode: "nonproduction",
      organizationId: config.organizationId,
      dataCenter: config.dataCenter,
      configurationHash: booksTestConfigurationHash(config),
      approvedBy: "fictional-test-operator",
      approvalReference: "fixture-approval-100",
      isolationEvidenceReference: "fixture-isolation-100",
      verifiedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }),
  );
  // Absolutely no real network calls are permitted in this test suite.
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockRejectedValue(
        new Error("Network disabled in mocked integration tests"),
      ),
  );
}
async function finalized(
  withDocument: boolean | number = false,
  selectedVendorId = vendorId,
) {
  let bill = await createBill(staff, {
    vendorId: selectedVendorId,
    jobId,
    invoiceNumber: `QUEUE-${randomUUID().slice(0, 8)}`,
    invoiceDate: "2026-10-01",
    category: "MATERIALS",
    currency: "AED",
    discount: "0",
    vatRate: "5",
    lines: [
      { description: "Fictional materials", quantity: "2", unitPrice: "50" },
    ],
    submit: false,
  });
  for (
    let documentIndex = 0;
    documentIndex < Number(withDocument);
    documentIndex++
  ) {
    const pdf = new File(
      [
        new TextEncoder().encode(
          `%PDF-1.4\nFictional synchronization attachment ${documentIndex}\n%%EOF`,
        ),
      ],
      `fictional-sync-${documentIndex}.pdf`,
      { type: "application/pdf" },
    );
    await attachDocument(staff, bill.id, pdf);
    bill = { ...bill, version: bill.version + 1 };
  }
  bill = await actOnBill(staff, bill.id, {
    action: "submit",
    version: bill.version,
  });
  expect(bill).toMatchObject({
    status: "READY", approvedById: null, approvedAt: null, paidAmount: "0.00",
  });
  return bill;
}
let nextExternalId = 9000;
function fakeAdapter(
  overrides: Partial<SupplierBillAdapter> = {},
): SupplierBillAdapter & { externalId: string } {
  const externalId = String(++nextExternalId);
  return {
    externalId,
    create: vi.fn().mockResolvedValue({ externalId, confirmedAt: new Date() }),
    reconcile: vi
      .fn()
      .mockResolvedValue({ externalId, confirmedAt: new Date() }),
    attach: vi.fn().mockResolvedValue({ externalId, confirmedAt: new Date() }),
    reconcileAttachment: vi
      .fn()
      .mockResolvedValue({ externalId, confirmedAt: new Date() }),
    ...overrides,
  };
}

describe("company authorization for accounting connections", () => {
  it("denies another company's administrator before OAuth, vendor reads or queue changes", async () => {
    configure();
    vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", "a".repeat(64));
    const outsider = await db.user.create({
      data: {
        name: "Fictional unrelated administrator",
        email: `other-company-${tag}@example.invalid`,
        passwordHash: "unusable-fixture-hash",
        role: "ADMIN",
      },
    });
    await createTestCompany(`unrelated accounting ${tag}`, [outsider]);
    const bill = await finalized();
    const job = await db.integrationJob.findFirstOrThrow({
      where: { billId: bill.id },
    });
    try {
      await expect(beginOAuth(outsider, "ZOHO", "100")).rejects.toMatchObject({
        status: 403,
      });
      await expect(
        mapBooksVendor(outsider, {
          vendorId,
          externalZohoId: "91001",
          organizationId: "100",
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        listBooksVendorMappings(outsider, "100"),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        queueBill(outsider, bill.id, "ZOHO", "100"),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        scheduleIntegrationJob(outsider, job.id, { action: "retry" }),
      ).rejects.toMatchObject({ status: 404 });
      expect((await listIntegrationJobs(outsider)).jobs).toEqual([]);
      const readiness = await integrationStatus(outsider);
      expect(readiness.zoho.organizations).toEqual([]);
      expect(readiness.zoho.canAuthorize).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await db.integrationJob.update({
        where: { id: job.id },
        data: { status: "BLOCKED" },
      });
    }
  });

  it("blocks a company without an assigned Books destination before creating any queued write", async () => {
    configure();
    const creator = await db.user.create({
      data: {
        name: "Fictional separate creator",
        email: `separate-creator-${tag}@example.invalid`,
        passwordHash: "unusable-fixture",
        role: "ADMIN",
      },
    });
    const reviewer = await db.user.create({
      data: {
        name: "Fictional separate reviewer",
        email: `separate-reviewer-${tag}@example.invalid`,
        passwordHash: "unusable-fixture",
        role: "ACCOUNTS",
      },
    });
    await createTestCompany(`unassigned destination ${tag}`, [
      creator,
      reviewer,
    ]);
    const vendor = await createVendor(creator, {
      name: "Fictional unmapped company supplier",
      currency: "AED",
    });
    const job = await createJob(creator, {
      jobNumber: `UNASSIGNED-${tag}`,
      name: "Fictional separate job",
      customer: "Fictional customer",
      currency: "AED",
      contractValue: "1000",
    });
    const bill = await createBill(creator, {
      vendorId: vendor.id,
      jobId: job.id,
      invoiceNumber: `UNASSIGNED-${tag}`,
      invoiceDate: "2026-10-28",
      category: "MATERIALS",
      currency: "AED",
      vatRate: "5",
      lines: [
        { description: "Fictional test item", quantity: "1", unitPrice: "10" },
      ],
      submit: true,
    });
    expect(bill).toMatchObject({ status: "READY", approvedById: null, approvedAt: null });
    await expect(
      queueBill(creator, bill.id, "ZOHO", "100"),
    ).rejects.toMatchObject({ code: "COMPANY_DESTINATION_MISMATCH" });
    expect(await db.integrationJob.count({ where: { billId: bill.id } })).toBe(
      0,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("durable accounting outbox", () => {
  it("keeps pending reconciliation UNKNOWN and blocks sibling attachment writes until it completes", async () => {
    configure();
    const bill = await finalized(2);
    const adapter = fakeAdapter();
    await processIntegrationJobs({ limit: 1, adapterFactory: () => adapter });
    const first = await db.integrationJob.findFirstOrThrow({
      where: { billId: bill.id, operation: "ATTACH_DOCUMENT" },
      orderBy: { id: "asc" },
    });
    await db.integrationJob.update({
      where: { id: first.id },
      data: { status: "UNKNOWN", needsReconciliation: true, attempts: 1 },
    });
    await scheduleIntegrationJob(accounts, first.id, { action: "reconcile" });
    expect(
      await db.syncRecord.findUnique({
        where: { billId_target: { billId: bill.id, target: "ZOHO" } },
      }),
    ).toMatchObject({ status: "UNKNOWN" });
    await db.integrationJob.update({
      where: { id: first.id },
      data: { nextAttemptAt: new Date(Date.now() + 60000) },
    });
    expect(
      await processIntegrationJobs({ limit: 1, adapterFactory: () => adapter }),
    ).toEqual({ processed: 0 });
    expect(adapter.attach).not.toHaveBeenCalled();
    await db.integrationJob.update({
      where: { id: first.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await processIntegrationJobs({ limit: 2, adapterFactory: () => adapter });
    expect(adapter.reconcileAttachment).toHaveBeenCalledTimes(1);
    expect(adapter.attach).toHaveBeenCalledTimes(1);
    expect(adapter.create).toHaveBeenCalledTimes(1);
  });
  it("serializes different attachment jobs for one bill across concurrent workers", async () => {
    configure();
    const bill = await finalized(2);
    let release: () => void = () => {};
    let started: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const adapter = fakeAdapter({
      attach: vi.fn().mockImplementation(async (externalId: string) => {
        started();
        await blocked;
        return { externalId, confirmedAt: new Date() };
      }),
    });
    await processIntegrationJobs({ limit: 1, adapterFactory: () => adapter });
    const first = processIntegrationJobs({
      limit: 1,
      adapterFactory: () => adapter,
    });
    await entered;
    try {
      expect(
        await processIntegrationJobs({
          limit: 1,
          adapterFactory: () => adapter,
        }),
      ).toEqual({ processed: 0 });
      expect(adapter.attach).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    await first;
    await processIntegrationJobs({ limit: 1, adapterFactory: () => adapter });
    expect(adapter.attach).toHaveBeenCalledTimes(2);
    expect(
      await db.integrationJob.count({
        where: { billId: bill.id, status: "SUCCEEDED" },
      }),
    ).toBe(3);
  });
  it("rechecks committed sibling claims after a bill lock changes hands between worker transactions", async () => {
    configure();
    const bill = await finalized(2);
    const firstClaimPrepared = Promise.withResolvers<void>();
    const secondCandidateSelected = Promise.withResolvers<void>();
    const allowFirstCommit = Promise.withResolvers<void>();
    const allowSecondBillLock = Promise.withResolvers<void>();
    const firstProviderEntered = Promise.withResolvers<void>();
    const releaseFirstProvider = Promise.withResolvers<void>();
    let attachCalls = 0;
    const adapter = fakeAdapter({
      attach: vi.fn().mockImplementation(async (externalId: string) => {
        if (++attachCalls === 1) {
          firstProviderEntered.resolve();
          await releaseFirstProvider.promise;
        }
        return { externalId, confirmedAt: new Date() };
      }),
    });
    await processIntegrationJobs({ limit: 1, adapterFactory: () => adapter });

    type Callback = (transaction: Prisma.TransactionClient) => Promise<unknown>;
    type Options = {
      isolationLevel?: Prisma.TransactionIsolationLevel;
      maxWait?: number;
      timeout?: number;
    };
    const runTransaction = db.$transaction.bind(db) as (
      callback: Callback,
      options?: Options,
    ) => Promise<unknown>;
    let claimNumber = 0;
    // Timing instrumentation only: every query, lock, update and commit still
    // executes against MySQL through the production worker's private claim path.
    const transactionSpy = vi.spyOn(db, "$transaction").mockImplementation(((
      callback: Callback,
      options?: Options,
    ) =>
      runTransaction(async (transaction) => {
        let thisClaim = 0;
        const timed = new Proxy(transaction, {
          get(target, property, receiver) {
            if (property !== "$queryRaw")
              return Reflect.get(target, property, receiver);
            return async (
              ...parameters: Parameters<Prisma.TransactionClient["$queryRaw"]>
            ) => {
              const result = await target.$queryRaw(...parameters);
              const query = parameters[0];
              if (
                "sql" in query &&
                query.sql.includes("FROM `IntegrationJob` j")
              ) {
                thisClaim = ++claimNumber;
                if (thisClaim === 2) {
                  secondCandidateSelected.resolve();
                  await allowSecondBillLock.promise;
                }
              }
              return result;
            };
          },
        });
        const result = await callback(timed);
        if (thisClaim === 1) {
          firstClaimPrepared.resolve();
          await allowFirstCommit.promise;
        }
        return result;
      }, options)) as typeof db.$transaction);
    let first: ReturnType<typeof processIntegrationJobs> | undefined;
    let second: ReturnType<typeof processIntegrationJobs> | undefined;
    try {
      first = processIntegrationJobs({
        limit: 1,
        adapterFactory: () => adapter,
      });
      await firstClaimPrepared.promise;
      second = processIntegrationJobs({
        limit: 1,
        adapterFactory: () => adapter,
      });
      await secondCandidateSelected.promise;
      allowFirstCommit.resolve();
      await firstProviderEntered.promise;
      allowSecondBillLock.resolve();
      expect(await second).toEqual({ processed: 0 });
      expect(adapter.attach).toHaveBeenCalledTimes(1);
      expect(
        await db.integrationJob.count({
          where: {
            billId: bill.id,
            operation: "ATTACH_DOCUMENT",
            status: "PROCESSING",
          },
        }),
      ).toBe(1);
      expect(
        await db.integrationJob.count({
          where: {
            billId: bill.id,
            operation: "ATTACH_DOCUMENT",
            status: "QUEUED",
          },
        }),
      ).toBe(1);
    } finally {
      allowFirstCommit.resolve();
      allowSecondBillLock.resolve();
      releaseFirstProvider.resolve();
      transactionSpy.mockRestore();
      await Promise.allSettled(
        [first, second].filter((worker) => worker !== undefined),
      );
    }
    await processIntegrationJobs({ limit: 1, adapterFactory: () => adapter });
    expect(adapter.attach).toHaveBeenCalledTimes(2);
  });
  it("retains an audit trail for rate-limit exhaustion and stops automatic retries after five attempts", async () => {
    configure();
    const bill = await finalized();
    const job = await db.integrationJob.findFirstOrThrow({
      where: { billId: bill.id },
    });
    const adapter = fakeAdapter({
      create: vi
        .fn()
        .mockRejectedValue(
          new IntegrationError(
            "RATE_LIMITED",
            "The external API rate limit was reached.",
            "RETRY",
            120,
          ),
        ),
    });
    for (let attempt = 1; attempt <= 5; attempt++) {
      await db.integrationJob.update({
        where: { id: job.id },
        data: { nextAttemptAt: new Date(0) },
      });
      const before = Date.now();
      await processIntegrationJobs({ limit: 1, adapterFactory: () => adapter });
      const current = await db.integrationJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(current.attempts).toBe(attempt);
      expect(current.status).toBe(attempt < 5 ? "RETRY" : "FAILED");
      expect(current.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
        before + 120000,
      );
    }
    expect(
      await processIntegrationJobs({ limit: 1, adapterFactory: () => adapter }),
    ).toEqual({ processed: 0 });
    expect(adapter.create).toHaveBeenCalledTimes(5);
    expect(
      await db.integrationAttempt.count({ where: { jobId: job.id } }),
    ).toBe(5);
    expect(
      await db.auditLog.count({
        where: { entityId: bill.id, action: "SYNC_ATTEMPT_FAILED" },
      }),
    ).toBe(5);
    expect(await db.bill.findUnique({ where: { id: bill.id } })).toMatchObject({
      status: "READY",
    });
  });
  it("refuses a reconfigured organization or data center before a worker can contact a provider", async () => {
    configure();
    const bill = await finalized();
    vi.stubEnv("ZOHO_BOOKS_DC", "EU");
    await processIntegrationJobs({ limit: 1 });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await db.integrationJob.findFirst({ where: { billId: bill.id } }),
    ).toMatchObject({ status: "BLOCKED", errorCode: "DESTINATION_CHANGED" });
    const job = await db.integrationJob.findFirstOrThrow({
      where: { billId: bill.id },
    });
    vi.stubEnv("ZOHO_BOOKS_ORGANIZATION_ID", "999");
    await expect(
      scheduleIntegrationJob(accounts, job.id, { action: "retry" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("blocks changed accounting mappings on queued writes without preventing read-only reconciliation", async () => {
    configure();
    const bill = await finalized();
    const mapping = JSON.parse(process.env.ZOHO_BOOKS_MAPPING_JSON!) as {
      categories: { MATERIALS: { accountId: string } };
    };
    mapping.categories.MATERIALS.accountId = "999";
    vi.stubEnv("ZOHO_BOOKS_MAPPING_JSON", JSON.stringify(mapping));
    await processIntegrationJobs({ limit: 1 });
    expect(fetch).not.toHaveBeenCalled();
    const job = await db.integrationJob.findFirstOrThrow({
      where: { billId: bill.id },
    });
    expect(job).toMatchObject({
      status: "BLOCKED",
      errorCode: "MAPPING_CHANGED",
    });
    vi.stubEnv("ZOHO_BOOKS_WRITE_ENABLED", "false");
    await expect(scheduleIntegrationJob(accounts, job.id, { action: "retry" }))
      .rejects.toMatchObject({ code: "WRITES_DISABLED" });
    await scheduleIntegrationJob(accounts, job.id, { action: "reconcile" });
    const snapshot = snapshotSchema.parse(job.snapshot);
    const externalId = String(++nextExternalId);
    const provider = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      expect(init?.method).toBe("GET");
      expect(url.searchParams.get("organization_id")).toBe("100");
      if (url.pathname === "/books/v3/bills") {
        expect(url.searchParams.get("reference_number")).toBe(stableReference(bill.id));
        return Response.json({ code: 0, bills: [{ bill_id: externalId, reference_number: stableReference(bill.id) }],
          page_context: { has_more_page: false } });
      }
      expect(url.pathname).toBe(`/books/v3/bills/${externalId}`);
      return Response.json({ code: 0, bill: { bill_id: externalId, bill_number: snapshot.invoiceNumber,
        vendor_id: snapshot.externalVendorId, reference_number: stableReference(bill.id), currency_code: snapshot.currency,
        total: snapshot.total, tax_total: snapshot.vatAmount } });
    });
    const transport = new ZohoTransport(getConfig("ZOHO"), async () => "fictional-readonly-token", provider);
    const adapter = new BooksAdapter(transport);
    const create = vi.spyOn(adapter, "create"), reconcile = vi.spyOn(adapter, "reconcile");
    await processIntegrationJobs({ limit: 1, adapterFactory: () => adapter });
    expect(create).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(await db.integrationJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: "SUCCEEDED", externalId });
    await expect(transport.request("/books/v3/bills", { method: "POST", body: {} }))
      .rejects.toMatchObject({ code: "WRITES_DISABLED" });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not enqueue an unconfigured completed entry and preserves a visible setup failure", async () => {
    const network = vi.fn().mockRejectedValue(new Error("Unexpected provider request"));
    vi.stubGlobal("fetch", network);
    const bill = await finalized();
    expect(await db.integrationJob.count({ where: { billId: bill.id } })).toBe(
      0,
    );
    expect(
      await db.syncRecord.findUnique({
        where: { billId_target: { billId: bill.id, target: "ZOHO" } },
      }),
    ).toMatchObject({ status: "FAILED", lastError: expect.any(String) });
    expect(network).not.toHaveBeenCalled();
  });
  it("enqueues exactly once on final save and repeated manual requests, then freezes cancellation", async () => {
    configure();
    const bill = await finalized();
    const jobs = await db.integrationJob.findMany({
      where: { billId: bill.id },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].initiatedById).toBe(staff.id);
    const repeated = await queueBill(accounts, bill.id, "ZOHO");
    expect(repeated.id).toBe(jobs[0].id);
    expect(await db.integrationJob.count({ where: { billId: bill.id } })).toBe(
      1,
    );
    await expect(
      actOnBill(admin, bill.id, {
        action: "cancel",
        version: bill.version,
        reason: "Fictional cancellation check",
      }),
    ).rejects.toMatchObject({ status: 409 });
    const adapter = fakeAdapter();
    await Promise.all([
      processIntegrationJobs({ limit: 1, adapterFactory: () => adapter }),
      processIntegrationJobs({ limit: 1, adapterFactory: () => adapter }),
    ]);
    expect(adapter.create).toHaveBeenCalledTimes(1);
    expect(
      await db.syncRecord.findUnique({
        where: { billId_target: { billId: bill.id, target: "ZOHO" } },
      }),
    ).toMatchObject({ status: "SYNCED", externalId: adapter.externalId });
  });
  it("keeps timeout outcomes UNKNOWN and permits only read reconciliation", async () => {
    configure();
    const bill = await finalized();
    const job = await db.integrationJob.findFirstOrThrow({
      where: { billId: bill.id },
    });
    const adapter = fakeAdapter({
      create: vi
        .fn()
        .mockRejectedValue(
          new IntegrationError(
            "REQUEST_INTERRUPTED",
            "Outcome uncertain",
            "UNKNOWN",
          ),
        ),
    });
    await processIntegrationJobs({ limit: 1, adapterFactory: () => adapter });
    expect(
      await db.integrationJob.findUnique({ where: { id: job.id } }),
    ).toMatchObject({ status: "UNKNOWN", needsReconciliation: true });
    await expect(
      scheduleIntegrationJob(accounts, job.id, { action: "retry" }),
    ).rejects.toMatchObject({ status: 409 });
    await scheduleIntegrationJob(accounts, job.id, { action: "reconcile" });
    await processIntegrationJobs({ limit: 1, adapterFactory: () => adapter });
    expect(adapter.create).toHaveBeenCalledTimes(1);
    expect(adapter.reconcile).toHaveBeenCalledTimes(1);
    expect(
      await db.integrationJob.findUnique({ where: { id: job.id } }),
    ).toMatchObject({ status: "SUCCEEDED", externalId: adapter.externalId });
  });
  it("does not turn an absent reconciliation result into another create", async () => {
    configure();
    const bill = await finalized();
    const job = await db.integrationJob.findFirstOrThrow({
      where: { billId: bill.id },
    });
    await db.integrationJob.update({
      where: { id: job.id },
      data: { status: "UNKNOWN", needsReconciliation: true, attempts: 1 },
    });
    await scheduleIntegrationJob(accounts, job.id, { action: "reconcile" });
    const adapter = fakeAdapter({ reconcile: vi.fn().mockResolvedValue(null) });
    await processIntegrationJobs({ limit: 1, adapterFactory: () => adapter });
    expect(adapter.create).not.toHaveBeenCalled();
    expect(
      await db.integrationJob.findUnique({ where: { id: job.id } }),
    ).toMatchObject({ status: "UNKNOWN", needsReconciliation: true });
  });
  it("recovers expired worker leases as unknown without automatically replaying a POST", async () => {
    configure();
    const bill = await finalized();
    const job = await db.integrationJob.findFirstOrThrow({
      where: { billId: bill.id },
    });
    await db.integrationJob.update({
      where: { id: job.id },
      data: {
        status: "PROCESSING",
        attempts: 1,
        leaseToken: "fictional-interrupted-worker",
        leaseUntil: new Date(0),
      },
    });
    const adapter = fakeAdapter();
    await processIntegrationJobs({ limit: 1, adapterFactory: () => adapter });
    expect(adapter.create).not.toHaveBeenCalled();
    expect(
      await db.integrationJob.findUnique({ where: { id: job.id } }),
    ).toMatchObject({ status: "UNKNOWN", errorCode: "WORKER_LEASE_EXPIRED" });
  });
  it("preserves the confirmed bill ID when its attachment fails, and retries only that attachment", async () => {
    configure();
    const bill = await finalized(true);
    const adapter = fakeAdapter({
      attach: vi
        .fn()
        .mockRejectedValueOnce(
          new IntegrationError(
            "REMOTE_REJECTED",
            "Attachment rejected",
            "FAILED",
          ),
        )
        .mockImplementation(async (externalId: string) => ({
          externalId,
          confirmedAt: new Date(),
        })),
    });
    await processIntegrationJobs({ limit: 2, adapterFactory: () => adapter });
    const record = await db.syncRecord.findUniqueOrThrow({
      where: { billId_target: { billId: bill.id, target: "ZOHO" } },
    });
    expect(record).toMatchObject({
      status: "FAILED",
      externalId: adapter.externalId,
    });
    const attachment = await db.integrationJob.findFirstOrThrow({
      where: { billId: bill.id, operation: "ATTACH_DOCUMENT" },
    });
    expect(attachment.status).toBe("FAILED");
    await scheduleIntegrationJob(accounts, attachment.id, { action: "retry" });
    await processIntegrationJobs({ limit: 1, adapterFactory: () => adapter });
    expect(adapter.create).toHaveBeenCalledTimes(1);
    expect(adapter.attach).toHaveBeenCalledTimes(2);
    expect(
      await db.syncRecord.findUnique({
        where: { billId_target: { billId: bill.id, target: "ZOHO" } },
      }),
    ).toMatchObject({ status: "SYNCED", externalId: adapter.externalId });
    expect(
      await db.integrationAttempt.count({ where: { jobId: attachment.id } }),
    ).toBe(2);
  });
  it("allows management queue visibility without snapshots or credential data and denies writes", async () => {
    const result = await listIntegrationJobs(management);
    expect(result.jobs.length).toBeGreaterThan(0);
    expect(result.jobs[0]).not.toHaveProperty("snapshot");
    expect(result.jobs[0]).not.toHaveProperty("leaseToken");
    await expect(
      scheduleIntegrationJob(management, result.jobs[0].id, {
        action: "retry",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(listIntegrationJobs(staff)).rejects.toMatchObject({
      status: 403,
    });
  });
  it("refuses CRM posting until a supplier expense module is verified", async () => {
    const bill = await finalized();
    await expect(queueBill(accounts, bill.id, "CRM")).rejects.toMatchObject({
      code: "CRM_EXPENSE_MODULE_UNVERIFIED",
    });
  });
});

function configureMultiple(dataCenter = "US") {
  configure();
  vi.stubEnv("ZOHO_BOOKS_DC", dataCenter);
  const mapping = getConfig("ZOHO").booksMapping!;
  const profiles: {
    organizationId: string;
    name: string;
    mapping: BooksMapping;
    testAuthorization?: BooksTestAuthorization;
  }[] = [
    { organizationId: "100", name: "Fictional Books A", mapping },
    {
      organizationId: "200",
      name: "Fictional Books B",
      mapping: { ...mapping, categories: { MATERIALS: { accountId: "203" } } },
    },
  ];
  vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", JSON.stringify(profiles));
  for (const profile of profiles) {
    const config = getConfig("ZOHO", process.env, profile.organizationId);
    profile.testAuthorization = {
      mode: "nonproduction",
      organizationId: profile.organizationId,
      dataCenter: config.dataCenter,
      configurationHash: booksTestConfigurationHash(config),
      approvedBy: "fictional-multi-test-operator",
      approvalReference: `fixture-${profile.organizationId}`,
      isolationEvidenceReference: `fixture-isolation-${profile.organizationId}`,
      verifiedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
  }
  vi.stubEnv("ZOHO_BOOKS_ORGANIZATIONS_JSON", JSON.stringify(profiles));
}
function vendorConnection(
  organizationId: string,
  externalId: string,
  currency = "AED",
) {
  const fetcher = vi.fn(async (url: string | URL) => {
    expect(new URL(url).searchParams.get("organization_id")).toBe(
      organizationId,
    );
    return Response.json({
      code: 0,
      contact: {
        contact_id: externalId,
        contact_type: "vendor",
        currency_code: currency,
        status: "active",
      },
    });
  });
  return new ZohoTransport(
    getConfig("ZOHO", process.env, organizationId),
    async () => "fictional-vendor-read-token",
    fetcher,
  );
}

describe("explicit Books organization routing", () => {
  let scopedVendorId: string;
  beforeAll(async () => {
    scopedVendorId = (
      await createVendor(admin, {
        name: `Fictional multi-org vendor ${tag}`,
        currency: "AED",
      })
    ).id;
    await db.vendor.update({
      where: { id: scopedVendorId },
      data: { externalZohoId: `93${Date.now()}` },
    });
  });
  it("does not turn an unresolved legacy sync status without a queue job into a new external create", async () => {
    configureMultiple();
    for (const status of ["PENDING", "UNKNOWN", "FAILED"] as const) {
      const bill = await finalized(false, scopedVendorId);
      await db.syncRecord.update({
        where: { billId_target: { billId: bill.id, target: "ZOHO" } },
        data: {
          status,
          organizationId: null,
          externalId: null,
          attempts: status === "FAILED" ? 1 : 0,
        },
      });
      await expect(
        queueBill(accounts, bill.id, "ZOHO", "100"),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await db.integrationJob.count({ where: { billId: bill.id } }),
      ).toBe(0);
      expect(
        await db.syncRecord.findUnique({
          where: { billId_target: { billId: bill.id, target: "ZOHO" } },
        }),
      ).toMatchObject({ status, organizationId: null, externalId: null });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("stores and reads supplier mappings separately per organization, and rejects contact collisions or currency mismatches", async () => {
    configureMultiple();
    await expect(
      mapBooksVendor(admin, {
        vendorId: scopedVendorId,
        externalZohoId: "90010",
      }),
    ).rejects.toMatchObject({ code: "ORGANIZATION_REQUIRED" });
    await mapBooksVendor(
      admin,
      {
        vendorId: scopedVendorId,
        organizationId: "100",
        externalZohoId: "90010",
      },
      vendorConnection("100", "90010"),
    );
    await mapBooksVendor(
      admin,
      {
        vendorId: scopedVendorId,
        organizationId: "200",
        externalZohoId: "90020",
      },
      vendorConnection("200", "90020"),
    );
    expect(
      (await listBooksVendorMappings(management, "100")).mappings.find(
        (m) => m.vendorId === scopedVendorId,
      )?.externalZohoId,
    ).toBe("90010");
    expect(
      (await listBooksVendorMappings(management, "200")).mappings.find(
        (m) => m.vendorId === scopedVendorId,
      )?.externalZohoId,
    ).toBe("90020");
    const duplicate = (
      await createVendor(admin, {
        name: `Fictional collision vendor ${tag}`,
        currency: "AED",
      })
    ).id;
    await expect(
      mapBooksVendor(
        admin,
        { vendorId: duplicate, organizationId: "100", externalZohoId: "90010" },
        vendorConnection("100", "90010"),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await mapBooksVendor(
      admin,
      { vendorId: duplicate, organizationId: "200", externalZohoId: "90010" },
      vendorConnection("200", "90010"),
    );
    await expect(
      mapBooksVendor(
        admin,
        { vendorId: duplicate, organizationId: "200", externalZohoId: "90030" },
        vendorConnection("200", "90030", "USD"),
      ),
    ).rejects.toMatchObject({ code: "VENDOR_MAPPING_MISMATCH" });
    await expect(listBooksVendorMappings(staff, "100")).rejects.toMatchObject({
      status: 403,
    });
  });
  it("requires an explicit destination and keeps it immutable after failure or unknown outcomes", async () => {
    configureMultiple();
    const bill = await finalized(false, scopedVendorId);
    expect(await db.integrationJob.count({ where: { billId: bill.id } })).toBe(
      0,
    );
    await expect(queueBill(accounts, bill.id, "ZOHO")).rejects.toMatchObject({
      code: "ORGANIZATION_REQUIRED",
    });
    const job = await queueBill(accounts, bill.id, "ZOHO", "100");
    expect((await queueBill(accounts, bill.id, "ZOHO", "100")).id).toBe(job.id);
    for (const status of ["FAILED", "UNKNOWN"] as const) {
      await db.integrationJob.update({
        where: { id: job.id },
        data: {
          status,
          needsReconciliation: status === "UNKNOWN",
          attempts: 1,
        },
      });
      await expect(
        queueBill(accounts, bill.id, "ZOHO", "200"),
      ).rejects.toMatchObject({ status: 409 });
    }
    expect(await db.integrationJob.count({ where: { billId: bill.id } })).toBe(
      1,
    );
    expect(
      await db.syncRecord.findUnique({
        where: { billId_target: { billId: bill.id, target: "ZOHO" } },
      }),
    ).toMatchObject({ organizationId: "100" });
    await expect(
      scheduleIntegrationJob(accounts, job.id, {
        action: "reconcile",
        organizationId: "200",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await scheduleIntegrationJob(accounts, job.id, {
      action: "reconcile",
      organizationId: "100",
    });
    const factory = vi.fn(() => fakeAdapter());
    await processIntegrationJobs({ limit: 1, adapterFactory: factory });
    expect(factory).toHaveBeenCalledWith("ZOHO", "100", expect.objectContaining({
      id: job.id, billId: bill.id, target: "ZOHO", organizationId: "100",
      status: "PROCESSING", needsReconciliation: true, leaseToken: expect.any(String),
    }));
    await expect(
      mapBooksVendor(
        admin,
        {
          vendorId: scopedVendorId,
          organizationId: "100",
          externalZohoId: "90011",
        },
        vendorConnection("100", "90011"),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("serializes concurrent destination choices into one canonical operation", async () => {
    configureMultiple();
    const bill = await finalized(false, scopedVendorId);
    const results = await Promise.allSettled([
      queueBill(accounts, bill.id, "ZOHO", "100"),
      queueBill(accounts, bill.id, "ZOHO", "200"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const jobs = await db.integrationJob.findMany({
      where: { billId: bill.id },
    });
    expect(jobs).toHaveLength(1);
    expect(
      await db.syncRecord.findUnique({
        where: { billId_target: { billId: bill.id, target: "ZOHO" } },
      }),
    ).toMatchObject({ organizationId: jobs[0].organizationId });
    const adapter = fakeAdapter();
    await processIntegrationJobs({ limit: 1, adapterFactory: () => adapter });
    expect(adapter.create).toHaveBeenCalledTimes(1);
  });
  it("uses scoped vendor IDs and permits the same remote bill ID in two different organizations", async () => {
    configureMultiple();
    const first = await finalized(false, scopedVendorId),
      second = await finalized(false, scopedVendorId);
    await queueBill(accounts, first.id, "ZOHO", "100");
    await queueBill(accounts, second.id, "ZOHO", "200");
    const organizations: string[] = [];
    await processIntegrationJobs({
      limit: 2,
      adapterFactory: (_target, organizationId) => {
        organizations.push(organizationId);
        return fakeAdapter({
          create: vi.fn(async (snapshot) => {
            expect(snapshot.externalVendorId).toBe(
              organizationId === "100" ? "90010" : "90020",
            );
            return { externalId: "987654321", confirmedAt: new Date() };
          }),
        });
      },
    });
    expect(organizations.sort()).toEqual(["100", "200"]);
    expect(
      await db.syncRecord.count({
        where: { target: "ZOHO", externalId: "987654321", status: "SYNCED" },
      }),
    ).toBe(2);
    const a = await listIntegrationJobs(management, "100"),
      b = await listIntegrationJobs(management, "200");
    expect(a.jobs.some((j) => j.billId === first.id)).toBe(true);
    expect(a.jobs.some((j) => j.billId === second.id)).toBe(false);
    expect(b.jobs.some((j) => j.billId === second.id)).toBe(true);
    expect(b.jobs.every((j) => j.organizationId === "200")).toBe(true);
  });
  it("never reuses legacy or wrong-data-center supplier mappings in either destination", async () => {
    configureMultiple("EU");
    const bill = await finalized(false, scopedVendorId);
    await expect(
      queueBill(accounts, bill.id, "ZOHO", "100"),
    ).rejects.toMatchObject({ code: "VENDOR_MAPPING_REQUIRED" });
    expect((await listBooksVendorMappings(admin, "100")).mappings).toHaveLength(
      0,
    );
    expect(await db.integrationJob.count({ where: { billId: bill.id } })).toBe(
      0,
    );
    configureMultiple();
    const unmapped = (
      await createVendor(admin, {
        name: `Fictional legacy-only vendor ${tag}`,
        currency: "AED",
      })
    ).id;
    await db.vendor.update({
      where: { id: unmapped },
      data: { externalZohoId: `94${Date.now()}` },
    });
    const legacyBill = await finalized(false, unmapped);
    await expect(
      queueBill(accounts, legacyBill.id, "ZOHO", "200"),
    ).rejects.toMatchObject({ code: "VENDOR_MAPPING_REQUIRED" });
  });
  it("preserves legacy null-organization uniqueness and refuses ambiguous external-ID confirmation", async () => {
    configureMultiple();
    const legacy = await finalized(false, scopedVendorId),
      duplicate = await finalized(false, scopedVendorId);
    await db.syncRecord.update({
      where: { billId_target: { billId: legacy.id, target: "ZOHO" } },
      data: { status: "SYNCED", externalId: "987650000", organizationId: null },
    });
    await expect(
      db.syncRecord.update({
        where: { billId_target: { billId: duplicate.id, target: "ZOHO" } },
        data: {
          status: "SYNCED",
          externalId: "987650000",
          organizationId: null,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await queueBill(accounts, duplicate.id, "ZOHO", "100");
    await processIntegrationJobs({
      limit: 1,
      adapterFactory: () =>
        fakeAdapter({
          create: vi.fn().mockResolvedValue({
            externalId: "987650000",
            confirmedAt: new Date(),
          }),
        }),
    });
    expect(
      await db.integrationJob.findFirst({ where: { billId: duplicate.id } }),
    ).toMatchObject({
      status: "UNKNOWN",
      errorCode: "LEGACY_EXTERNAL_ID_UNSCOPED",
    });
    expect(
      await db.syncRecord.findUnique({
        where: { billId_target: { billId: duplicate.id, target: "ZOHO" } },
      }),
    ).toMatchObject({
      status: "UNKNOWN",
      externalId: null,
      organizationId: "100",
    });
  });
});

describe("existing CRM job import", () => {
  it("rejects expired, wrong-user and already-consumed OAuth state before token exchange", async () => {
    configure();
    vi.stubEnv("INTEGRATION_TOKEN_ENCRYPTION_KEY", "a".repeat(64));
    const begun = await beginOAuth(admin, "ZOHO");
    const state = new URL(begun.authorizationUrl).searchParams.get("state")!;
    await db.integrationOAuthState.updateMany({
      where: { userId: admin.id },
      data: { expiresAt: new Date(0) },
    });
    await expect(
      completeOAuth(
        admin,
        "ZOHO",
        new URLSearchParams({ state, code: "fictional-code" }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
    const next = await beginOAuth(admin, "ZOHO");
    const used = new URL(next.authorizationUrl).searchParams.get("state")!;
    const sourceAdmin = await db.user.findUniqueOrThrow({
      where: { id: admin.id },
    });
    const differentAdmin = await db.user.create({
      data: {
        email: `oauth-admin-${tag}@example.invalid`,
        name: "Fictional OAuth second admin",
        role: "ADMIN",
        passwordHash: sourceAdmin.passwordHash,
      },
    });
    await addTestMemberships(companyId, [differentAdmin]);
    await expect(
      completeOAuth(
        differentAdmin,
        "ZOHO",
        new URLSearchParams({ state: used, code: "fictional-code" }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
    await db.integrationOAuthState.updateMany({
      where: { userId: admin.id },
      data: { consumedAt: new Date() },
    });
    await expect(
      completeOAuth(
        admin,
        "ZOHO",
        new URLSearchParams({ state: used, code: "fictional-code" }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("validates source organization and unique job number; reimport updates the same local job", async () => {
    configure();
    for (const [name, value] of Object.entries({
      ZOHO_CRM_DC: "US",
      ZOHO_CRM_ENVIRONMENT: "sandbox",
      ZOHO_CRM_ORGANIZATION_ID: "200",
      ZOHO_CRM_CLIENT_ID: "fictional-client",
      ZOHO_CRM_CLIENT_SECRET: "fictional-secret",
    }))
      vi.stubEnv(name, value);
    const record = {
      id: `92${Date.now()}`,
      JobDealNumber: `CRM-${tag}`,
      Deal_Name: "Fictional CRM job",
      Amount: "500.00",
      Account_Name: { id: "201", name: "Fictional customer" },
      Currency: "AED",
    };
    let duplicates = false;
    const fetcher = vi.fn(async (url: string | URL) => {
      const path = new URL(url).pathname;
      return Response.json(
        path.endsWith("/org")
          ? { org: [{ zgid: "200", type: "sandbox" }] }
          : path.endsWith("/search")
            ? {
                data: duplicates
                  ? [record, { ...record, id: "99999" }]
                  : [record],
                info: { more_records: false },
              }
            : { data: [record] },
      );
    });
    const transport = new ZohoTransport(
      getConfig("CRM"),
      async () => "fictional-token",
      fetcher,
    );
    const first = await importCrmJob(admin, record.id, transport);
    await db.job.update({
      where: { id: first.id },
      data: { approvedVariations: "125.50" },
    });
    record.Amount = "750.00";
    const second = await importCrmJob(admin, record.id, transport);
    expect(second.id).toBe(first.id);
    expect(second.contractValue?.toFixed(2)).toBe("750.00");
    expect(second.approvedVariations.toFixed(2)).toBe("125.50");
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: second.id, action: "CRM_JOB_IMPORTED" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.details).toMatchObject({
      before: {
        contractValue: "500.00",
        approvedVariations: "125.50",
        currency: "AED",
        jobNumber: record.JobDealNumber.toUpperCase(),
      },
      after: {
        contractValue: "750.00",
        approvedVariations: "125.50",
        currency: "AED",
        jobNumber: record.JobDealNumber.toUpperCase(),
      },
    });
    expect(
      fetcher.mock.calls.every(
        (call) => new URL(call[0]).hostname === "sandbox.zohoapis.com",
      ),
    ).toBe(true);
    duplicates = true;
    await expect(
      importCrmJob(admin, record.id, transport),
    ).rejects.toMatchObject({ code: "CRM_JOB_NUMBER_NOT_UNIQUE" });
    expect(
      (
        await db.job.findUniqueOrThrow({ where: { id: first.id } })
      ).contractValue?.toFixed(2),
    ).toBe("750.00");
  });
});
