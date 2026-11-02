import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { cp, copyFile, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { createBill } from "@/lib/services/bills";
import { createVendor, createJob } from "@/lib/services/catalog";
import { attachDocument } from "@/lib/services/documents";
import { assertMySqlTestDatabase, createTestCompany } from "./company-fixtures";

// Unlike browser fixtures, these requests pass through the real Next proxy,
// cookie authentication, route handlers and services using disposable MySQL.
const require = createRequire(import.meta.url);
const root = process.cwd(), tag = randomUUID().slice(0, 8);
const fixtureParent = path.join(root, ".local");
const password = "Fictional-Accounts-HTTP-2026!";
const privateFields = ["contractValue", "approvedVariations", "adjustedValue",
  "recognizedExpenses", "paidExpenses", "outstanding", "estimatedProfit",
  "remainingBudget", "expensePercentage"];
let administrator: Actor, accountant: Actor;
let directory = "", origin = "", cookie = "", server: ChildProcess | undefined;
let childError = "", childExited = false, logs = "";
const fixtures: { company: string; job: string; vendor: string; bill: string;
  document: string; amount: string; contract: string }[] = [];

async function request(resource: string, init: RequestInit = {}) {
  return fetch(`${origin}${resource}`, {
    ...init, redirect: "manual",
    headers: { Cookie: cookie, Origin: origin, ...init.headers },
    signal: AbortSignal.timeout(60_000),
  });
}
async function json(resource: string) {
  const response = await request(resource);
  expect(response.status, resource).toBe(200);
  return response.json();
}
async function availablePort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No local fixture port.");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}
async function isolatedServer() {
  await mkdir(fixtureParent, { recursive: true });
  // Next's Windows Webpack entries require source/dependencies on the same drive.
  directory = await mkdtemp(path.join(fixtureParent, "restricted-http-"));
  // An allowlist avoids Next loading the workspace .env or private artifacts.
  await cp(path.join(root, "src"), path.join(directory, "src"), { recursive: true });
  for (const file of ["package.json", "tsconfig.json", "next.config.ts", "postcss.config.mjs", "next-env.d.ts"])
    await copyFile(path.join(root, file), path.join(directory, file));
  await symlink(path.join(root, "node_modules"), path.join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const publicKey = path.join(".local", "mysql-dev", "data", "public_key.pem");
  await mkdir(path.dirname(path.join(directory, publicKey)), { recursive: true });
  await copyFile(path.join(root, publicKey), path.join(directory, publicKey));
  origin = `http://127.0.0.1:${await availablePort()}`;
  const environment: NodeJS.ProcessEnv = { NODE_ENV: "development" };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "COMSPEC"])
    if (process.env[key]) environment[key] = process.env[key];
  Object.assign(environment, {
    NODE_ENV: "development", APP_ENV: "test", APP_URL: origin,
    DATABASE_URL: process.env.DATABASE_URL, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    DATABASE_TLS_MODE: "disabled", DATABASE_TLS_CA_FILE: "",
    UPLOAD_DIR: process.env.UPLOAD_DIR, NEXT_TELEMETRY_DISABLED: "1",
    INTEGRATION_NETWORK_ENABLED: "false", ZOHO_BOOKS_WRITE_ENABLED: "false",
    ZOHO_BOOKS_LIVE_ENABLED: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
    OCR_ENABLED: "false", OCR_PROVIDER: "disabled",
  });
  server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", directory,
    "--webpack", "--hostname", "127.0.0.1", "--port", new URL(origin).port],
  { cwd: directory, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  server.on("error", () => { childError = "Isolated HTTP server could not start."; });
  server.on("exit", () => { childExited = true; });
  const record = (chunk: Buffer) => { logs = `${logs}${chunk.toString()}`.slice(-12_000); };
  server.stdout?.on("data", record); server.stderr?.on("data", record);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (childError || childExited) break;
    try {
      if ((await fetch(`${origin}/login`, { signal: AbortSignal.timeout(15_000) })).ok) {
        expect(logs).not.toMatch(/Environments:.*\.env/);
        return;
      }
    } catch { /* bounded startup */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  // Driver errors can contain connection identities; retain no child log output.
  throw new Error(childError || `Isolated HTTP server failed readiness (exited=${childExited}, outputCaptured=${logs.length > 0}).`);
}

beforeAll(async () => {
  assertMySqlTestDatabase();
  const passwordHash = await hashPassword(password);
  [administrator, accountant] = await Promise.all((["ADMIN", "ACCOUNTS"] as const).map(role => db.user.create({
    data: { email: `restricted-${role.toLowerCase()}-${tag}@example.invalid`, name: `Fictional ${role}`, role, passwordHash },
  })));
  for (let index = 0; index < 3; index++) {
    const company = await createTestCompany(`restricted HTTP ${tag} ${index}`, index < 2 ? [administrator, accountant] : [administrator]);
    const vendor = await createVendor(administrator, { companyId: company.id, name: `Fictional HTTP supplier ${tag} ${index}`, currency: "AED" });
    const contract = `${912345 - index * 100000}.67`, amount = `${17 + index * 6}.00`;
    const job = await createJob(administrator, { companyId: company.id, jobNumber: `ROLE-${tag}-${index}`, name: "Fictional role work", customer: "Fictional role customer", contractValue: contract, currency: "AED" });
    const bill = await createBill(administrator, { companyId: company.id, vendorId: vendor.id, jobId: job.id,
      invoiceNumber: `ROLE-${tag}-${index}`, invoiceDate: "2026-11-02", category: "OTHER", currency: "AED",
      discount: "0", vatRate: "0", lines: [{ description: "Fictional role fixture", quantity: "1", unitPrice: amount }] });
    const document = await attachDocument(administrator, bill.id, new File([`%PDF-1.7\nFictional Accounts HTTP ${tag} ${index}\n%%EOF`], "fictional-role.pdf", { type: "application/pdf" }));
    fixtures.push({ company: company.id, vendor: vendor.id, job: job.id, bill: bill.id, document: document.id, amount, contract });
  }
  await isolatedServer();
  const login = await request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: accountant.email, password }) });
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie.startsWith("voltronix_session=")).toBe(true);
}, 180_000);

afterAll(async () => {
  if (cookie && !childExited) await request("/api/auth/logout", { method: "POST" }).catch(() => undefined);
  cookie = "";
  if (server?.pid && !childExited) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else server.kill("SIGTERM");
    await new Promise(resolve => { if (childExited) resolve(undefined); else { server!.once("exit", resolve); setTimeout(resolve, 5000); } });
  }
  if (directory) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(fixtureParent) || !path.basename(resolved).startsWith("restricted-http-"))
      throw new Error("Unexpected HTTP fixture cleanup path.");
    // Remove the module junction before deleting only the verified owned temp tree.
    await unlink(path.join(resolved, "node_modules")).catch(error => { if (error.code !== "ENOENT") throw error; });
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  const fixturePassword = new URL(process.env.DATABASE_URL!).password;
  await writeFile(path.join(fixtureParent, "restricted-accounts-http-last.log"),
    logs.replaceAll(fixturePassword, "[redacted]").replace(/mysql:\/\/[^@\s]+@/gi, "mysql://[redacted]@"));
  logs = "";
  await db.$disconnect();
}, 30_000);

describe("real HTTP restricted Accounts authorization", () => {
  it("authenticates the actual Accounts role and lists only its two companies", async () => {
    expect((await json("/api/auth/me")).user.role).toBe("ACCOUNTS");
    const result = await json("/api/companies");
    expect(result.companies.map((company: {id: string}) => company.id).sort()).toEqual(fixtures.slice(0, 2).map(row => row.company).sort());
  }, 60_000);

  it.each(["/api/dashboard", "/api/reports/bills", "/api/reports/bills?format=csv", "/api/audit", "/api/operations",
    "/api/integrations/jobs", "/api/integrations/incoming-status", "/api/ocr", "/api/ocr/templates", "/api/integrations/crm/authorization"])("denies direct sensitive API %s even with a forged safe-path header", async resource => {
    const response = await request(resource, { headers: { "x-voltronix-resource-path": "/api/bills", "x-voltronix-return-path": "/bills/manual" } });
    expect(response.status, resource).toBe(403);
    expect(response.headers.get("content-type")).not.toContain("text/csv");
  }, 60_000);

  it.each(["/api/ocr", "/api/ocr/templates"])("denies excluded OCR writes before parsing a payload at %s", async resource => {
    const response = await request(resource, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(403);
  }, 60_000);

  it("keeps bills, vendor amounts and originals accessible for both memberships", async () => {
    for (const row of fixtures.slice(0, 2)) {
      const bills = await json(`/api/bills?companyId=${row.company}`);
      expect(bills.bills).toEqual(expect.arrayContaining([expect.objectContaining({ id: row.bill, total: row.amount })]));
      const vendors = await json(`/api/vendors?companyId=${row.company}`);
      expect(vendors.vendors).toEqual(expect.arrayContaining([expect.objectContaining({ id: row.vendor })]));
      const response = await request(`/api/documents/${row.document}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/pdf");
      expect(await response.text()).toContain(`Fictional Accounts HTTP ${tag}`);
    }
  }, 90_000);

  it("redacts job aggregates while retaining native bill rows and manual lookup", async () => {
    for (const row of fixtures.slice(0, 2)) {
      const detail = await json(`/api/jobs/${row.job}`);
      for (const field of privateFields) expect(detail.job[field], field).toBeNull();
      expect(detail.bills).toEqual(expect.arrayContaining([expect.objectContaining({ id: row.bill, total: row.amount })]));
      expect(JSON.stringify(detail)).not.toContain(row.contract);
      const search = await json(`/api/dashboard/search?companyId=${row.company}&q=ROLE-${tag}`);
      expect(search.jobs).toEqual(expect.arrayContaining([expect.objectContaining({ id: row.job })]));
      expect(search.bills).toEqual(expect.arrayContaining([expect.objectContaining({ id: row.bill, total: row.amount })]));
      expect(JSON.stringify(search)).not.toContain(row.contract);
      expect(search.jobs.every((job: Record<string, unknown>) => !Object.hasOwn(job, "contractValue"))).toBe(true);
    }
  }, 90_000);

  it("rejects direct third-company bill, job, vendor, original and filter access", async () => {
    const row = fixtures[2];
    for (const resource of [`/api/bills/${row.bill}`, `/api/jobs/${row.job}`, `/api/documents/${row.document}`,
      `/api/bills?companyId=${row.company}`, `/api/vendors?companyId=${row.company}`, `/api/dashboard/search?companyId=${row.company}&q=ROLE-${tag}`])
      expect((await request(resource)).status, resource).toBe(404);
  }, 90_000);

  it.each(["/dashboard", "/management", "/audit", "/approvals", "/ocr", "/integrations", "/jobs", "/account/books-authorization", "/account/crm-authorization"])("redirects a direct forbidden page %s to bill entry", async resource => {
    const response = await request(resource);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/bills/manual");
  }, 60_000);

  it("refreshes company memberships on an existing cookie", async () => {
    const row = fixtures[1];
    await db.userCompanyMembership.update({ where: { userId_companyId: { userId: accountant.id, companyId: row.company } }, data: { active: false } });
    try {
      expect((await request(`/api/bills/${row.bill}`)).status).toBe(404);
      expect((await json("/api/companies")).companies.map((company: {id: string}) => company.id)).toEqual([fixtures[0].company]);
    } finally {
      await db.userCompanyMembership.update({ where: { userId_companyId: { userId: accountant.id, companyId: row.company } }, data: { active: true } });
    }
  }, 60_000);

  it("refreshes the current database role rather than retaining session privileges", async () => {
    await db.user.update({ where: { id: accountant.id }, data: { role: "MANAGEMENT" } });
    try {
      expect((await request("/api/dashboard")).status).toBe(200);
    } finally {
      await db.user.update({ where: { id: accountant.id }, data: { role: "ACCOUNTS" } });
    }
    expect((await request("/api/dashboard", { headers: { "x-voltronix-role": "ADMIN" } })).status).toBe(403);
  }, 60_000);
});
