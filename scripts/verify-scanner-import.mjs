import assert from "node:assert/strict";
import { spawn, spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import dotenv from "dotenv";
import { syntheticInvoicePdf } from "./lib/ocr-synthetic-invoice.mjs";
import { isolatedProviderEnvironment } from "./lib/test-provider-environment.mjs";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
let db, server, proxy, log, directory;
let stage = "guard";
const checks = [];
async function stopApp() {
  if (server && server.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(server.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else server.kill("SIGTERM");
    for (let i = 0; i < 50 && server.exitCode === null; i++) await delay(100);
    assert.notEqual(server.exitCode, null);
  }
  server = undefined;
  if (log !== undefined) fs.closeSync(log);
  log = undefined;
}
try {
  const { assertMySqlTestDatabase } = await import("../tests/company-fixtures.ts");
  assertMySqlTestDatabase();
  assert.equal(process.platform, "win32", "Scanner acceptance requires Windows file-sharing semantics.");
  assert.ok(fs.existsSync(path.join(root, ".next", "BUILD_ID")), "A current production build is required.");
  ({ db } = await import("../src/lib/db.ts"));
  const { hashPassword } = await import("../src/lib/password.ts");
  directory = path.resolve(process.env.UPLOAD_DIR, "..", "scanner-acceptance");
  assert.ok(directory.startsWith(path.join(root, ".local", "mysql-dev", "test-runs") + path.sep));
  fs.mkdirSync(directory, { recursive: true });
  const folder = path.join(directory, "new-scans"); // Starts absent; literal Windows backslash+n must round-trip.
  const origin = "http://127.0.0.1:3013";
  const env = { ...isolatedProviderEnvironment(process.env), NODE_ENV: "production", APP_ENV: "test", APP_URL: origin,
    SCANNER_IMPORT_ENABLED: "true", OCR_PROVIDER: "disabled", NEXT_TELEMETRY_DISABLED: "1" };
  async function startApp(label, configured) {
    await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", () => reject(new Error("Scanner test port occupied; no existing process was stopped.")));
      probe.listen(3013, "127.0.0.1", () => probe.close(resolve));
    });
    log = fs.openSync(path.join(directory, `${label}.log`), "w");
    const applicationEnv = { ...env, ...(configured ? {
      OCR_PROVIDER: "azure_document_intelligence", AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://fictional-ocr.cognitiveservices.azure.com/",
      AZURE_DOCUMENT_INTELLIGENCE_KEY: "fictional-scanner-acceptance-key",
    } : { AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "", AZURE_DOCUMENT_INTELLIGENCE_KEY: "" }) };
    server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "3013"],
      { cwd: root, env: applicationEnv, windowsHide: true, stdio: ["ignore", log, log] });
    for (let i = 0; i < 100; i++) {
      assert.equal(server.exitCode, null);
      try { if ((await fetch(`${origin}/login`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* startup */ }
      await delay(300);
    }
    throw new Error("Application startup timed out.");
  }
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const invoiceNumber = `DEMO-SCANNER-${Date.now()}`;
  const invoice = syntheticInvoicePdf(invoiceNumber);
  const historical = syntheticInvoicePdf(`DEMO-HISTORICAL-${Date.now()}`);
  const email = `scanner-operator-${randomUUID()}@example.invalid`, password = randomBytes(32).toString("hex");
  const operator = await db.user.create({ data: { name: "DEMO scanner operator", email, role: "ADMIN", passwordHash: await hashPassword(password) } });
  const company = await db.company.create({ data: { name: "DEMO scanner acceptance", memberships: { create: { userId: operator.id } } } });
  const vendor = await db.vendor.create({ data: { companyId: company.id, name: "Fictional OCR Supplier", currency: "AED", isDemo: true } });
  const job = await db.job.create({ data: { companyId: company.id, jobNumber: "OCR-TEST", name: "DEMO scanner job", customer: "DEMO", currency: "AED", isDemo: true } });
  stage = "start-application";
  await startApp("before", false);
  let dropReply = true, dropped = 0;
  proxy = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/api/scanner/imports") { response.writeHead(404); response.end(); return; }
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 10 * 1024 * 1024) throw new Error("Bound exceeded."); chunks.push(chunk); }
      const headers = Object.fromEntries(["authorization", "content-type", "x-scanner-source", "x-scanner-sha256", "x-scanner-file-name"]
        .flatMap(name => typeof request.headers[name] === "string" ? [[name, request.headers[name]]] : []));
      const upstream = await fetch(`${origin}/api/scanner/imports`, { method: "POST", headers, body: Buffer.concat(chunks), signal: AbortSignal.timeout(15000) });
      const body = await upstream.text();
      if (upstream.status === 201 && dropReply) { dropReply = false; dropped++; response.destroy(); return; }
      response.writeHead(upstream.status, { "content-type": "application/json" }); response.end(body);
    } catch { response.destroy(); }
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const proxyAddress = proxy.address(); assert.ok(proxyAddress && typeof proxyAddress !== "string");
  const apiOrigin = `http://127.0.0.1:${proxyAddress.port}`;
  const adminEnv = { ...env, NODE_ENV: "test", ALLOW_SCANNER_ADMINISTRATION: "true", ACCOUNT_OPERATOR_EMAIL: email,
    ACCOUNT_OPERATOR_PASSWORD: password, SCANNER_COMPANY_ID: company.id, SCANNER_SOURCE_NAME: "DEMO acceptance scanner",
    SCANNER_FOLDER: folder, SCANNER_API_URL: apiOrigin, SCANNER_SETTLE_SECONDS: "2", SCANNER_POLL_SECONDS: "1" };
  async function administer(action, sourceId) {
    const result = await run(process.execPath, ["--conditions=react-server", "--import=tsx", "scripts/scanner-source.ts", action], {
      cwd: root, env: { ...adminEnv, ...(sourceId ? { SCANNER_SOURCE_ID: sourceId } : {}) }, windowsHide: true, timeout: 30000, maxBuffer: 512 * 1024,
    });
    return JSON.parse(result.stdout);
  }
  stage = "provision-source";
  const provisioned = await administer("create");
  let workerConfig = provisioned.configuration;
  let settings = dotenv.parse(fs.readFileSync(workerConfig));
  const sourceId = provisioned.sourceId;
  const source = await db.scannerSource.findUniqueOrThrow({ where: { id: sourceId }, include: { uploadedBy: true } });
  assert.equal(source.active, false); assert.equal(source.uploadedBy.role, "DATA_ENTRY"); assert.equal(source.tokenHash, hash(settings.SCANNER_TOKEN));
  assert.ok(!["DATABASE_URL", "AZURE_DOCUMENT_INTELLIGENCE_KEY", "ACCOUNT_OPERATOR_PASSWORD"].some(name => name in settings));
  checks.push("operator provisioning creates disabled source and dedicated least-privilege identity; only token hash stored");
  async function directUpload(token = settings.SCANNER_TOKEN) {
    return fetch(`${origin}/api/scanner/imports`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/pdf",
      "X-Scanner-Source": sourceId, "X-Scanner-Sha256": hash(invoice), "X-Scanner-File-Name": "synthetic.pdf" }, body: invoice, signal: AbortSignal.timeout(15000) });
  }
  stage = "disabled-source-auth";
  assert.equal((await directUpload()).status, 401);
  stage = "staff-api-auth";
  assert.equal((await fetch(`${origin}/api/bills`, { headers: { Authorization: `Bearer ${settings.SCANNER_TOKEN}` } })).status, 401);
  stage = "enable-source";
  await administer("enable", sourceId);
  checks.push("disabled source and staff API reject scanner credential");
  let workerRuns = 0;
  async function tick() {
    workerRuns++;
    // Minimal process environment: the folder worker receives no DB, Azure or staff credentials.
    const safe = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|USERPROFILE|HOME)$/i.test(key)));
    const result = await run(process.execPath, [`--env-file=${workerConfig}`, "--import=tsx", "scripts/scanner-worker.ts", "--once"], {
      cwd: root, env: safe, windowsHide: true, timeout: 90000, maxBuffer: 512 * 1024,
    });
    const report = JSON.parse(result.stdout.trim());
    assert.ok(!result.stdout.includes(settings.SCANNER_TOKEN));
    return report;
  }
  stage = "missing-folder-and-baseline";
  assert.equal((await tick()).event, "network_retry");
  assert.equal(await db.scannerImport.count(), 0);
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "historical.pdf"), historical);
  assert.equal((await tick()).event, "baseline");
  assert.equal(await db.scannerImport.count(), 0);
  checks.push("missing folder recovers without premature baseline; historical files skipped by default");
  stage = "incomplete-copy";
  const scanned = path.join(folder, "new-scan.pdf");
  fs.writeFileSync(scanned, invoice.subarray(0, Math.floor(invoice.length / 2)));
  await tick(); await delay(2200);
  assert.equal((await tick()).retrying, 1); assert.equal(await db.scannerImport.count(), 0);
  fs.writeFileSync(scanned, invoice);
  await tick(); await delay(2200);
  stage = "lost-response";
  assert.equal((await tick()).retrying, 1); assert.equal(dropped, 1);
  assert.equal(await db.scannerImport.count(), 1); assert.equal(await db.ocrDocument.count(), 1);
  const imported = await db.scannerImport.findFirstOrThrow();
  const ocr = await db.ocrDocument.findUniqueOrThrow({ where: { id: imported.ocrDocumentId } });
  assert.equal(ocr.status, "FAILED"); assert.equal(ocr.failureCode, "NOT_CONFIGURED");
  assert.equal(await db.bill.count(), 0);
  checks.push("incomplete PDF held; stable original handed to existing OCR with visible missing-configuration failure");
  stage = "restart-and-deduplicate";
  await stopApp(); await startApp("after-restart", true); await delay(5200);
  assert.equal((await tick()).duplicates, 1);
  assert.equal(await db.scannerImport.count(), 1); assert.equal(await db.ocrDocument.count(), 1);
  fs.writeFileSync(path.join(folder, "renamed-copy.pdf"), invoice);
  await tick(); await delay(2200);
  assert.equal((await tick()).duplicates, 1);
  assert.equal(await db.scannerImport.count(), 1); assert.equal(await db.ocrDocument.count(), 1);
  checks.push("lost HTTP acknowledgement, application restart and renamed file resolve to one persisted hash/OCR document");
  stage = "ocr-retry-and-review";
  const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(15000) });
  assert.equal(login.status, 200); const cookie = login.headers.get("set-cookie")?.split(";", 1)[0]; assert.ok(cookie);
  const userRequest = async (route, options = {}) => {
    const response = await fetch(`${origin}${route}`, { ...options, headers: { Cookie: cookie, Origin: origin, ...options.headers }, signal: AbortSignal.timeout(15000) });
    assert.ok(response.ok); return response;
  };
  await userRequest(`/api/ocr/documents/${ocr.id}/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const operationId = randomUUID();
  for (const phase of ["start", "poll"]) {
    await run(process.execPath, ["--conditions=react-server", "--import=tsx", "tests/helpers/ocr-restart-worker.ts"], { cwd: root,
      env: { ...env, NODE_ENV: "test", OCR_RESTART_INPUT: JSON.stringify({ phase, documentId: ocr.id, operationId, invoiceNumber }) },
      windowsHide: true, timeout: 30000, maxBuffer: 512 * 1024 });
  }
  const review = (await (await userRequest(`/api/ocr/documents/${ocr.id}`)).json()).document;
  assert.equal(review.status, "REVIEW_REQUIRED"); assert.equal(review.scannerSourceName, "DEMO acceptance scanner");
  assert.equal(await db.bill.count(), 0);
  const billInput = { companyId: company.id, vendorId: vendor.id, jobId: job.id, invoiceNumber, invoiceDate: "2026-10-28",
    currency: "AED", category: "MATERIALS", vatRate: "5", discount: "0", submit: false,
    lines: [{ description: "Fictional materials", quantity: "2", unitPrice: "100.00" }] };
  const bill = (await (await userRequest(`/api/ocr/documents/${ocr.id}/review`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: review.version, confirmed: true, bill: billInput }) })).json()).bill;
  assert.equal(bill.status, "DRAFT"); assert.equal(bill.paidAmount, "0.00"); assert.equal(bill.total, "210.00");
  const detail = (await (await userRequest(`/api/bills/${bill.id}`)).json()).bill;
  const original = Buffer.from(await (await userRequest(`/api/documents/${detail.documents[0].id}`)).arrayBuffer());
  assert.equal(hash(original), hash(invoice));
  assert.equal(await db.payment.count(), 0); assert.equal(await db.integrationJob.count(), 0);
  checks.push("existing mocked Azure worker resumes retained original and exposes source-labelled review; explicit human action creates unpaid draft only");
  stage = "rotate-and-disable";
  const previousToken = settings.SCANNER_TOKEN;
  const rotated = await administer("rotate", sourceId);
  workerConfig = rotated.configuration; settings = dotenv.parse(fs.readFileSync(workerConfig));
  assert.equal((await directUpload(previousToken)).status, 401);
  assert.equal((await directUpload()).status, 200);
  await administer("disable", sourceId);
  assert.equal((await directUpload()).status, 401);
  checks.push("operator token rotation and source revocation enforced");
  for (const name of ["new-scan.pdf", "renamed-copy.pdf"]) assert.equal(hash(fs.readFileSync(path.join(folder, name))), hash(invoice));
  assert.equal(hash(fs.readFileSync(path.join(folder, "historical.pdf"))), hash(historical));
  checks.push("all completed synthetic source files and historical original preserved byte-for-byte");
  const receipt = { status: "passed", checkedAt: new Date().toISOString(), database: process.env.MYSQL_TEST_EXPECTED_DATABASE,
    workerProcessRuns: workerRuns, actualApplicationRestarts: 1, windowsFileAccess: true, realHttpAndMySQL: true,
    azureMocked: true, realAzureRequests: 0, actualNetworkShareTested: false, productionChanged: false, checks };
  fs.writeFileSync(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  if (directory) fs.writeFileSync(path.join(directory, "failure.json"), JSON.stringify({ stage, checksCompleted: checks.length,
    actual: typeof error?.actual === "number" ? error.actual : undefined,
    expected: typeof error?.expected === "number" ? error.expected : undefined }));
  console.error(`Scanner acceptance failed at ${stage}; inspect private test evidence. No credentials or invoice content printed.`);
  process.exitCode = 1;
} finally {
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  await stopApp();
  if (db) await db.$disconnect();
}
