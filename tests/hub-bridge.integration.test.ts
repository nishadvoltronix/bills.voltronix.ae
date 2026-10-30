import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { readHubJobBilling } from "@/lib/hub-bridge/service";
import type { HubClaims } from "@/lib/hub-bridge/verify";
import { POST } from "@/app/api/hub/job-billing/route";

const tag = randomUUID().slice(0, 8);
let userId: string, creatorId: string, companyId: string, otherCompanyId: string, jobId: string, vendorId: string;
const issuer = "http://127.0.0.1:3100", subject = `fixture-${tag}`, organization = "88441001", dealId = "88441002";
const now = new Date();
const hubWorkspace = path.resolve(import.meta.dirname, "..", "..", "hub.voltronix.ae");
function claims(changes: Partial<HubClaims> = {}): HubClaims {
  return { v: 1, iss: issuer, aud: "voltronix-billing", sub: subject, companyId, crmOrganizationId: organization,
    dataCenter: "US", environment: "sandbox", dealId, jobNumber: "DEMO-HUB-" + tag,
    iat: Math.floor(now.getTime() / 1000), exp: Math.floor(now.getTime() / 1000) + 30,
    nonce: randomBytes(32).toString("hex"), ...changes };
}
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? "http://invalid");
  if (process.env.APP_ENV !== "test" || url.protocol !== "mysql:" || url.hostname !== "127.0.0.1" || !/^\/bills_test_/.test(url.pathname))
    throw new Error("Hub bridge tests require the isolated billing MySQL fixture database.");
  const user = await db.user.create({ data: { name: "DEMO Hub reader", email: `hub-${tag}@example.invalid`, role: "MANAGEMENT", passwordHash: "not-a-login" } }); userId = user.id;
  creatorId = (await db.user.create({ data: { name: "DEMO bill creator", email: `hub-creator-${tag}@example.invalid`, role: "DATA_ENTRY", passwordHash: "not-a-login" } })).id;
  companyId = (await db.company.create({ data: { name: `DEMO Hub company ${tag}`, memberships: { create: [{ userId }, { userId: creatorId }] } } })).id;
  otherCompanyId = (await db.company.create({ data: { name: `DEMO Other Hub company ${tag}` } })).id;
  await db.hubUserBinding.create({ data: { issuer, subject, billingUserId: userId } });
  await db.companyIntegrationDestination.create({ data: { companyId, target: "CRM", organizationId: organization, dataCenter: "US", environment: "sandbox" } });
  vendorId = (await db.vendor.create({ data: { companyId, name: "DEMO Hub vendor", currency: "AED" } })).id;
  jobId = (await db.job.create({ data: { companyId, name: "DEMO Hub job", customer: "DEMO", jobNumber: "DEMO-HUB-" + tag, externalCrmId: dealId, currency: "AED" } })).id;
  await db.job.create({ data: { companyId: otherCompanyId, name: "DEMO Other job", customer: "DEMO", jobNumber: "DEMO-HUB-" + tag, externalCrmId: dealId, currency: "AED" } });
  await db.bill.create({ data: { companyId, vendorId, jobId, invoiceNumber: "DEMO-HUB-1", normalizedInvoiceNumber: "DEMO-HUB-1",
    invoiceDate: new Date("2026-10-28"), category: "OTHER", currency: "AED", status: "APPROVED", subtotal: "100.00", vatRate: "5.00",
    vatAmount: "5.00", total: "105.00", paidAmount: "25.00", createdById: creatorId, approvedById: userId, approvedAt: now } });
});
afterAll(() => db.$disconnect());

describe("real MySQL Hub Billing authorization", () => {
  it("returns exact approved totals and rejects replay across independent requests", async () => {
    const token = claims(); const result = await readHubJobBilling(token, db, now);
    expect(result.summary).toEqual({ recognizedExpenses: "100.00", grossPayable: "105.00", paid: "25.00", outstanding: "80.00" });
    expect(result.billCount).toBe(1); expect(result.bills[0].invoiceNumber).toBe("DEMO-HUB-1");
    await expect(readHubJobBilling(token, db, now)).rejects.toMatchObject({ status: 401 });
  });
  it("refuses unbound users, wrong company/organization/deal and matching job-number guesses", async () => {
    for (const change of [{ sub: "missing-user" }, { companyId: otherCompanyId }, { crmOrganizationId: "88449999" },
      { dealId: "88449998" }, { jobNumber: "DIFFERENT-JOB" }])
      await expect(readHubJobBilling(claims(change), db, now)).rejects.toMatchObject({ status: 404 });
  });
  it("includes a completed entry alongside historical approvals without inventing approval or payment", async () => {
    const ready = await db.bill.create({ data: { companyId, vendorId, jobId,
      invoiceNumber: "DEMO-HUB-READY", normalizedInvoiceNumber: "DEMO-HUB-READY",
      invoiceDate: new Date("2026-10-28"), category: "OTHER", currency: "AED", status: "READY",
      subtotal: "100.00", vatRate: "5.00", vatAmount: "5.00", total: "105.00", createdById: creatorId } });
    try {
      const result = await readHubJobBilling(claims(), db, now);
      expect(result.summary).toEqual({ recognizedExpenses: "200.00", grossPayable: "210.00", paid: "25.00", outstanding: "185.00" });
      expect(result.bills.find(bill => bill.id === ready.id)).toMatchObject({ status: "READY", outstanding: "105.00", paid: "0.00" });
      expect(ready.approvedAt).toBeNull(); expect(ready.approvedById).toBeNull();
    } finally { await db.bill.delete({ where: { id: ready.id } }); }
  });
  it("rechecks revoked membership, inactive users and finance roles", async () => {
    await db.userCompanyMembership.update({ where: { userId_companyId: { userId, companyId } }, data: { active: false } });
    try { await expect(readHubJobBilling(claims(), db, now)).rejects.toMatchObject({ status: 404 }); }
    finally { await db.userCompanyMembership.update({ where: { userId_companyId: { userId, companyId } }, data: { active: true } }); }
    await db.user.update({ where: { id: userId }, data: { active: false } });
    try { await expect(readHubJobBilling(claims(), db, now)).rejects.toMatchObject({ status: 404 }); }
    finally { await db.user.update({ where: { id: userId }, data: { active: true, role: "DATA_ENTRY" } }); }
    try { await expect(readHubJobBilling(claims(), db, now)).rejects.toMatchObject({ status: 404 }); }
    finally { await db.user.update({ where: { id: userId }, data: { role: "MANAGEMENT" } }); }
  });
  it("bounds the detail list while totals and count cover all matching bills", async () => {
    await db.bill.createMany({ data: Array.from({ length: 101 }, (_, index) => ({ id: `hub-${tag}-${index}`, companyId, vendorId, jobId,
      invoiceNumber: `DEMO-HUB-MORE-${index}`, normalizedInvoiceNumber: `DEMO-HUB-MORE-${index}`, invoiceDate: new Date("2026-10-27"),
      category: "OTHER", currency: "AED", status: "DRAFT" as const, subtotal: "1.00", vatAmount: "0.00", total: "1.00", createdById: creatorId })) });
    const result = await readHubJobBilling(claims(), db, now);
    expect(result.billCount).toBe(102); expect(result.bills).toHaveLength(100); expect(result.truncated).toBe(true);
    expect(result.summary.outstanding).toBe("80.00");
  });

  it.skipIf(!existsSync(path.join(hubWorkspace, "server/src/crm/billing/client.ts")))(
    "serves actual Hub signer/client requests over loopback HTTP and real MySQL, including revoked access", async () => {
      const previous = Object.fromEntries(["HUB_BRIDGE_ENABLED", "HUB_BRIDGE_ISSUER", "HUB_BRIDGE_SECRET"].map(key => [key, process.env[key]]));
      const secret = randomBytes(32).toString("hex");
      Object.assign(process.env, { HUB_BRIDGE_ENABLED: "true", HUB_BRIDGE_ISSUER: issuer, HUB_BRIDGE_SECRET: secret });
      const server = createServer(async (incoming, outgoing) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(name, value);
        try {
          const result = await POST(new Request("http://127.0.0.1" + incoming.url, { method: incoming.method, headers }));
          outgoing.writeHead(result.status, Object.fromEntries(result.headers)); outgoing.end(await result.text());
        } catch { outgoing.writeHead(503); outgoing.end(); }
      });
      try {
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing loopback listener.");
        const origin = `http://127.0.0.1:${address.port}`;
        const profile = { companyId, crmOrganizationId: organization, dataCenter: "US", environment: "sandbox" };
        const childEnvironment = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
        const run = async () => {
          const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
            "import {fetchJobBilling} from './server/src/crm/billing/client.ts'; const input=JSON.parse(process.env.BRIDGE_FIXTURE); console.log(JSON.stringify(await fetchJobBilling(input.config,input.subject,input.link)));"],
          { cwd: hubWorkspace, windowsHide: true, timeout: 12_000, maxBuffer: 256 * 1024, env: { ...childEnvironment,
            NODE_ENV: "test", CRM_MYSQL_NETWORK_DISABLED: "1", ZOHO_ENABLED: "false", ZOHO_NETWORK_DISABLED: "1",
            BRIDGE_FIXTURE: JSON.stringify({ config: { origin, issuer, secret, profiles: [profile] }, subject,
              link: { ...profile, dealId, jobNumber: "DEMO-HUB-" + tag } }) } });
          return JSON.parse(result.stdout);
        };
        const result = await run();
        expect(result.state).toBe("ready"); expect(result.summary.outstanding).toBe("80.00");
        expect(result.crmLinkStatus).toBe("LINKED"); expect(result.billingUrl).toBe(origin + "/jobs/" + jobId);
        expect(result.bills.every((bill: { billingUrl: string; id: string }) => bill.billingUrl === origin + "/bills/" + bill.id)).toBe(true);
        await db.userCompanyMembership.update({ where: { userId_companyId: { userId, companyId } }, data: { active: false } });
        expect(await run()).toEqual({ state: "unavailable" });
      } finally {
        await db.userCompanyMembership.update({ where: { userId_companyId: { userId, companyId } }, data: { active: true } });
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      }
    }, 30_000);

  it.skipIf(!process.env.HUB_BRIDGE_MYSQL_FIXTURE)("serves the authenticated native Hub application against a separate real MySQL fixture", async () => {
    const previous = Object.fromEntries(["HUB_BRIDGE_ENABLED", "HUB_BRIDGE_ISSUER", "HUB_BRIDGE_SECRET"].map(key => [key, process.env[key]]));
    const secret = randomBytes(32).toString("hex");
    Object.assign(process.env, { HUB_BRIDGE_ENABLED: "true", HUB_BRIDGE_ISSUER: issuer, HUB_BRIDGE_SECRET: secret });
    await db.hubUserBinding.create({ data: { issuer, subject: "7701", billingUserId: userId } });
    const server = createServer(async (incoming, outgoing) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(name, value);
      try {
        const result = await POST(new Request("http://127.0.0.1" + incoming.url, { method: incoming.method, headers }));
        outgoing.writeHead(result.status, Object.fromEntries(result.headers)); outgoing.end(await result.text());
      } catch { outgoing.writeHead(503); outgoing.end(); }
    });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing loopback listener.");
      const childEnvironment = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
      const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "server/scripts/billing-bridge-acceptance.ts"], {
        cwd: hubWorkspace, windowsHide: true, timeout: 45_000, maxBuffer: 256 * 1024,
        env: { ...childEnvironment, NODE_ENV: "test", CRM_MYSQL_NETWORK_DISABLED: "0", ZOHO_ENABLED: "false", ZOHO_NETWORK_DISABLED: "1",
          BILLING_ACCEPTANCE_ACK: "new-native-hub-fixture-only", HUB_BRIDGE_MYSQL_FIXTURE: process.env.HUB_BRIDGE_MYSQL_FIXTURE,
          BILLING_ACCEPTANCE_INPUT: JSON.stringify({ origin: `http://127.0.0.1:${address.port}`, issuer, secret, dealId,
            jobNumber: "DEMO-HUB-" + tag, profile: { companyId, crmOrganizationId: organization, dataCenter: "US", environment: "sandbox" } }) },
      });
      const receipt = JSON.parse(result.stdout);
      expect(receipt.status).toBe("passed"); expect(receipt.checks).toContain("native MySQL HTTP login and CSRF");
      expect(receipt.checks).toContain("actual Hub API to Billing API with real MySQL");
      expect(receipt.checks).toContain("current assignment revocation enforced");
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  }, 60_000);
});
