import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { db } from "@/lib/db";
import { localTestDatabaseUrl } from "../scripts/lib/local-test-database.mjs";

const tag = randomUUID().slice(0, 8);
let companyId: string;
let otherCompanyId: string;
let userId: string;
let vendorId: string;
let jobId: string;

const billData = (invoiceNumber = `MYSQL-INFRA-${tag}-${randomUUID()}`) => ({
  companyId,
  vendorId,
  jobId,
  invoiceNumber,
  normalizedInvoiceNumber: invoiceNumber,
  invoiceDate: new Date("2026-10-28T00:00:00.000Z"),
  category: "MATERIALS",
  currency: "AED",
  subtotal: "10.00",
  discount: "0.00",
  vatRate: "5.00",
  vatAmount: "0.50",
  total: "10.50",
  paidAmount: "0.00",
  createdById: userId,
  lines: {
    create: [
      {
        description: "Fictional infrastructure line",
        quantity: "1.000",
        unitPrice: "10.00",
        lineTotal: "10.00",
      },
    ],
  },
});

beforeAll(async () => {
  const target = localTestDatabaseUrl(process.env.DATABASE_URL);
  if (
    process.env.APP_ENV !== "test" ||
    !/^\/bills_test_\d+_\d+$/.test(target.pathname) ||
    target.pathname.slice(1) !== process.env.MYSQL_TEST_EXPECTED_DATABASE ||
    !/^bt_app_\d+_\d+$/.test(decodeURIComponent(target.username))
  )
    throw new Error(
      "Infrastructure checks require the guarded disposable MySQL harness.",
    );
  const actual = await db.$queryRaw<
    Array<{ uuid: string; databaseName: string }>
  >`SELECT @@server_uuid AS uuid, DATABASE() AS databaseName`;
  if (
    actual[0].uuid !== process.env.MYSQL_TEST_EXPECTED_SERVER_UUID ||
    actual[0].databaseName !== process.env.MYSQL_TEST_EXPECTED_DATABASE
  )
    throw new Error(
      "Infrastructure test destination identity did not match its harness.",
    );
  const company = await db.company.create({
    data: { name: `Fictional MySQL Company ${tag}` },
  });
  const otherCompany = await db.company.create({
    data: { name: `Fictional MySQL Other Company ${tag}` },
  });
  companyId = company.id;
  otherCompanyId = otherCompany.id;
  const user = await db.user.create({
    data: {
      name: "Fictional infrastructure user",
      email: `mysql-infra-${tag}@example.invalid`,
      passwordHash: "fixture-no-login-credential",
      role: "DATA_ENTRY",
    },
  });
  userId = user.id;
  const vendor = await db.vendor.create({
    data: {
      companyId,
      name: `Fictional infrastructure supplier ${tag}`,
      currency: "AED",
      isDemo: true,
    },
  });
  vendorId = vendor.id;
  const job = await db.job.create({
    data: {
      companyId,
      jobNumber: `MYSQL-INFRA-${tag}`,
      name: "Fictional infrastructure job",
      customer: "Fictional customer",
      currency: "AED",
      contractValue: "1000.00",
      isDemo: true,
    },
  });
  jobId = job.id;
});

afterAll(async () => {
  await db.$disconnect();
});

describe("real MySQL migration and restricted-runtime infrastructure", () => {
  it("connects to MySQL 8.4 with UTC, every application table, utf8mb4 and InnoDB", async () => {
    const [server] = await db.$queryRaw<
      Array<{ version: string; timezone: string; engine: string }>
    >`SELECT VERSION() AS version, @@session.time_zone AS timezone, @@default_storage_engine AS engine`;
    expect(server.version).toMatch(/^8\.4\./);
    expect(server.timezone).toBe("+00:00");
    expect(server.engine).toBe("InnoDB");
    const tables = await db.$queryRaw<
      Array<{ name: string; engine: string; collation: string }>
    >`SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS collation FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()`;
    const expected = [
      ...readFileSync("prisma/mysql/schema.prisma", "utf8").matchAll(
        /^model (\w+)/gm,
      ),
    ]
      .map((match) => match[1].toLowerCase())
      .sort();
    expect(tables.map((table) => table.name.toLowerCase()).sort()).toEqual(
      expected,
    );
    expect(
      tables.every(
        (table) =>
          table.engine === "InnoDB" && table.collation.startsWith("utf8mb4_"),
      ),
    ).toBe(true);
  });

  it("retains exact decimal columns, enforced checks, unique indexes and composite company foreign keys", async () => {
    const columns = await db.$queryRaw<
      Array<{ name: string; type: string; precision: bigint; scale: bigint }>
    >`SELECT COLUMN_NAME AS name, DATA_TYPE AS type, NUMERIC_PRECISION AS \'precision\', NUMERIC_SCALE AS scale FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND LOWER(TABLE_NAME)='bill' AND COLUMN_NAME IN ('subtotal','discount','vatRate','vatAmount','total','paidAmount')`;
    expect(columns).toHaveLength(6);
    for (const column of columns) {
      expect(column.type).toBe("decimal");
      expect(Number(column.precision)).toBe(column.name === "vatRate" ? 5 : 18);
      expect(Number(column.scale)).toBe(2);
    }
    const checks = await db.$queryRaw<
      Array<{ name: string; enforced: string }>
    >`SELECT CONSTRAINT_NAME AS name, ENFORCED AS enforced FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_TYPE='CHECK'`;
    expect(checks).toHaveLength(60);
    expect(checks.every((check) => check.enforced === "YES")).toBe(true);
    expect(checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "IncomingSyncState_source_check",
        "IncomingSyncState_status_check",
        "IncomingSyncState_lease_check",
        "IncomingSyncState_counts_check",
        "BooksImportRun_kind_check",
        "CrmImportRun_kind_check",
        "Bill_amounts_valid",
        "Bill_approval_complete",
        "Bill_ready_without_approval",
        "Bill_payment_terms_due_date",
        "SyncRecord_confirmation_required",
        "ScannerSource_tokenHash_check",
        "ScannerImport_sha256_check",
        "ScannerImport_byteSize_check",
        "ScannerImport_link_check",
        "Company_live_real_check",
        "CompanyDestination_live_verified_check",
        "LiveSyncAuthorization_version_check",
        "LiveSyncAuthorization_dates_check",
        "LiveSyncAuthorization_purpose_check",
        "LiveSyncAuthorization_local_proof_check",
        "BooksImportRun_status_check",
        "BooksImportRun_counts_check",
        "BooksImportRun_complete_check",
        "CrmImportRun_complete_check",
        "CrmJobSnapshot_link_company_check",
        "BooksProjectAssociation_status_check",
        "BooksProjectAssociation_json_check",
        "BooksProjectAssociation_dates_check",
        "BooksProjectAssociation_links_check",
        "BooksProjectAssociation_lease_check",
        "BooksProjectAssociation_failures_check",
      ]),
    );
    const indexes = await db.$queryRaw<
      Array<{ name: string }>
    >`SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND NON_UNIQUE=0`;
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "SyncRecord_legacy_target_externalId_key",
        "OcrTemplate_one_active_vendor",
        "BooksBill_destination_external_key",
        "CrmJobSnapshot_source_external_key",
        "BooksProjectAssociation_source_project_key",
      ]),
    );
    const foreignKeys = await db.$queryRaw<
      Array<{ name: string; columns: string }>
    >`SELECT CONSTRAINT_NAME AS name, GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) AS columns FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND CONSTRAINT_NAME IN ('Bill_vendorId_companyId_fkey','Bill_jobId_companyId_fkey','BooksProjectAssociation_company_fkey') GROUP BY CONSTRAINT_NAME`;
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        { name: "Bill_vendorId_companyId_fkey", columns: "vendorId,companyId" },
        { name: "Bill_jobId_companyId_fkey", columns: "jobId,companyId" },
        { name: "BooksProjectAssociation_company_fkey", columns: "companyId" },
      ]),
    );
  });

  it("permits data mutations while denying schema changes, server-account reads and audit changes", async () => {
    const bill = await db.bill.create({ data: billData() });
    await db.bill.update({
      where: { id: bill.id },
      data: { notes: "Fictional persistence check" },
    });
    expect(
      (await db.bill.findUniqueOrThrow({ where: { id: bill.id } })).notes,
    ).toBe("Fictional persistence check");
    await expect(
      db.$executeRaw`CREATE TABLE _forbidden_runtime_probe (id INT)`,
    ).rejects.toMatchObject({ code: "P2010" });
    await expect(
      db.$queryRaw`SELECT User FROM mysql.user`,
    ).rejects.toMatchObject({ code: "P2010" });
    const audit = await db.auditLog.create({
      data: {
        companyId,
        actorId: userId,
        action: "MYSQL_INFRA_FIXTURE",
        entityType: "Bill",
        entityId: bill.id,
        details: { fictional: true },
      },
    });
    await expect(
      db.auditLog.update({
        where: { id: audit.id },
        data: { action: "FORBIDDEN_CHANGE" },
      }),
    ).rejects.toBeDefined();
    await expect(
      db.auditLog.delete({ where: { id: audit.id } }),
    ).rejects.toBeDefined();
    expect(
      (await db.auditLog.findUniqueOrThrow({ where: { id: audit.id } })).action,
    ).toBe("MYSQL_INFRA_FIXTURE");
  });

  it("rolls back header, lines and audit together after a transaction failure", async () => {
    const invoiceNumber = `MYSQL-ROLLBACK-${tag}`;
    await expect(
      db.$transaction(async (transaction) => {
        const bill = await transaction.bill.create({
          data: billData(invoiceNumber),
        });
        await transaction.auditLog.create({
          data: {
            companyId,
            actorId: userId,
            action: "MYSQL_INFRA_ROLLBACK",
            entityType: "Bill",
            entityId: bill.id,
            details: { fictional: true },
          },
        });
        throw new Error("Fictional deliberate rollback");
      }),
    ).rejects.toThrow("Fictional deliberate rollback");
    expect(
      await db.bill.count({
        where: { normalizedInvoiceNumber: invoiceNumber },
      }),
    ).toBe(0);
    expect(
      await db.auditLog.count({
        where: { action: "MYSQL_INFRA_ROLLBACK", actorId: userId },
      }),
    ).toBe(0);
  });

  it("enforces totals and company foreign keys at the database boundary", async () => {
    const bill = await db.bill.create({ data: billData() });
    await expect(
      db.$executeRaw`UPDATE Bill SET total=0 WHERE id=${bill.id}`,
    ).rejects.toMatchObject({ code: "P2010" });
    expect(
      (
        await db.bill.findUniqueOrThrow({ where: { id: bill.id } })
      ).total.toFixed(2),
    ).toBe("10.50");
    await expect(
      db.bill.create({ data: { ...billData(), companyId: otherCompanyId } }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      db.bill.create({
        data: { ...billData(), jobId: "fictional-missing-job" },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("persists completed bills without approval metadata and keeps explicit payments constrained", async () => {
    const ready = await db.bill.create({ data: { ...billData(), status: "READY" } });
    expect(ready.approvedAt).toBeNull();
    expect(ready.approvedById).toBeNull();
    expect(ready.paidAmount.toFixed(2)).toBe("0.00");
    await expect(
      db.$executeRaw`UPDATE Bill SET approvedById=${userId}, approvedAt=NOW(3) WHERE id=${ready.id}`,
    ).rejects.toMatchObject({ code: "P2010" });
    await expect(
      db.$executeRaw`UPDATE Bill SET status='APPROVED' WHERE id=${ready.id}`,
    ).rejects.toMatchObject({ code: "P2010" });
    const recorded = await db.bill.update({ where: { id: ready.id }, data: { paidAmount: "1.00" } });
    expect(recorded.status).toBe("READY");
    expect(recorded.approvedAt).toBeNull();
    expect(recorded.approvedById).toBeNull();
    const draft = await db.bill.create({ data: billData() });
    await expect(
      db.$executeRaw`UPDATE Bill SET paidAmount=1 WHERE id=${draft.id}`,
    ).rejects.toMatchObject({ code: "P2010" });
  });

  it("binds new automatic work to a real initiating user without assigning historical rows", async () => {
    const bill = await db.bill.create({ data: { ...billData(), status: "READY" } });
    const data = {
      billId: bill.id, target: "ZOHO" as const, operation: "CREATE_BILL" as const, status: "CANCELLED" as const,
      organizationId: "123456789", sourceVersion: bill.version, snapshot: { fictional: true },
      payloadHash: "a".repeat(64),
    };
    const historical = await db.integrationJob.create({ data: { ...data, idempotencyKey: `historical-${tag}` } });
    expect(historical.initiatedById).toBeNull();
    const automatic = await db.integrationJob.create({ data: {
      ...data, idempotencyKey: `automatic-${tag}`, initiatedById: userId,
    }, include: { initiatedBy: { select: { id: true } } } });
    expect(automatic.initiatedBy?.id).toBe(userId);
    await expect(db.integrationJob.create({ data: {
      ...data, idempotencyKey: `invalid-actor-${tag}`, initiatedById: "fictional-missing-user",
    } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("admits only one repeated concurrent invoice and persists its lines", async () => {
    const invoiceNumber = `MYSQL-CONCURRENT-${tag}`;
    const outcomes = await Promise.allSettled([
      db.bill.create({ data: billData(invoiceNumber) }),
      db.bill.create({ data: billData(invoiceNumber) }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    expect(
      failure?.status === "rejected" ? failure.reason : undefined,
    ).toMatchObject({ code: "P2002" });
    const records = await db.bill.findMany({
      where: { normalizedInvoiceNumber: invoiceNumber },
      include: { lines: true },
    });
    expect(records).toHaveLength(1);
    expect(records[0].lines).toHaveLength(1);
    expect(records[0].lines[0].lineTotal.toFixed(2)).toBe("10.00");
  });

  it("retrieves a saved bill from a fresh application database process", async () => {
    const bill = await db.bill.create({ data: billData() });
    const child = spawnSync(
      process.execPath,
      ["--conditions=react-server", "--import=tsx", "--input-type=module"],
      {
        cwd: process.cwd(),
        windowsHide: true,
        encoding: "utf8",
        timeout: 15000,
        env: { ...process.env, MYSQL_PERSISTENCE_BILL_ID: bill.id },
        input: `try { const { createDb } = await import('./src/lib/db.ts'); const client = createDb(); try { const bill = await client.bill.findUniqueOrThrow({ where: { id: process.env.MYSQL_PERSISTENCE_BILL_ID }, include: { lines: true } }); if (bill.total.toFixed(2) !== '10.50' || bill.lines.length !== 1) throw new Error(); process.stdout.write('persisted'); } finally { await client.$disconnect(); } } catch { process.stderr.write('Fresh-process persistence check failed.'); process.exitCode = 1; }`,
      },
    );
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("persisted");
  });
});
