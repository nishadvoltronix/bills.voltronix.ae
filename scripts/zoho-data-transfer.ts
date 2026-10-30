import path from "node:path";
import type { Actor } from "../src/lib/auth";
import type { PrismaClient } from "@prisma/client";
import { zohoDataTransferCooldownSchema } from "../src/lib/services/zoho-data-transfer-format";

let store: PrismaClient | undefined;
async function operator(readOnly = false): Promise<Actor> {
  const { db } = await import("../src/lib/db");
  store = db;
  const development = process.env.APP_ENV === "development";
  const email = process.env.ACCOUNT_OPERATOR_EMAIL || (development ? process.env.SEED_ADMIN_EMAIL : "") || "";
  const password = process.env.ACCOUNT_OPERATOR_PASSWORD || (development ? process.env.SEED_ADMIN_PASSWORD : "") || "";
  if (!readOnly) {
    const { authenticateAccountOperator } = await import("../src/lib/services/accounts");
    return authenticateAccountOperator(email, password);
  }
  const { verifyPassword } = await import("../src/lib/password");
  const user = await db.user.findUnique({ where: { email: email.trim().toLowerCase() },
    select: { id: true, name: true, email: true, active: true, role: true, passwordHash: true } });
  if (!user?.active || user.role !== "ADMIN" || !password || !await verifyPassword(password, user.passwordHash))
    throw new Error("SOURCE_OPERATOR_REQUIRED");
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

async function main() {
  const [mode, ...extra] = process.argv.slice(2);
  if (extra.length || !["export", "check", "prepare", "import"].includes(mode ?? ""))
    throw new Error("TRANSFER_COMMAND_REQUIRED");
  if (mode === "prepare") {
    const { assertZohoDataRestoreEnvironment } = await import("../src/lib/services/zoho-data-transfer-import");
    assertZohoDataRestoreEnvironment();
    const actor = await operator();
    const { getBooksOrganizations, getConfig } = await import("../src/lib/integrations/config");
    const { prepareOperationalBooksCompany } = await import("../src/lib/services/operational-company");
    const { prepareOperationalCrmSource } = await import("../src/lib/services/crm-operational-source");
    const reference = process.env.ZOHO_DATA_TRANSFER_REFERENCE ?? "";
    const crm = getConfig("CRM");
    const companies = [];
    for (const profile of getBooksOrganizations()) {
      const company = await prepareOperationalBooksCompany(actor, {
        companyName: profile.name, organizationId: profile.organizationId, reference,
      });
      await prepareOperationalCrmSource(actor, { companyId: company.companyId,
        booksOrganizationId: profile.organizationId, crmOrganizationId: crm.organizationId, reference });
      companies.push({ companyId: company.companyId, organizationId: profile.organizationId });
    }
    console.log(JSON.stringify({ prepared: true, companies, providerRequests: 0, financialWritesEnabled: false }));
    return;
  }
  const directory = process.env.ZOHO_DATA_TRANSFER_DIR ?? "";
  if (!path.isAbsolute(directory)) throw new Error("ABSOLUTE_TRANSFER_DIRECTORY_REQUIRED");
  if (mode === "export") {
    if (process.env.ALLOW_ZOHO_DATA_EXPORT !== "true") throw new Error("EXPLICIT_EXPORT_REQUIRED");
    const actor = await operator(true);
    const companyIds: unknown = JSON.parse(process.env.ZOHO_DATA_TRANSFER_COMPANY_IDS_JSON ?? "null");
    if (!Array.isArray(companyIds) || !companyIds.length || companyIds.some(id => typeof id !== "string"))
      throw new Error("EXACT_SOURCE_COMPANIES_REQUIRED");
    const { exportZohoDataTransfer } = await import("../src/lib/services/zoho-data-transfer-export");
    const { incomingSources } = await import("../src/lib/services/incoming-sync-access");
    const { incomingConfiguredDelay } = await import("../src/lib/services/incoming-sync");
    const { privateAttachmentStateFile, readAttachmentDownloadState } = await import("./lib/books-attachment-state");
    const progress = process.env.INCOMING_SYNC_ATTACHMENT_STATE_FILE
      ? await readAttachmentDownloadState(await privateAttachmentStateFile(process.env.INCOMING_SYNC_ATTACHMENT_STATE_FILE)) : null;
    const additionalCooldowns = [];
    for (const source of await incomingSources(actor)) {
      if (source.target === "ZOHO" && !companyIds.includes(source.companyId)) continue;
      let notBefore = incomingConfiguredDelay(source);
      const quota = source.target === "ZOHO" ? progress?.organizations[source.organizationId]?.quota : undefined;
      const recorded = quota?.notBefore ? new Date(quota.notBefore) : quota?.reason === "DAILY_QUOTA_RESERVED" ? new Date(Date.now() + 86_400_000) : null;
      if (recorded && (!notBefore || recorded > notBefore)) notBefore = recorded;
      if (notBefore && notBefore.valueOf() > Date.now()) additionalCooldowns.push(zohoDataTransferCooldownSchema.parse({ target: source.target,
        organizationId: source.organizationId, dataCenter: source.dataCenter, environment: source.environment,
        notBefore: notBefore.toISOString() }));
    }
    console.log(JSON.stringify(await exportZohoDataTransfer(actor, { directory, companyIds, additionalCooldowns })));
    return;
  }
  const manifestSha256 = process.env.ZOHO_DATA_TRANSFER_SHA256 ?? "";
  if (mode === "check") {
    const { checkZohoDataTransfer } = await import("../src/lib/services/zoho-data-transfer-import");
    console.log(JSON.stringify(await checkZohoDataTransfer({ directory, manifestSha256 })));
    return;
  }
  const actor = await operator();
  const { restoreZohoDataTransfer } = await import("../src/lib/services/zoho-data-transfer-import");
  console.log(JSON.stringify(await restoreZohoDataTransfer(actor, { directory, manifestSha256,
    reference: process.env.ZOHO_DATA_TRANSFER_REFERENCE ?? "" })));
}

main().catch(error => {
  const candidate = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const code = typeof candidate === "string" && /^[A-Z0-9_]{1,100}$/.test(candidate) ? candidate : "TRANSFER_FAILED";
  console.error(JSON.stringify({ status: "REJECTED", code,
    action: "Check the protected operator configuration, exact bundle digest and fresh destination. No provider financial write is part of this command." }));
  process.exitCode = 1;
}).finally(() => store?.$disconnect());
