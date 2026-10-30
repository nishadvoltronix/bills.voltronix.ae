import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { syntheticInvoicePdf } from "./lib/ocr-synthetic-invoice.mjs";
import { isolatedProviderEnvironment } from "./lib/test-provider-environment.mjs";

// Real Next lifetimes + real MySQL + separate mocked worker processes. No dev data.
const root = path.resolve(import.meta.dirname, "..");
let db, server, log;
let receipt, directory;
async function stop() {
  if (server && server.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else server.kill("SIGTERM");
    for (let i = 0; i < 50 && server.exitCode === null; i++) await delay(100);
    assert.notEqual(server.exitCode, null, "Owned application failed to stop.");
  }
  server = undefined;
  if (log !== undefined) fs.closeSync(log);
  log = undefined;
}
try {
  const { assertMySqlTestDatabase } = await import("../tests/company-fixtures.ts");
  assertMySqlTestDatabase();
  assert.ok(fs.existsSync(path.join(root, ".next", "BUILD_ID")), "Run npm run build before the OCR restart check.");
  ({ db } = await import("../src/lib/db.ts"));
  const { hashPassword } = await import("../src/lib/password.ts");
  directory = path.resolve(process.env.UPLOAD_DIR, "..", "ocr-restart");
  assert.ok(directory.startsWith(path.join(root, ".local", "mysql-dev", "test-runs") + path.sep));
  fs.mkdirSync(directory, { recursive: true });
  const port = 3011, origin = `http://127.0.0.1:${port}`;
  const env = { ...isolatedProviderEnvironment(process.env), NODE_ENV: "production", APP_ENV: "test", APP_URL: origin,
    NEXT_TELEMETRY_DISABLED: "1", OCR_PROVIDER: "azure_document_intelligence",
    AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://fictional-ocr.cognitiveservices.azure.com/",
    AZURE_DOCUMENT_INTELLIGENCE_KEY: "fictional-restart-key-not-a-credential" };
  async function start(label) {
    await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", () => reject(new Error("OCR restart-test port is occupied; no existing process was stopped.")));
      probe.listen(port, "127.0.0.1", () => probe.close(resolve));
    });
    log = fs.openSync(path.join(directory, `${label}.log`), "w");
    server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)],
      { cwd: root, env, windowsHide: true, stdio: ["ignore", log, log] });
    for (let i = 0; i < 100; i++) {
      assert.equal(server.exitCode, null, "Owned application exited before readiness.");
      try { if ((await fetch(`${origin}/login`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* startup */ }
      await delay(300);
    }
    throw new Error("Owned application readiness timed out.");
  }
  const email = `ocr-restart-${randomUUID()}@example.invalid`, password = randomBytes(32).toString("hex");
  const user = await db.user.create({ data: { name: "DEMO OCR restart creator", email, role: "DATA_ENTRY", passwordHash: await hashPassword(password) } });
  const company = await db.company.create({ data: { name: "DEMO OCR restart company", memberships: { create: { userId: user.id } } } });
  const vendor = await db.vendor.create({ data: { companyId: company.id, name: "Fictional OCR Supplier", currency: "AED", isDemo: true } });
  const job = await db.job.create({ data: { companyId: company.id, jobNumber: "OCR-TEST", name: "DEMO OCR restart job", customer: "DEMO", currency: "AED", isDemo: true } });
  const invoiceNumber = `DEMO-OCR-RESTART-${Date.now()}`;
  const bytes = syntheticInvoicePdf(invoiceNumber);
  const hash = value => createHash("sha256").update(value).digest("hex");
  async function signIn() {
    const response = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    assert.equal(response.status, 200, "Fixture HTTP login failed.");
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0]; assert.ok(cookie); return cookie;
  }
  async function request(cookie, route, options = {}) {
    const response = await fetch(`${origin}${route}`, { ...options, headers: { Origin: origin, Cookie: cookie, ...options.headers }, signal: AbortSignal.timeout(15000) });
    assert.ok(response.ok, "Fixture API request failed."); return response;
  }
  async function worker(phase, documentId, operationId) {
    const result = spawnSync(process.execPath, ["--conditions=react-server", "--import=tsx", "tests/helpers/ocr-restart-worker.ts"], {
      cwd: root, env: { ...env, NODE_ENV: "test", OCR_RESTART_INPUT: JSON.stringify({ phase, documentId, operationId, invoiceNumber }) },
      windowsHide: true, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.status, 0, "Isolated worker process failed.");
    return JSON.parse(result.stdout);
  }
  await start("before");
  let cookie = await signIn();
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: "application/pdf" }), "demo-ocr-restart.pdf");
  const uploaded = await (await request(cookie, `/api/ocr?companyId=${company.id}`, { method: "POST", body: form })).json();
  const documentId = uploaded.batch.documents[0].id;
  assert.equal(uploaded.batch.documents[0].status, "QUEUED");
  assert.equal((await fetch(`${origin}/api/ocr/documents/${documentId}/file`)).status, 401);
  const operationId = randomUUID();
  const started = await worker("start", documentId, operationId);
  const processing = await db.ocrDocument.findUniqueOrThrow({ where: { id: documentId } });
  assert.equal(processing.status, "PROCESSING"); assert.equal(processing.providerRequestId, operationId);
  await stop();
  await start("after-first-restart");
  cookie = await signIn();
  const persisted = (await (await request(cookie, `/api/ocr/documents/${documentId}`)).json()).document;
  assert.equal(persisted.status, "PROCESSING"); assert.equal(persisted.providerRequestId, operationId);
  const polled = await worker("poll", documentId, operationId);
  const review = (await (await request(cookie, `/api/ocr/documents/${documentId}`)).json()).document;
  assert.equal(review.status, "REVIEW_REQUIRED"); assert.equal(review.extraction.fields.invoiceNumber, invoiceNumber);
  assert.equal(await db.bill.count(), 0); assert.equal(await db.payment.count(), 0);
  const corrections = { companyId: company.id, vendorId: vendor.id, jobId: job.id, invoiceNumber: `${invoiceNumber}-CORRECTED`,
    invoiceDate: "2026-10-28", currency: "AED", category: "MATERIALS", vatRate: "5", discount: "0", submit: false,
    lines: [{ description: "Fictional human correction", quantity: "2", unitPrice: "125.00" }] };
  const payload = { version: review.version, confirmed: true, bill: corrections };
  const post = () => request(cookie, `/api/ocr/documents/${documentId}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const bill = (await (await post()).json()).bill;
  assert.equal(bill.status, "DRAFT"); assert.equal(bill.paidAmount, "0.00"); assert.equal(bill.total, "262.50");
  assert.equal((await (await post()).json()).bill.id, bill.id);
  await stop();
  await start("after-second-restart");
  cookie = await signIn();
  const final = (await (await request(cookie, `/api/ocr/documents/${documentId}`)).json()).document;
  const saved = (await (await request(cookie, `/api/bills/${bill.id}`)).json()).bill;
  assert.equal(final.status, "POSTED"); assert.equal(final.billId, bill.id);
  assert.equal(final.verifiedInput.invoiceNumber, corrections.invoiceNumber);
  assert.equal(final.extraction.fields.invoiceNumber, invoiceNumber);
  assert.equal(saved.invoiceNumber, corrections.invoiceNumber); assert.equal(saved.total, "262.50");
  assert.equal(saved.status, "DRAFT"); assert.equal(saved.paidAmount, "0.00");
  assert.equal(saved.documents.length, 1);
  const original = Buffer.from(await (await request(cookie, `/api/ocr/documents/${documentId}/file`)).arrayBuffer());
  const linked = Buffer.from(await (await request(cookie, `/api/documents/${saved.documents[0].id}`)).arrayBuffer());
  assert.equal(hash(original), hash(bytes)); assert.equal(hash(linked), hash(bytes));
  const idle = await worker("idle", documentId, operationId);
  assert.equal(await db.bill.count(), 1); assert.equal(await db.payment.count(), 0); assert.equal(await db.integrationJob.count(), 0);
  receipt = { status: "passed", checkedAt: new Date().toISOString(), database: process.env.MYSQL_TEST_EXPECTED_DATABASE,
    realApplicationRestarts: 2, distinctWorkerProcesses: 3, providerMocked: true, realAzureRequests: 0,
    checks: ["HTTP upload and private original", "queued operation persisted", "saved operation resumed after application and worker restart",
      "immutable extraction retained", "human corrections persisted after second restart", "original bytes linked without copying or reupload",
      "repeat review produced one bill", "draft remained unpaid and unapproved", "no integration jobs or payments created"], workers: [started, polled, idle] };
  fs.writeFileSync(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} catch {
  console.error("OCR restart verification failed. It requires the disposable MySQL harness and a current production build; inspect private application logs. No credentials were printed.");
  process.exitCode = 1;
} finally {
  await stop();
  if (db) await db.$disconnect();
}
