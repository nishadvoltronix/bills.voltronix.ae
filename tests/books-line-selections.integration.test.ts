import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth";
import type { BooksSelection } from "@/lib/books-selection";
import { booksSelectionSchema } from "@/lib/books-selection";
import { db } from "@/lib/db";
import { getConfig } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { approvedSnapshot } from "@/lib/integrations/source-snapshot";
import { sourceInclude } from "@/lib/integrations/source-snapshot";
import { queueBill } from "@/lib/integrations/queue";
import { actOnBill, createBill, createBillInTransaction, getBill, prepareBillBooksSelections, updateBill } from "@/lib/services/bills";
import { createJob, createVendor } from "@/lib/services/catalog";
import { billInputSchema } from "@/lib/validation";
import { assertMySqlTestDatabase, bindTestDestination, createTestCompany } from "./company-fixtures";

// Provider reads are mocked; persistence and transaction boundaries use disposable MySQL only.
const verifier = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/bill-books-options", () => ({ verifyBillBooksSelections: verifier }));
const tag = randomUUID().slice(0, 8);
const organizationId = `991${Date.now()}`;
let actor: Actor;
let companyId: string;
let otherCompanyId: string;
let vendorId: string;
let jobId: string;
const selection = (): BooksSelection => ({ organizationId, dataCenter: "US", environment: "sandbox", accountId: "110",
  accountName: "Untrusted client label", taxId: "120", taxName: "Untrusted client tax", taxRate: "5.00",
  customerId: "130", customerName: "Untrusted client customer" });
const input = (extra: Record<string, unknown> = {}) => ({ companyId, vendorId, jobId,
  invoiceNumber: `LINE-${tag}-${randomUUID()}`, invoiceDate: "2026-10-29", category: "LABOUR", currency: "AED",
  discount: "0", vatRate: "99", lines: [{ description: "Fictional selected labour", quantity: "2", unitPrice: "50.00", booksSelection: selection() }],
  submit: false, ...extra });

beforeAll(async () => {
  assertMySqlTestDatabase();
  actor = await db.user.create({ data: { email: `books-lines-${tag}@example.invalid`, name: "Fictional selection operator",
    role: "ADMIN", passwordHash: "unused-fixture" } });
  companyId = (await createTestCompany(`books selected lines ${tag}`, [actor])).id;
  otherCompanyId = (await createTestCompany(`other books lines ${tag}`, [actor])).id;
  vendorId = (await createVendor(actor, { companyId, name: `Fictional line supplier ${tag}`, currency: "AED" })).id;
  jobId = (await createJob(actor, { companyId, jobNumber: `LINE-${tag}`, name: "Fictional line job", customer: "Fictional customer", currency: "AED" })).id;
  await bindTestDestination(companyId, { target: "ZOHO", organizationId });
  for (const [key, value] of Object.entries({ INTEGRATION_NETWORK_ENABLED: "true", ZOHO_BOOKS_NETWORK_ENABLED: "true",
    ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
    ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "sandbox", ZOHO_BOOKS_CLIENT_ID: "fictional-client", ZOHO_BOOKS_CLIENT_SECRET: "fictional-secret",
    ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([{ organizationId, name: "Fictional Books organization",
      mapping: { verified: true, baseCurrency: "AED", currencies: { AED: { id: "101" } }, taxes: {}, categories: {} } }]),
  })) vi.stubEnv(key, value);
  await db.integrationCredential.create({ data: { target: "ZOHO", organizationId, dataCenter: "US",
    connectionFingerprint: connectionFingerprint(getConfig("ZOHO", process.env, organizationId)), refreshTokenEncrypted: "never-decrypted-fixture" } });
});
beforeEach(() => {
  verifier.mockReset();
  verifier.mockImplementation(async (_actor: Actor, selectedCompanyId: string, selections: (BooksSelection | null)[]) => {
    expect(selectedCompanyId).toBe(companyId);
    return selections.map((value) => value ? booksSelectionSchema.parse({ ...value, accountName: "Verified purchase account",
      taxName: value.taxId === "121" ? "Verified zero rate" : "Verified standard rate", taxRate: value.taxId === "121" ? "0.00" : "5.00",
      customerName: value.customerId ? "Verified customer" : null }) : null);
  });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No actual provider calls are allowed in persistence fixtures."); }));
});
afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await db.$disconnect(); });

describe("durable verified Books line selections", () => {
  it("saves and reloads normalized provider identities and calculates from verified line rates", async () => {
    const saved = await createBill(actor, input());
    expect(saved).toMatchObject({ subtotal: "100.00", vatRate: "5.00", vatAmount: "5.00", total: "105.00", usesBooksLineTaxes: true });
    const current = await getBill(actor, saved.id);
    expect(current.lines[0].booksSelection).toMatchObject({ organizationId, accountId: "110", accountName: "Verified purchase account",
      taxId: "120", taxName: "Verified standard rate", taxRate: "5.00", customerId: "130", customerName: "Verified customer" });
    expect(JSON.stringify(current)).not.toContain("Untrusted client");
    const source = await db.bill.findUniqueOrThrow({ where: { id: saved.id }, include: sourceInclude });
    expect(approvedSnapshot(source, "104").lines[0].booksSelection).toEqual(current.lines[0].booksSelection);
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: saved.id, action: "BILL_CREATED" } });
    expect(JSON.stringify(audit.details)).toContain('"accountId":"110"');
    expect(JSON.stringify(audit.details)).toContain('"usesBooksLineTaxes":true');
  });
  it("updates line identity with before/after audits and refuses silent omission on later edits", async () => {
    const original = input();
    const saved = await createBill(actor, original);
    const changed = { ...original, version: saved.version, lines: [{ ...original.lines[0], quantity: "3",
      booksSelection: { ...selection(), accountId: "111", customerId: null, customerName: null } }] };
    const updated = await updateBill(actor, saved.id, changed);
    expect(updated.lines[0].booksSelection).toMatchObject({ accountId: "111", customerId: null, customerName: null });
    expect(updated.total).toBe("157.50");
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: saved.id, action: "BILL_UPDATED" } });
    expect(JSON.stringify(audit.details)).toContain('"accountId":"110"');
    expect(JSON.stringify(audit.details)).toContain('"accountId":"111"');
    const { booksSelection, ...legacyLine } = changed.lines[0]; void booksSelection;
    await expect(updateBill(actor, saved.id, { ...changed, version: updated.version, lines: [legacyLine] }))
      .rejects.toMatchObject({ status: 422 });
    expect((await getBill(actor, saved.id)).version).toBe(updated.version);
    const cleared = await updateBill(actor, saved.id, { ...changed, version: updated.version, vatRate: "5", lines: [{ ...legacyLine, booksSelection: null }] });
    expect(cleared.lines[0]).not.toHaveProperty("booksSelection");
    expect(cleared).not.toHaveProperty("usesBooksLineTaxes");
    expect((await db.bill.findUniqueOrThrow({ where: { id: saved.id } })).usesBooksLineTaxes).toBe(false);
    expect((await db.billLine.findFirstOrThrow({ where: { billId: saved.id } })).booksSelection).toBeNull();
  });
  it("preserves legacy null storage and avoids all metadata reads for ordinary bills", async () => {
    const saved = await createBill(actor, input({ category: "MATERIALS", vatRate: "5", discount: "10",
      lines: [{ description: "Fictional legacy", quantity: "1", unitPrice: "100.00", booksSelection: null }] }));
    expect(saved.total).toBe("94.50");
    expect(saved.lines[0]).not.toHaveProperty("booksSelection");
    expect(saved).not.toHaveProperty("usesBooksLineTaxes");
    expect(verifier).not.toHaveBeenCalled();
    const source = await db.bill.findUniqueOrThrow({ where: { id: saved.id }, include: sourceInclude });
    expect(source.usesBooksLineTaxes).toBe(false);
    expect(approvedSnapshot(source).lines[0]).not.toHaveProperty("booksSelection");
    expect(approvedSnapshot(source)).not.toHaveProperty("usesBooksLineTaxes");
  });
  it("refuses another company's provider destination before metadata reads or financial writes", async () => {
    const count = await db.bill.count();
    await expect(createBill(actor, input({ companyId: otherCompanyId }))).rejects.toMatchObject({ status: 422 });
    expect(verifier).not.toHaveBeenCalled();
    expect(await db.bill.count()).toBe(count);
  });
  it("rejects caller-supplied tax-mode flags before any verification or writes", async () => {
    const count = await db.bill.count();
    await expect(createBill(actor, input({ usesBooksLineTaxes: false }))).rejects.toMatchObject({ name: "ZodError" });
    await expect(createBill(actor, input({ usesBooksLineTaxes: true, lines: [
      { description: "Fictional legacy line", quantity: "1", unitPrice: "100" },
    ] }))).rejects.toMatchObject({ name: "ZodError" });
    expect(verifier).not.toHaveBeenCalled();
    expect(await db.bill.count()).toBe(count);
  });
  it("rejects unsupported selected discounts and partially selected bills without persisting lines", async () => {
    const count = await db.bill.count();
    await expect(createBill(actor, input({ discount: "1" }))).rejects.toMatchObject({ status: 422 });
    await expect(createBill(actor, input({ lines: [...input().lines, { description: "Unselected line", quantity: "1", unitPrice: "5" }] })))
      .rejects.toMatchObject({ status: 422 });
    expect(await db.bill.count()).toBe(count);
  });
  it("binds preverification to exact ordered line amounts and refuses forged transaction proofs", async () => {
    const data = billInputSchema.parse(input());
    const proof = await prepareBillBooksSelections(actor, companyId, data.lines);
    await expect(db.$transaction((tx) => createBillInTransaction(tx, actor, { ...data,
      lines: [{ ...data.lines[0], unitPrice: "60.00" }] }, proof))).rejects.toMatchObject({ status: 422 });
    await expect(db.$transaction((tx) => createBillInTransaction(tx, actor, data, { kind: "verified-books-lines" })))
      .rejects.toMatchObject({ status: 422 });
  });
  it("rechecks a revoked grant inside the save transaction", async () => {
    const data = billInputSchema.parse(input());
    const proof = await prepareBillBooksSelections(actor, companyId, data.lines);
    await db.integrationCredential.update({ where: { target_organizationId: { target: "ZOHO", organizationId } }, data: { revokedAt: new Date() } });
    try {
      await expect(db.$transaction((tx) => createBillInTransaction(tx, actor, data, proof))).rejects.toMatchObject({ status: 422 });
    } finally {
      await db.integrationCredential.update({ where: { target_organizationId: { target: "ZOHO", organizationId } }, data: { revokedAt: null } });
    }
  });
  it("rejects a second company destination added after provider verification", async () => {
    const data = billInputSchema.parse(input());
    const proof = await prepareBillBooksSelections(actor, companyId, data.lines);
    const second = await bindTestDestination(companyId, { target: "ZOHO", organizationId: `${organizationId}2` });
    try {
      await expect(db.$transaction((tx) => createBillInTransaction(tx, actor, data, proof))).rejects.toMatchObject({ status: 422 });
    } finally {
      await db.companyIntegrationDestination.delete({ where: { companyId_target_organizationId_dataCenter_environment: {
        companyId, target: "ZOHO", organizationId: second.organizationId, dataCenter: second.dataCenter, environment: second.environment,
      } } });
    }
  });
  it("allows a normal token refresh without changing the verified connection identity", async () => {
    const data = billInputSchema.parse(input());
    const proof = await prepareBillBooksSelections(actor, companyId, data.lines);
    await db.integrationCredential.update({ where: { target_organizationId: { target: "ZOHO", organizationId } },
      data: { accessTokenEncrypted: "never-used-refreshed-fixture", updatedAt: new Date() } });
    const saved = await db.$transaction((tx) => createBillInTransaction(tx, actor, data, proof));
    expect(saved.lines[0].booksSelection).toMatchObject({ accountId: "110", taxRate: "5.00" });
  });
  it("finalizes from persisted mixed tax selections without using the header's zero placeholder", async () => {
    const saved = await createBill(actor, input({ lines: [...input().lines,
      { ...input().lines[0], booksSelection: { ...selection(), taxId: "121", taxRate: "0.00" } }] }));
    expect(saved).toMatchObject({ vatRate: "0.00", vatAmount: "5.00", total: "205.00", usesBooksLineTaxes: true });
    const ready = await actOnBill(actor, saved.id, { action: "submit", version: saved.version });
    expect(ready).toMatchObject({ status: "READY", vatAmount: "5.00", total: "205.00" });
    expect(await db.integrationJob.count({ where: { billId: saved.id } })).toBe(0);
    expect(ready.lines[0].booksSelection).toMatchObject({ accountId: "110" });
  });
  it("persists distinct tax-ID rounding even when all line percentages match", async () => {
    // Each 0.10 tax group rounds 0.005 to 0.01; one header formula would produce only 0.01.
    const saved = await createBill(actor, input({ lines: [
      { ...input().lines[0], quantity: "1", unitPrice: "0.10" },
      { ...input().lines[0], quantity: "1", unitPrice: "0.10", booksSelection: { ...selection(), taxId: "122" } },
    ] }));
    expect(saved).toMatchObject({ subtotal: "0.20", vatRate: "5.00", vatAmount: "0.02", total: "0.22", usesBooksLineTaxes: true });
    expect((await getBill(actor, saved.id)).total).toBe("0.22");
  });
  it("enforces the exact legacy VAT formula and all selected-mode financial bounds in MySQL", async () => {
    const legacy = await createBill(actor, input({ vatRate: "5", lines: [
      { description: "Fictional legacy bound", quantity: "1", unitPrice: "100" },
    ] }));
    await expect(db.$executeRaw`UPDATE Bill SET vatAmount=6,total=106 WHERE id=${legacy.id}`).rejects.toMatchObject({ code: "P2010" });
    expect((await db.bill.findUniqueOrThrow({ where: { id: legacy.id } })).usesBooksLineTaxes).toBe(false);
    const selected = await createBill(actor, input());
    await expect(db.$executeRaw`UPDATE Bill SET usesBooksLineTaxes=2 WHERE id=${selected.id}`).rejects.toMatchObject({ code: "P2010" });
    await expect(db.$executeRaw`UPDATE Bill SET discount=1,total=104 WHERE id=${selected.id}`).rejects.toMatchObject({ code: "P2010" });
    await expect(db.$executeRaw`UPDATE Bill SET vatAmount=101,total=201 WHERE id=${selected.id}`).rejects.toMatchObject({ code: "P2010" });
    await expect(db.$executeRaw`UPDATE Bill SET vatAmount=-1,total=99 WHERE id=${selected.id}`).rejects.toMatchObject({ code: "P2010" });
    await expect(db.$executeRaw`UPDATE Bill SET total=106 WHERE id=${selected.id}`).rejects.toMatchObject({ code: "P2010" });
    expect((await getBill(actor, selected.id)).total).toBe("105.00");
  });
  it("blocks finalization, snapshots and queueing when persisted mode disagrees with line selections", async () => {
    const saved = await createBill(actor, input({ vatRate: "5", lines: [
      { description: "Fictional corrupted mode", quantity: "1", unitPrice: "100" },
    ] }));
    await db.bill.update({ where: { id: saved.id }, data: { usesBooksLineTaxes: true } });
    const source = await db.bill.findUniqueOrThrow({ where: { id: saved.id }, include: sourceInclude });
    expect(() => approvedSnapshot(source)).toThrowError(expect.objectContaining({ code: "BILL_TAX_MODE_MISMATCH" }));
    await expect(actOnBill(actor, saved.id, { action: "submit", version: saved.version })).rejects.toMatchObject({ status: 422 });
    await expect(queueBill(actor, saved.id, "ZOHO", organizationId)).rejects.toMatchObject({ code: "BILL_TAX_MODE_MISMATCH" });
    expect(await db.integrationJob.count({ where: { billId: saved.id } })).toBe(0);
    const selected = await createBill(actor, input());
    await db.bill.update({ where: { id: selected.id }, data: { usesBooksLineTaxes: false } });
    await expect(actOnBill(actor, selected.id, { action: "submit", version: selected.version })).rejects.toMatchObject({ status: 422 });
  });
});
