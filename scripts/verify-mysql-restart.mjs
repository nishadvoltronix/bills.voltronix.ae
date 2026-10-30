import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import dotenv from "dotenv";
import { isolatedProviderEnvironment } from "./lib/test-provider-environment.mjs";

// Two actual optimized Next.js process lifetimes against the dedicated fictional database.
const root = path.resolve(import.meta.dirname, "..");
const local = dotenv.parse(fs.readFileSync(path.join(root, ".env")));
const target = new URL(local.DATABASE_URL);
if (target.protocol !== "mysql:" || target.hostname !== "127.0.0.1" || target.port !== "3308" || target.pathname !== "/voltronix_billing_dev" || target.search || target.hash || local.APP_ENV !== "development")
  throw new Error("Restart verification requires the dedicated local MySQL development database.");
if (!local.SEED_ADMIN_EMAIL || !local.SEED_ADMIN_PASSWORD) throw new Error("Fictional seed credentials are required.");
const port = 3010;
const origin = `http://127.0.0.1:${port}`;
const directory = path.join(root, ".local", "mysql-dev", "restart-verification");
fs.mkdirSync(directory, { recursive: true });
const env = { ...isolatedProviderEnvironment({ ...process.env, ...local }), APP_URL: origin, APP_ENV: "development", NODE_ENV: "production", INTEGRATION_NETWORK_ENABLED: "false", OCR_PROVIDER: "disabled", NEXT_TELEMETRY_DISABLED: "1" };
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let child;
let output;
async function assertPortFree() {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () => reject(new Error("Restart-test port is occupied; no existing process was stopped.")));
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}
async function start(label) {
  await assertPortFree();
  output = fs.openSync(path.join(directory, `${label}.log`), "w");
  child = spawn(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env, windowsHide: true, stdio: ["ignore", output, output] });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("Owned Next.js test server exited before readiness.");
    try { const response = await fetch(`${origin}/login`, { signal: AbortSignal.timeout(2000) }); if (response.ok) return; } catch { /* bounded startup wait */ }
    await sleep(300);
  }
  throw new Error("Owned Next.js test server did not become ready.");
}
async function stop() {
  if (child && child.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else child.kill("SIGTERM");
    for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt++) await sleep(100);
    if (child.exitCode === null) throw new Error("Owned test process did not stop; refusing a restart.");
  }
  child = undefined;
  if (output !== undefined) fs.closeSync(output);
  output = undefined;
}
async function signIn() {
  const response = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email: local.SEED_ADMIN_EMAIL, password: local.SEED_ADMIN_PASSWORD }) });
  if (!response.ok) throw new Error(`Local restart-test login failed (${response.status}).`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Local restart-test session was not issued.");
  return cookie;
}
async function request(cookie, route, options = {}) {
  const response = await fetch(`${origin}${route}`, { ...options, headers: { Cookie: cookie, Origin: origin, ...options.headers }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Local restart-test request failed (${response.status}).`);
  return response;
}
try {
  await start("before");
  const cookie = await signIn();
  const invoiceNumber = `DEMO-MYSQL-RESTART-${Date.now()}`;
  const created = await (await request(cookie, "/api/bills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companyId: "demo-company-voltronix", vendorId: "demo-vendor-materials", jobId: "demo-job-marina", invoiceNumber, invoiceDate: "2026-10-28", currency: "AED", category: "MATERIALS", vatRate: "5", discount: "0", lines: [{ description: "Fictional restart verification", quantity: "2", unitPrice: "12.50" }], submit: false }) })).json();
  const bill = created.bill ?? created;
  if (!bill.id || bill.total !== "26.25") throw new Error("Saved bill did not match the decimal control total.");
  const bytes = Buffer.from("%PDF-1.4\n% FICTIONAL MYSQL RESTART TEST ONLY\n%%EOF");
  const attachment = new FormData();
  attachment.set("file", new Blob([bytes], { type: "application/pdf" }), "demo-mysql-restart.pdf");
  await request(cookie, `/api/bills/${bill.id}/attachment`, { method: "POST", body: attachment });
  const before = (await (await request(cookie, `/api/bills/${bill.id}`)).json()).bill;
  const document = before.documents?.find(item => item.fileName === "demo-mysql-restart.pdf");
  if (!document) throw new Error("Attachment metadata was not saved.");
  await stop();
  await start("after");
  const nextCookie = await signIn();
  const after = (await (await request(nextCookie, `/api/bills/${bill.id}`)).json()).bill;
  const restoredBytes = Buffer.from(await (await request(nextCookie, `/api/documents/${document.id}`)).arrayBuffer());
  const hash = value => createHash("sha256").update(value).digest("hex");
  const passed = after.id === before.id && after.invoiceNumber === invoiceNumber && after.total === "26.25" && after.companyId === before.companyId && after.lines.length === 1 && after.lines[0].lineTotal === "25.00" && hash(bytes) === hash(restoredBytes);
  if (!passed) throw new Error("Application restart persistence checks failed.");
  const receipt = { checkedAt: new Date().toISOString(), database: target.pathname.slice(1), realApplicationRestarts: 1, billId: bill.id, invoiceNumber, decimalTotalsPersisted: true, lineItemsPersisted: true, companyPersisted: true, attachmentMetadataPersisted: true, attachmentBytesVerified: true, providerNetworking: false, productionChanged: false };
  fs.writeFileSync(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  // Fixed local diagnostics only; never print a failed response, environment or driver error.
  console.error(error instanceof Error && /^(Local restart-test|Owned |Restart-test|Saved bill|Attachment metadata|Application restart)/.test(error.message) ? error.message : "MySQL restart verification failed; inspect the private local evidence.");
  process.exitCode = 1;
} finally {
  await stop();
}
