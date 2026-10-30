import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import dotenv from "dotenv";
import { isolatedProviderEnvironment } from "./lib/test-provider-environment.mjs";
import { syntheticInvoicePdf } from "./lib/ocr-synthetic-invoice.mjs";

// Deliberately outside Vitest discovery. Real analysis incurs Azure usage.
// Never loads a database client, user-uploaded invoice or other provider client.
const root = path.resolve(import.meta.dirname, "..");
let receipt;
let directory;
try {
  if (process.argv.length !== 3 || process.argv[2] !== "--allow-live") {
    console.error("Live Azure test not started. Use npm run test:ocr:live -- --allow-live to analyze two synthetic invoices using your configured Azure resource.");
    process.exitCode = 2;
  } else {
    const local = fs.existsSync(path.join(root, ".env")) ? dotenv.parse(fs.readFileSync(path.join(root, ".env"))) : {};
    const endpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || local.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
    const key = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY || local.AZURE_DOCUMENT_INTELLIGENCE_KEY;
    const applicationEnvironment = process.env.APP_ENV || local.APP_ENV;
    if (applicationEnvironment !== "development" || !endpoint?.trim() || !key?.trim()) {
      console.error("Live Azure test blocked: use the development environment and configure AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT and AZURE_DOCUMENT_INTELLIGENCE_KEY securely. No request was sent.");
      process.exitCode = 2;
    } else {
      const clean = isolatedProviderEnvironment(process.env);
      for (const name of Object.keys(process.env)) if (!(name in clean)) delete process.env[name];
      Object.assign(process.env, clean, {
        APP_ENV: "development", OCR_PROVIDER: "azure_document_intelligence",
        AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: endpoint, AZURE_DOCUMENT_INTELLIGENCE_KEY: key,
      });
      const { azureOcrProvider, ocrProviderStatus, OcrProviderError } = await import("../src/lib/services/ocr-provider.ts");
      if (!ocrProviderStatus().configured) {
        console.error("Live Azure test blocked: the Azure resource endpoint/key configuration is invalid. No request was sent.");
        process.exitCode = 2;
      } else {
        directory = path.join(root, ".local", "mysql-dev", "ocr-live", `${Date.now()}-${randomUUID().slice(0, 8)}`);
        fs.mkdirSync(directory, { recursive: true });
        receipt = { status: "running", provider: "Azure AI Document Intelligence", model: "prebuilt-invoice", apiVersion: "2024-11-30", mocked: false, syntheticDocumentsOnly: true, databaseAccessed: false, zohoAccessed: false, samples: [], startedAt: new Date().toISOString() };
        const persist = () => fs.writeFileSync(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2));
        persist();
        for (const [index, multipage] of [false, true].entries()) {
          const invoiceNumber = `DEMO-AZURE-${Date.now()}-${index + 1}`;
          const bytes = syntheticInvoicePdf(invoiceNumber, { multipage });
          const sample = { name: multipage ? "two-page-fictional-invoice" : "one-page-fictional-invoice", sha256: createHash("sha256").update(bytes).digest("hex"), expectedPages: multipage ? 2 : 1, status: "starting", pollCount: 0 };
          receipt.samples.push(sample);
          fs.writeFileSync(path.join(directory, `${sample.name}.pdf`), bytes);
          persist();
          // Exactly one submission per sample. Unknown outcomes are never resubmitted.
          const started = await azureOcrProvider.start(bytes);
          Object.assign(sample, { operationId: started.requestId, status: "processing" });
          persist();
          let waitSeconds = started.retryAfterSeconds;
          let extracted;
          const deadline = Date.now() + 180000;
          for (let poll = 0; poll < 60 && Date.now() < deadline; poll++) {
            const waitMs = Math.max(1000, waitSeconds * 1000);
            if (Date.now() + waitMs >= deadline) break;
            await delay(waitMs);
            sample.pollCount++;
            try {
              const result = await azureOcrProvider.poll(started.requestId);
              if (result.status === "succeeded") { extracted = result.extraction; break; }
              waitSeconds = result.retryAfterSeconds;
            } catch (error) {
              if (!(error instanceof OcrProviderError) || !error.retryable) throw error;
              waitSeconds = error.retryAfterSeconds;
            }
            persist();
          }
          if (!extracted) throw new OcrProviderError("LIVE_TEST_TIMEOUT", "Live test polling exceeded its bounded deadline.");
          const checks = {
            invoiceNumber: extracted.fields.invoiceNumber === invoiceNumber,
            vendorName: /fictional\s+ocr\s+supplier/i.test(extracted.vendorName ?? ""),
            invoiceDate: extracted.fields.invoiceDate === "2026-10-28",
            dueDate: extracted.fields.dueDate === "2026-11-27",
            purchaseOrder: extracted.fields.orderNumber === "PO-DEMO-001",
            currency: extracted.fields.currency === "AED",
            taxRate: extracted.fields.vatRate === "5.00",
            sourceTotals: extracted.subtotal === "200.00" && extracted.vatAmount === "10.00" && extracted.total === "210.00",
            lineItems: extracted.fields.lines?.some(line => /fictional materials/i.test(line.description) && line.quantity === "2.000" && line.unitPrice === "100.00") ?? false,
            pageCount: extracted.pageCount === sample.expectedPages,
            reviewRequired: extracted.requiresHumanReview === true,
          };
          Object.assign(sample, { status: "extracted", checks, warningCount: extracted.warnings.length });
          persist();
          assert.ok(Object.values(checks).every(Boolean), "Synthetic invoice extraction did not meet acceptance checks.");
          sample.status = "passed";
          persist();
        }
        Object.assign(receipt, { status: "passed", completedAt: new Date().toISOString() });
        persist();
        console.log(JSON.stringify({ status: receipt.status, liveAzure: true, syntheticSamplesPassed: receipt.samples.length, databaseAccessed: false, receipt: path.relative(root, path.join(directory, "receipt.json")) }, null, 2));
      }
    }
  }
} catch (error) {
  const code = error && typeof error.code === "string" && /^[A-Z_]{1,50}$/.test(error.code) ? error.code : "ACCEPTANCE_CHECK_FAILED";
  if (receipt && directory) {
    Object.assign(receipt, { status: "failed", failureCode: code, completedAt: new Date().toISOString() });
    fs.writeFileSync(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2));
  }
  console.error(JSON.stringify({ status: "failed", code, message: "Live Azure acceptance did not pass. Inspect the private receipt; no credentials or provider response bodies are printed." }));
  process.exitCode = 1;
}
