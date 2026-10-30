import "server-only";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import {
  booksConfigurationHash,
  getConfig,
  IntegrationError,
  productionBooksRuntimeReady,
  type ZohoConfig,
} from "@/lib/integrations/config";
import { accessToken } from "@/lib/integrations/oauth";
import { ZohoTransport } from "@/lib/integrations/transport";

const inputSchema = z.object({
  companyId: z.string().min(1).max(100),
  organizationId: z.string().regex(/^\d{1,30}$/),
  organizationName: z.string().trim().min(1).max(200),
  reference: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/ -]{2,159}$/),
}).strict();

const blocked = (code: string, message: string) =>
  new IntegrationError(code, message, "BLOCKED");

export function assertBooksVerificationEnvironment() {
  if (!productionBooksRuntimeReady(process.env))
    throw blocked("OPERATIONAL_RUNTIME_REQUIRED", "Books verification requires the production runtime and an operational database.");
  if (["ZOHO_BOOKS_WRITE_ENABLED", "ZOHO_BOOKS_LIVE_ENABLED", "ALLOW_PRODUCTION_ACCOUNTING_WRITES"]
    .some((key) => process.env[key] !== "false"))
    throw blocked("SETUP_WRITES_MUST_BE_DISABLED", "Keep all accounting-write flags explicitly false while verifying a company destination.");
}

type Input = z.infer<typeof inputSchema>;
type Store = Prisma.TransactionClient;
async function setupContext(store: Store, actor: Actor, input: Input, config: ZohoConfig) {
  const current = await store.user.findFirst({
    where: { id: actor.id, active: true, role: "ADMIN", memberships: {
      some: { companyId: input.companyId, active: true, company: { active: true } },
    } }, select: { id: true },
  });
  if (!current) throw new HttpError(403, "An active administrator with access to this company is required.");
  const company = await store.company.findUnique({ where: { id: input.companyId } });
  if (!company || !company.active || company.isDemo || /^(demo[-_]|connection-check-)/i.test(company.id))
    throw blocked("REAL_COMPANY_REQUIRED", "Select an existing active operating company. Demo and connection-check records cannot be promoted.");
  if (company.name.trim() !== input.organizationName)
    throw blocked("COMPANY_NAME_MISMATCH", "The operating company name must match the reviewed Books organization name.");
  const destination = await store.companyIntegrationDestination.findFirst({ where: {
    target: "ZOHO", organizationId: config.organizationId, dataCenter: config.dataCenter, environment: "production",
  } });
  if (!destination || destination.companyId !== company.id)
    throw blocked("COMPANY_DESTINATION_MISMATCH", "Prepare this exact disabled Books destination for the operating company before verification.");
  if (await store.integrationJob.count({ where: {
    target: "ZOHO", organizationId: config.organizationId, bill: { companyId: company.id },
    status: { in: ["QUEUED", "PROCESSING", "RETRY", "UNKNOWN"] },
  } }))
    throw blocked("OUTSTANDING_SYNC_OPERATIONS", "Reconcile outstanding Books operations before changing destination authorization.");
  return { company, destination };
}

const organizationSchema = z.object({ code: z.literal(0), organization: z.object({
  organization_id: z.string(), name: z.string(), is_org_active: z.literal(true),
  currency_id: z.string(), currency_code: z.string(), price_precision: z.literal(2),
}) });
const currencySchema = z.object({ code: z.literal(0), currency: z.object({
  currency_id: z.string(), currency_code: z.string(), is_base_currency: z.boolean(), price_precision: z.literal(2),
}) });
const accountEnvelopeSchema = z.object({ code: z.literal(0) }).passthrough();
const accountSchema = z.object({ account_id: z.string(),
  is_active: z.literal(true), account_type: z.enum(["expense", "cost_of_goods_sold", "other_expense"]),
});
const taxSchema = z.object({ tax_id: z.string(), tax_type: z.literal("tax"),
  tax_percentage: z.union([z.number().finite(), z.string().regex(/^\d+(\.\d+)?$/)]),
  tax_factor: z.literal("rate").optional(), is_active: z.literal(true).optional(),
  // Preserve compatibility when activity is omitted; any supplied indicator must be active.
  status: z.string().trim().toLowerCase().pipe(z.literal("active")).optional(),
});
const taxResponseSchema = z.object({ code: z.literal(0), tax: z.union([taxSchema, z.array(taxSchema).min(1).max(100)]) });

/** GET-only metadata evidence. No invoice, attachment, payment or provider setting is written. */
export async function verifyBooksAccountingMetadata(transport: ZohoTransport, expectedName: string) {
  const config = transport.config;
  const mapping = config.booksMapping;
  if (config.target !== "ZOHO" || config.environment !== "production" || !mapping ||
    !mapping.currencies[mapping.baseCurrency] || (!mapping.lineSelectionRequired &&
      (!Object.keys(mapping.categories).length || !Object.keys(mapping.taxes).length)))
    throw blocked("ACCOUNTING_MAPPING_REQUIRED", "Configure this exact organization's base currency and either reviewed account/tax defaults or required explicit line selections.");
  if (mapping.lineSelectionRequired && (Object.keys(mapping.categories).length || Object.keys(mapping.taxes).length))
    throw blocked("MAPPING_VERIFICATION_UNSUPPORTED", "Required line selection mode cannot define category or tax defaults.");
  if (Object.keys(mapping.currencies).length > 20 || Object.keys(mapping.taxes).length > 30 ||
    mapping.jobCustomFieldIndex || mapping.orderCustomFieldIndex || Object.values(mapping.categories).some((value) => value?.itemId))
    throw blocked("MAPPING_VERIFICATION_UNSUPPORTED", "This verifier supports up to 20 currencies, 30 simple taxes and manual expense accounts. Item/custom-field mappings need a separate supported verification procedure.");
  for (const [code, currency] of Object.entries(mapping.currencies)) {
    if (code !== mapping.baseCurrency && (!currency.exchangeRate || new Decimal(currency.exchangeRate).lte(0)))
      throw blocked("EXCHANGE_RATE_REQUIRED", "Every configured foreign currency requires a reviewed positive exchange rate.");
  }
  let providerReads = 0;
  const read = async (path: string) => {
    providerReads++;
    return transport.request(path, { method: "GET" });
  };
  const organization = organizationSchema.safeParse(await read(`/books/v3/organizations/${config.organizationId}`));
  if (!organization.success || organization.data.organization.organization_id !== config.organizationId ||
    organization.data.organization.name.trim() !== expectedName || organization.data.organization.currency_code !== mapping.baseCurrency ||
    organization.data.organization.currency_id !== mapping.currencies[mapping.baseCurrency].id)
    throw blocked("BOOKS_ORGANIZATION_MISMATCH", "Books organization identity, name, active state, base currency or amount precision does not match the reviewed company configuration.");
  for (const [code, expected] of Object.entries(mapping.currencies)) {
    const currency = currencySchema.safeParse(await read(`/books/v3/settings/currencies/${expected.id}`));
    if (!currency.success || currency.data.currency.currency_id !== expected.id || currency.data.currency.currency_code !== code ||
      currency.data.currency.is_base_currency !== (code === mapping.baseCurrency))
      throw blocked("BOOKS_CURRENCY_MISMATCH", "A configured Books currency does not match its ID, code, base-currency role or amount precision.");
  }
  const accountIds = [...new Set(Object.values(mapping.categories).map((value) => value!.accountId))];
  for (const id of accountIds) {
    const response = accountEnvelopeSchema.safeParse(await read(`/books/v3/chartofaccounts/${id}`));
    // Books also returns a nested account. A present malformed nested value must
    // fail verification rather than falling back to unrelated top-level fields.
    const account = response.success ? accountSchema.safeParse(
      Object.hasOwn(response.data, "chart_of_account") ? response.data.chart_of_account : response.data,
    ) : null;
    if (!account?.success || account.data.account_id !== id)
      throw blocked("BOOKS_ACCOUNT_MISMATCH", "Every configured expense account must resolve to its exact active expense or cost-of-goods-sold account.");
  }
  for (const [rate, expected] of Object.entries(mapping.taxes)) {
    const response = taxResponseSchema.safeParse(await read(`/books/v3/settings/taxes/${expected.id}`));
    const rows = response.success ? (Array.isArray(response.data.tax) ? response.data.tax : [response.data.tax]) : [];
    const matching = rows.filter((tax) => tax.tax_id === expected.id);
    if (matching.length !== 1 || !new Decimal(matching[0].tax_percentage).equals(expected.percentage) ||
      !new Decimal(expected.percentage).equals(rate))
      throw blocked("BOOKS_TAX_MISMATCH", "A configured tax must resolve to one exact simple percentage tax matching the reviewed rate. Compound taxes are not supported.");
  }
  return { providerReads, currencyCount: Object.keys(mapping.currencies).length,
    accountCount: accountIds.length, taxCount: Object.keys(mapping.taxes).length };
}

export async function verifyOperationalBooksDestination(actor: Actor, payload: unknown, provided?: ZohoTransport) {
  assertBooksVerificationEnvironment();
  if (actor.role !== "ADMIN") throw new HttpError(403, "An active administrator is required.");
  const input = inputSchema.parse(payload);
  const config = getConfig("ZOHO", process.env, input.organizationId);
  if (config.environment !== "production" || !config.networkEnabled || config.writeEnabled)
    throw blocked("READ_ONLY_BOOKS_SETUP_REQUIRED", "Verification requires the configured production Books connection with networking enabled and financial writes disabled.");
  const configurationHash = booksConfigurationHash(config);
  if (provided && booksConfigurationHash(provided.config) !== configurationHash)
    throw blocked("CONFIGURATION_CHANGED", "The verification connection must match this exact configured destination.");
  const before = await setupContext(db, actor, input, config);
  const evidence = await verifyBooksAccountingMetadata(provided ?? new ZohoTransport(config, () => accessToken(config)), input.organizationName);
  // A process configuration change must not certify metadata fetched under older credentials/mappings.
  assertBooksVerificationEnvironment();
  const currentConfig = getConfig("ZOHO", process.env, input.organizationId);
  if (!currentConfig.networkEnabled || booksConfigurationHash(currentConfig) !== configurationHash)
    throw blocked("CONFIGURATION_CHANGED", "Books configuration changed during verification. Repeat the provider checks.");
  const verifiedAt = new Date();
  return db.$transaction(async (tx) => {
    const current = await setupContext(tx, actor, input, config);
    if (JSON.stringify(current) !== JSON.stringify(before))
      throw new HttpError(409, "The company or destination changed during verification. No authorization was updated.");
    await tx.company.update({ where: { id: input.companyId }, data: { liveAccountingEnabled: true } });
    await tx.companyIntegrationDestination.update({ where: { companyId_target_organizationId_dataCenter_environment: {
      companyId: input.companyId, target: "ZOHO", organizationId: config.organizationId,
      dataCenter: config.dataCenter, environment: "production",
    } }, data: { liveEnabled: true, verifiedAt, verificationReference: input.reference, verifiedConfigurationHash: configurationHash } });
    await tx.auditLog.create({ data: { actorId: actor.id, companyId: input.companyId,
      action: "BOOKS_OPERATIONAL_DESTINATION_VERIFIED", entityType: "Company", entityId: input.companyId,
      details: { organizationId: config.organizationId, dataCenter: config.dataCenter, reference: input.reference,
        verifiedAt: verifiedAt.toISOString(), ...evidence, providerFinancialWrites: 0,
        previousLiveAccountingEnabled: before.company.liveAccountingEnabled, previousDestinationEnabled: before.destination.liveEnabled },
    } });
    return { companyId: input.companyId, organizationId: config.organizationId, dataCenter: config.dataCenter,
      verifiedAt: verifiedAt.toISOString(), destinationVerified: true, ...evidence,
      providerFinancialWrites: 0, financialWriteFlagsEnabled: false,
      nextStep: "Verify supplier mappings and job records, then enable the operational write settings and supervise the worker. No bill has been posted by this verification." };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
