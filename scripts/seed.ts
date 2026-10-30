import { BillStatus } from "@prisma/client";
import { calculateBill, normalizeInvoiceNumber } from "../src/lib/finance";
import { hashPassword } from "../src/lib/password";
import { createDb } from "../src/lib/db";

try {
  process.loadEnvFile(".env");
} catch {
  /* Environment can be supplied by the caller. */
}

const databaseUrl = process.env.DATABASE_URL;
if (
  process.env.APP_ENV !== "development" ||
  process.env.NODE_ENV === "production" ||
  process.env.ALLOW_DEMO_SEED !== "true"
) {
  throw new Error(
    "Demo seed requires APP_ENV=development, ALLOW_DEMO_SEED=true, and a non-production runtime.",
  );
}
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const target = new URL(databaseUrl);
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
  target.protocol !== "mysql:" ||
  target.pathname !== "/voltronix_billing_dev" || target.search || target.hash
) {
  throw new Error(
    "Demo seed is restricted to a loopback MySQL database named voltronix_billing_dev without connection overrides.",
  );
}
const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
const adminPassword = process.env.SEED_ADMIN_PASSWORD;
if (!adminEmail || !adminPassword || adminPassword.length < 14)
  throw new Error(
    "Set SEED_ADMIN_EMAIL and a unique SEED_ADMIN_PASSWORD of at least 14 characters. No default account is created.",
  );
const accountsEmail = process.env.SEED_ACCOUNTS_EMAIL?.trim().toLowerCase();
const accountsPassword = process.env.SEED_ACCOUNTS_PASSWORD;
if (
  Boolean(accountsEmail) !== Boolean(accountsPassword) ||
  (accountsPassword && accountsPassword.length < 14)
)
  throw new Error(
    "Optional accounts seed requires both SEED_ACCOUNTS_EMAIL and a unique password of at least 14 characters.",
  );
if (accountsEmail === adminEmail)
  throw new Error(
    "Admin and Accounts must use different emails for independent approval.",
  );

const db = createDb(databaseUrl);
async function main() {
  const companyId = "demo-company-voltronix";
  const secondCompanyId = "demo-company-secondary";
  for (const company of [
    { id: companyId, name: "[DEMO] Fictional Company A" },
    { id: secondCompanyId, name: "[DEMO] Fictional Company B" },
  ]) await db.company.upsert({ where: { id: company.id }, update: {}, create: company });
  const admin = await db.user.upsert({
    where: { email: adminEmail! },
    update: {},
    create: {
      email: adminEmail!,
      passwordHash: await hashPassword(adminPassword!),
      name: "[DEMO] Administrator",
      role: "ADMIN",
    },
  });
  const accounts =
    accountsEmail && accountsPassword
      ? await db.user.upsert({
          where: { email: accountsEmail },
          update: {},
          create: {
            email: accountsEmail,
            passwordHash: await hashPassword(accountsPassword),
            name: "[DEMO] Accounts Reviewer",
            role: "ACCOUNTS",
          },
        })
      : null;
  for (const user of [admin, accounts].filter((value) => value !== null)) {
    for (const id of [companyId, secondCompanyId]) await db.userCompanyMembership.upsert({
      where: { userId_companyId: { userId: user.id, companyId: id } }, update: {},
      create: { userId: user.id, companyId: id },
    });
  }
  // Fictional provider identifiers are used only by mocked tests.
  for (const [id, organizationId] of [[companyId, "100"], [secondCompanyId, "200"]]) {
    const destination = { companyId: id, target: "ZOHO" as const, organizationId, dataCenter: "US", environment: "sandbox" };
    await db.companyIntegrationDestination.upsert({
      where: { companyId_target_organizationId_dataCenter_environment: destination }, update: {}, create: destination,
    });
  }
  const vendors = [
    {
      id: "demo-vendor-materials",
      name: "[DEMO] Meridian Materials",
      email: "materials@example.invalid",
      currency: "AED",
    },
    {
      id: "demo-vendor-electrical",
      name: "[DEMO] Ember Electrical",
      email: "electrical@example.invalid",
      currency: "AED",
    },
    {
      id: "demo-vendor-equipment",
      name: "[DEMO] Atlas Equipment",
      email: "equipment@example.invalid",
      currency: "AED",
    },
  ];
  for (const vendor of vendors)
    await db.vendor.upsert({
      where: { id: vendor.id },
      update: {},
      create: { ...vendor, companyId, isDemo: true },
    });
  const jobs = [
    {
      id: "demo-job-marina",
      jobNumber: "DEMO-JOB-1001",
      name: "[DEMO] Marina Office Fit-out",
      customer: "[DEMO] Meridian Properties",
      contractValue: "450000",
      approvedVariations: "50000",
    },
    {
      id: "demo-job-warehouse",
      jobNumber: "DEMO-JOB-1002",
      name: "[DEMO] Warehouse Power Upgrade",
      customer: "[DEMO] Northpoint Logistics",
      contractValue: "180000",
      approvedVariations: "0",
    },
    {
      id: "demo-job-retail",
      jobNumber: "DEMO-JOB-1003",
      name: "[DEMO] Retail Lighting",
      customer: "[DEMO] Cedar Retail",
      contractValue: "250000",
      approvedVariations: "0",
    },
    {
      id: "demo-job-unvalued",
      jobNumber: "DEMO-JOB-1004",
      name: "[DEMO] Preliminary Maintenance",
      customer: "[DEMO] Horizon Operations",
      contractValue: null,
      approvedVariations: "0",
    },
  ];
  for (const job of jobs)
    await db.job.upsert({
      where: { id: job.id },
      update: {},
      create: { ...job, companyId, currency: "AED", isDemo: true },
    });
  const invoices: {
    id: string;
    vendorId: string;
    jobId: string;
    invoiceNumber: string;
    price: string;
    date: string;
    category: string;
    status: BillStatus;
    paid: string;
    description: string;
  }[] = [
    {
      id: "demo-bill-1001",
      vendorId: vendors[0].id,
      jobId: jobs[0].id,
      invoiceNumber: "DEMO-INV-1001",
      price: "180000",
      date: "2026-08-12",
      category: "MATERIALS",
      status: "APPROVED",
      paid: "189000",
      description: "[DEMO] Electrical materials supply",
    },
    {
      id: "demo-bill-1002",
      vendorId: vendors[1].id,
      jobId: jobs[0].id,
      invoiceNumber: "DEMO-INV-1002",
      price: "120000",
      date: "2026-09-18",
      category: "LABOUR",
      status: "APPROVED",
      paid: "60000",
      description: "[DEMO] Installation and testing",
    },
    {
      id: "demo-bill-1003",
      vendorId: vendors[2].id,
      jobId: jobs[1].id,
      invoiceNumber: "DEMO-INV-1003",
      price: "198000",
      date: "2026-10-10",
      category: "EQUIPMENT",
      status: "APPROVED",
      paid: "0",
      description: "[DEMO] Switchgear and equipment",
    },
    {
      id: "demo-bill-1004",
      vendorId: vendors[1].id,
      jobId: jobs[2].id,
      invoiceNumber: "DEMO-INV-1004",
      price: "230000",
      date: "2026-10-15",
      category: "MATERIALS",
      status: "APPROVED",
      paid: "100000",
      description: "[DEMO] Lighting fixtures",
    },
    {
      id: "demo-bill-1005",
      vendorId: vendors[0].id,
      jobId: jobs[0].id,
      invoiceNumber: "DEMO-INV-1005",
      price: "12500",
      date: "2026-10-21",
      category: "MATERIALS",
      status: "PENDING_APPROVAL",
      paid: "0",
      description: "[DEMO] Additional cable supply",
    },
    {
      id: "demo-bill-1006",
      vendorId: vendors[2].id,
      jobId: jobs[3].id,
      invoiceNumber: "DEMO-INV-1006",
      price: "850",
      date: "2026-10-24",
      category: "TRANSPORT",
      status: "DRAFT",
      paid: "0",
      description: "[DEMO] Equipment transport",
    },
  ];
  for (const fixture of invoices) {
    await db.$transaction(async (tx) => {
      if (await tx.bill.findUnique({ where: { id: fixture.id } })) return;
      const totals = calculateBill(
        [
          {
            description: fixture.description,
            quantity: "1",
            unitPrice: fixture.price,
          },
        ],
        "0",
        "5",
      );
      const status =
        fixture.status === "APPROVED" && !accounts
          ? "PENDING_APPROVAL"
          : fixture.status;
      const paid = status === "APPROVED" ? fixture.paid : "0";
      const { netAmount: _netAmount, lines, ...amounts } = totals;
      void _netAmount;
      const created = await tx.bill.create({
        data: {
          id: fixture.id,
          companyId,
          vendorId: fixture.vendorId,
          jobId: fixture.jobId,
          invoiceNumber: fixture.invoiceNumber,
          normalizedInvoiceNumber: normalizeInvoiceNumber(
            fixture.invoiceNumber,
          ),
          invoiceDate: new Date(`${fixture.date}T00:00:00.000Z`),
          dueDate: new Date("2026-11-15T00:00:00.000Z"),
          category: fixture.category,
          currency: "AED",
          description: fixture.description,
          notes:
            "FICTIONAL DEVELOPMENT DATA ONLY. No external financial transaction exists.",
          status,
          ...amounts,
          paidAmount: paid,
          createdById: admin.id,
          approvedById: status === "APPROVED" ? accounts!.id : null,
          approvedAt:
            status === "APPROVED"
              ? new Date(`${fixture.date}T12:00:00.000Z`)
              : null,
          lines: { create: lines },
          syncRecords: { create: [{ target: "ZOHO" }, { target: "CRM" }] },
        },
      });
      if (paid !== "0")
        await tx.payment.create({
          data: {
            billId: created.id,
            amount: paid,
            reference: `[DEMO] PAYMENT-${fixture.id}`,
            createdById: accounts!.id,
          },
        });
      await tx.auditLog.create({
        data: {
          actorId: admin.id,
          companyId,
          action: "DEMO_SEEDED",
          entityType: "Bill",
          entityId: created.id,
          details: {
            fictional: true,
            status,
            invoiceNumber: fixture.invoiceNumber,
          },
        },
      });
    });
  }
  console.log(
    "Fictional development fixtures are ready. Credentials remain in your local environment; external services are disconnected.",
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Demo seed failed.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
