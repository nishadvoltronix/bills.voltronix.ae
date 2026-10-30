import assert from "node:assert/strict";
import { db } from "../../src/lib/db";
import { processOcrQueue } from "../../src/lib/services/ocr";
import { normalizeAzureInvoice } from "../../src/lib/ocr-extraction";
import { azureInvoice } from "../fixtures/azure-invoice";
import { assertMySqlTestDatabase } from "../company-fixtures";
import type { DurableOcrProvider } from "../../src/lib/services/ocr-provider";

// Spawned only by the isolated OCR restart verifier. No real provider is invoked.
let starts = 0, polls = 0;
try {
  assertMySqlTestDatabase();
  const input = JSON.parse(process.env.OCR_RESTART_INPUT ?? "null") as {
    documentId: string; operationId: string; invoiceNumber: string; phase: "start" | "poll" | "idle";
  };
  assert.ok(input && ["start", "poll", "idle"].includes(input.phase));
  const document = await db.ocrDocument.findUniqueOrThrow({ where: { id: input.documentId } });
  const active = await db.ocrDocument.count({ where: { status: { in: ["QUEUED", "PROCESSING"] } } });
  assert.equal(active, input.phase === "idle" ? 0 : 1, "Only the isolated target may be active.");
  if (input.phase === "poll") assert.equal(document.providerRequestId, input.operationId);
  const provider: DurableOcrProvider = {
    async start() {
      starts++;
      assert.equal(input.phase, "start", "A restarted worker must not submit another analysis.");
      return { requestId: input.operationId, retryAfterSeconds: 0 };
    },
    async poll(requestId) {
      polls++;
      assert.equal(input.phase, "poll"); assert.equal(requestId, input.operationId);
      return { status: "succeeded", extraction: normalizeAzureInvoice(azureInvoice(input.invoiceNumber)) };
    },
  };
  // Any unexpected provider request is a test failure; injected adapter does no HTTP.
  globalThis.fetch = async () => { throw new Error("Network is disabled in the OCR restart worker fixture."); };
  const result = await processOcrQueue(1, provider);
  assert.equal(result.processed, input.phase === "idle" ? 0 : 1);
  assert.equal(starts, input.phase === "start" ? 1 : 0);
  assert.equal(polls, input.phase === "poll" ? 1 : 0);
  console.log(JSON.stringify({ phase: input.phase, starts, polls, processed: result.processed, mockedProvider: true }));
} catch {
  console.error("Isolated OCR worker restart assertion failed; no provider request or secret was printed.");
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
