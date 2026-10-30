import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createBill } from "@/lib/services/bills";
import { verifyRestoredDatabase } from "@/lib/security/restore-verification";
import { assertMySqlTestDatabase, createTestCompany } from "./company-fixtures";

afterAll(async () => {
  await db.$disconnect();
});

describe("restored-data consistency verifier", () => {
  it("detects a cross-record line-total discrepancy and refuses incorrect source counts without mutating the records", async () => {
    assertMySqlTestDatabase();
    const tag = randomUUID();
    const actor = await db.user.create({
      data: {
        email: `restore-${tag}@example.invalid`,
        name: "Fictional restore verifier",
        role: "DATA_ENTRY",
        passwordHash: "unusable-test-fixture-hash",
      },
    });
    const company = await createTestCompany(`restore verifier ${tag}`, [actor]);
    const vendor = await db.vendor.create({
      data: {
        companyId: company.id,
        name: `Fictional restore vendor ${tag}`,
        currency: "AED",
        isDemo: true,
      },
    });
    const job = await db.job.create({
      data: {
        companyId: company.id,
        jobNumber: `RESTORE-${tag}`,
        name: "Fictional restore job",
        customer: "Fictional restore customer",
        currency: "AED",
        contractValue: "1000",
        isDemo: true,
      },
    });
    const bill = await createBill(actor, {
      vendorId: vendor.id,
      jobId: job.id,
      invoiceNumber: `RESTORE-${tag}`,
      invoiceDate: "2026-10-27",
      currency: "AED",
      category: "OTHER",
      vatRate: "5",
      lines: [
        {
          description: "Fictional restore control",
          quantity: "1",
          unitPrice: "100",
        },
      ],
    });
    const expected = {
      bills: await db.bill.count(),
      documents: await db.document.count(),
      booksBills: await db.booksBill.count(),
      booksAttachments: await db.booksBillAttachment.count(),
    };
    const before = await verifyRestoredDatabase(db, expected);
    await db.billLine.update({
      where: { id: bill.lines[0].id },
      data: { unitPrice: "101", lineTotal: "101" },
    });
    try {
      const damaged = await verifyRestoredDatabase(db, expected);
      expect(damaged.invalidLineTotals).toBe(before.invalidLineTotals + 1);
      expect(damaged.passed).toBe(false);
      const wrongCounts = await verifyRestoredDatabase(db, {
        ...expected,
        bills: expected.bills + 1,
      });
      expect(wrongCounts.expectedCountsMatch).toBe(false);
      expect(
        (await db.bill.findUniqueOrThrow({ where: { id: bill.id } })).version,
      ).toBe(bill.version);
      expect(
        (
          await db.billLine.findUniqueOrThrow({
            where: { id: bill.lines[0].id },
          })
        ).lineTotal.toString(),
      ).toBe("101");
    } finally {
      await db.billLine.update({
        where: { id: bill.lines[0].id },
        data: { unitPrice: "100", lineTotal: "100" },
      });
    }
  });
});
