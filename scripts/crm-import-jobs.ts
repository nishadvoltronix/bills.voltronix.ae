import { readFile, realpath, stat, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CrmImportRun } from "@prisma/client";
import { db } from "../src/lib/db";
import { getConfig, IntegrationError } from "../src/lib/integrations/config";
import { VERIFIED_CRM_JOB_MAPPING } from "../src/lib/integrations/crm";
import { HttpError } from "../src/lib/http";
import { authenticateAccountOperator } from "../src/lib/services/accounts";
import { assertCrmJobImportRunAccess, beginCrmJobImport, crmJobImportFields, finishCrmJobImport, importCrmJobPage, parseCrmJobPage } from "../src/lib/services/crm-job-import";
import { lockAttachmentDownloadState } from "./lib/books-attachment-state";

// Provider work belongs to the separately guarded downloader. This CLI imports
// the complete private source cache and cannot contact a provider.
globalThis.fetch = async () => { throw new Error("CRM cache import does not permit network requests."); };
let release: (() => Promise<void>) | undefined;
let runId: string | undefined;
const manifestSchema = z.object({ organizationId: z.string().regex(/^\d{1,30}$/), dataCenter: z.string().length(2),
  environment: z.literal("production"), module: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/),
  fields: z.array(z.string()).min(1).max(50), pages: z.number().int().min(1).max(500), records: z.number().int().min(0).max(100_000),
  completedAt: z.iso.datetime(), providerFinancialWrites: z.literal(0), query: z.object({ fields: z.string(), per_page: z.literal("200"),
    sort_by: z.literal("id"), sort_order: z.literal("asc"), converted: z.literal("both") }).strict(),
}).loose();
const inside = (file: string, root: string) => { const relative = path.relative(root, file); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
async function readJson(filename: string) {
  const information = await stat(filename);
  if (!information.isFile() || information.size > 8 * 1024 * 1024) throw new Error("Invalid CRM source cache file.");
  return JSON.parse(await readFile(filename, "utf8")) as unknown;
}
async function persist(filename: string, value: unknown) {
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filename);
}
function summary(run: { id: string; status: string; snapshotCount: number; mappedCount: number; canonicalCount: number; unassignedCount: number; reviewCount: number }) {
  return { id: run.id, status: run.status, snapshots: run.snapshotCount, mapped: run.mappedCount,
    canonicalJobs: run.canonicalCount, unassigned: run.unassignedCount, needsReview: run.reviewCount,
    providerRequests: 0, providerFinancialWrites: 0 };
}

try {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0].startsWith("--source=") || !args[0].slice(9).trim())
    throw new Error("Use --source=<private-complete-CRM-cache-directory>.");
  const root = await realpath(path.resolve(".local"));
  const source = await realpath(path.resolve(args[0].slice(9)));
  if (!inside(source, root) || source === root) throw new Error("The CRM source directory must resolve inside the private .local workspace.");
  const stateFile = path.join(source, "import-run.json");
  release = await lockAttachmentDownloadState(stateFile);
  const manifest = manifestSchema.parse(await readJson(path.join(source, "manifest.json")));
  const config = getConfig("CRM", process.env, manifest.organizationId), mapping = config.crmMapping ?? VERIFIED_CRM_JOB_MAPPING;
  if (manifest.dataCenter !== config.dataCenter || manifest.environment !== config.environment || manifest.module !== mapping.jobModule ||
    manifest.query.fields !== manifest.fields.join(",") || crmJobImportFields(mapping).some((field) => !manifest.fields.includes(field)))
    throw new Error("The source manifest differs from the exact configured CRM mapping.");
  const pages = [], ids = new Set<string>();
  for (let ordinal = 1; ordinal <= manifest.pages; ordinal++) {
    const filename = await realpath(path.join(source, "pages", `page-${ordinal}.json`));
    if (!inside(filename, source)) throw new Error("A CRM page resolved outside the private source directory.");
    const response = await readJson(filename), parsed = parseCrmJobPage(response, ordinal);
    if (parsed.hasMore !== (ordinal < manifest.pages)) throw new Error("The CRM listing did not end on the recorded last page.");
    for (const row of parsed.records) { const id = String(row.id); if (ids.has(id)) throw new Error("The CRM listing repeats an external record ID."); ids.add(id); }
    pages.push({ ordinal, response, fetchedAt: (await stat(filename)).mtime });
  }
  if (ids.size !== manifest.records) throw new Error("CRM source count differs from the completed manifest.");
  const actor = await authenticateAccountOperator(
    process.env.ACCOUNT_OPERATOR_EMAIL ?? (process.env.APP_ENV !== "production" ? process.env.SEED_ADMIN_EMAIL : undefined) ?? "",
    process.env.ACCOUNT_OPERATOR_PASSWORD ?? (process.env.APP_ENV !== "production" ? process.env.SEED_ADMIN_PASSWORD : undefined) ?? "",
  );
  let run: CrmImportRun;
  try {
    const previous = z.object({ id: z.string().min(1).max(100) }).parse(await readJson(stateFile));
    run = await assertCrmJobImportRunAccess(actor, previous.id);
    if (run.crmOrganizationId !== manifest.organizationId || run.dataCenter !== manifest.dataCenter ||
      run.environment !== manifest.environment || run.sourceModule !== manifest.module) throw new Error("The existing import run belongs to another source.");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    run = await beginCrmJobImport(actor, { organizationId: manifest.organizationId,
      organizationResponse: await readJson(path.join(source, "organization.private.json")) });
    await persist(stateFile, { id: run.id });
  }
  runId = run.id;
  if (run.status !== "COMPLETE") {
    for (const page of pages.filter((entry) => entry.ordinal > run.lastPage)) {
      run = await importCrmJobPage(actor, run.id, page);
      if (run.lastPage % 10 === 0 || run.listingComplete) console.log(JSON.stringify({ importedSnapshots: run.snapshotCount, pages: run.lastPage, listingComplete: run.listingComplete }));
    }
    run = await finishCrmJobImport(actor, run.id);
  }
  await persist(stateFile, summary(run));
  console.log(JSON.stringify(summary(run)));
} catch (error) {
  console.error(JSON.stringify({ status: "FAILED", ...(runId ? { runId } : {}),
    code: error instanceof IntegrationError ? error.code : error instanceof HttpError ? `HTTP_${error.status}` : "CRM_CACHE_IMPORT_FAILED",
    providerRequests: 0, providerFinancialWrites: 0 }));
  process.exitCode = 1;
} finally { await release?.(); await db.$disconnect(); }
