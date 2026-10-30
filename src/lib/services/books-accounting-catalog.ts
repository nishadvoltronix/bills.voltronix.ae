import "server-only";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { booksConfigurationHash, getConfig, IntegrationError, type ZohoConfig } from "@/lib/integrations/config";
import { accessToken } from "@/lib/integrations/oauth";
import { ZohoTransport } from "@/lib/integrations/transport";
import { assertLocalBooksConnectionEnvironment } from "./books-local-connection";
import { assertBooksVerificationEnvironment } from "./books-operational-setup";

const id = z.string().regex(/^\d{1,30}$/);
const label = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
const inputSchema = z.object({ companyId: z.string().min(1).max(100), organizationId: id }).strict();
const expenseTypes = ["expense", "cost_of_goods_sold", "other_expense"];
type CatalogKind = "accounts" | "currencies" | "taxes";
export type BooksCatalogEntry = {
  id: string; label: string; supported: boolean;
  type?: string; active?: boolean; code?: string; base?: boolean; precision?: number; percentage?: string;
};
const schemas = {
  accounts: z.object({ account_id: id, account_name: label, account_type: z.string().min(1).max(60).regex(/^[a-z_]+$/), is_active: z.boolean() })
    .transform((row): BooksCatalogEntry => ({ id: row.account_id, label: row.account_name, type: row.account_type,
      active: row.is_active, supported: row.is_active && expenseTypes.includes(row.account_type) })),
  currencies: z.object({ currency_id: id, currency_name: label, currency_code: z.string().regex(/^[A-Z]{3}$/),
    is_base_currency: z.boolean(), price_precision: z.number().int().min(0).max(8) })
    .transform((row): BooksCatalogEntry => ({ id: row.currency_id, label: row.currency_name, code: row.currency_code,
      base: row.is_base_currency, precision: row.price_precision, supported: row.price_precision === 2 })),
  taxes: z.object({ tax_id: id, tax_name: label, tax_type: z.string().min(1).max(50).regex(/^[a-z_]+$/),
    tax_percentage: z.union([z.number().finite().min(0).max(100), z.string().regex(/^\d{1,3}(\.\d{1,8})?$/).refine((value) => Number(value) <= 100)]),
    is_active: z.boolean().optional(), status: z.string().trim().toLowerCase().pipe(z.enum(["active", "inactive"])).optional(),
    tax_factor: z.string().max(30).regex(/^[a-z_]+$/).optional() })
    .transform((row): BooksCatalogEntry => {
      // Editions expose either status or is_active. An explicit inactive value
      // wins if both are present, while older responses may omit both fields.
      const active = row.is_active === false || row.status === "inactive" ? false : row.is_active ?? (row.status === "active" ? true : undefined);
      return { id: row.tax_id, label: row.tax_name, type: row.tax_type,
        percentage: String(row.tax_percentage), active,
        supported: row.tax_type === "tax" && active !== false && (!row.tax_factor || row.tax_factor === "rate") };
    }),
};
const keys = { accounts: "chartofaccounts", currencies: "currencies", taxes: "taxes" } as const;
const paths = { accounts: "/books/v3/chartofaccounts", currencies: "/books/v3/settings/currencies", taxes: "/books/v3/settings/taxes" } as const;
const pageSize = 100;
const pageLimit = 10;
const blocked = (code: string, message: string) => new IntegrationError(code, message, "BLOCKED");

/** Strips balances, contact details and all unknown provider fields from operator output. */
export function parseBooksCatalogPage(kind: CatalogKind, value: unknown, expectedPage: number) {
  const response = z.object({ code: z.literal(0), page_context: z.object({
    page: z.number().int().positive().optional(), has_more_page: z.boolean(),
  }).optional() }).loose().safeParse(value);
  if (!response.success || (response.data.page_context?.page !== undefined && response.data.page_context.page !== expectedPage))
    throw blocked("CATALOG_RESPONSE_INVALID", "Books metadata pagination was invalid. No mapping was selected.");
  const rows = z.array(schemas[kind]).max(pageSize).safeParse(response.data[keys[kind]]);
  if (!rows.success || new Set(rows.data.map((row) => row.id)).size !== rows.data.length)
    throw blocked("CATALOG_RESPONSE_INVALID", "Books metadata contained invalid or duplicate options. No mapping was selected.");
  return { entries: rows.data, hasMore: response.data.page_context?.has_more_page ?? rows.data.length === pageSize };
}

export function assertBooksCatalogEnvironment() {
  if (process.env.APP_ENV === "production") assertBooksVerificationEnvironment();
  else assertLocalBooksConnectionEnvironment();
  if (["ZOHO_BOOKS_WRITE_ENABLED", "ZOHO_BOOKS_LIVE_ENABLED", "ALLOW_PRODUCTION_ACCOUNTING_WRITES"].some((key) => process.env[key] !== "false"))
    throw blocked("SETUP_WRITES_MUST_BE_DISABLED", "Keep all accounting-write flags explicitly false while inspecting Books metadata.");
}

async function catalogContext(actor: Actor, companyId: string, config: ZohoConfig) {
  if (actor.role !== "ADMIN" || !await db.user.findFirst({ where: {
    id: actor.id, active: true, role: "ADMIN", memberships: { some: {companyId, active:true, company:{active:true}} },
  }, select: {id:true} })) throw new HttpError(403, "An active administrator with access to this company is required.");
  const binding = await db.companyIntegrationDestination.findFirst({ where: { target:"ZOHO", organizationId:config.organizationId,
    dataCenter:config.dataCenter, environment:"production", companyId }, include:{company:true} });
  if (!binding || !binding.company.active)
    throw blocked("COMPANY_DESTINATION_MISMATCH", "The selected Books organization is not assigned to this company.");
  const local = process.env.APP_ENV !== "production";
  if (local ? (!binding.company.isDemo || binding.companyId !== `connection-check-books-${config.organizationId}` ||
    binding.company.liveAccountingEnabled || binding.liveEnabled) : (binding.company.isDemo || /^(demo[-_]|connection-check-)/i.test(binding.companyId)))
    throw blocked("COMPANY_ENVIRONMENT_MISMATCH", "Use an unchanged local connection-check workspace or an authorized real company in production.");
  return binding;
}

export async function readBooksAccountingCatalog(actor: Actor, payload: unknown, provided?: ZohoTransport) {
  assertBooksCatalogEnvironment();
  const input = inputSchema.parse(payload);
  const config = getConfig("ZOHO", process.env, input.organizationId);
  if (config.environment !== "production" || !config.networkEnabled || config.writeEnabled)
    throw blocked("READ_ONLY_BOOKS_SETUP_REQUIRED", "Books metadata inspection requires the exact production organization connection with network access and financial writes disabled.");
  const fingerprint = booksConfigurationHash(config);
  if (provided && booksConfigurationHash(provided.config) !== fingerprint)
    throw blocked("CONFIGURATION_CHANGED", "The metadata connection does not match the selected Books configuration.");
  const before = await catalogContext(actor, input.companyId, config);
  const transport = provided ?? new ZohoTransport(config, () => accessToken(config));
  let providerReads = 0;
  const read = async (path: string, page?: number) => {
    providerReads++;
    return transport.request(path, { method:"GET", ...(page ? {query:{page:String(page),per_page:String(pageSize)}} : {}) });
  };
  const organization = z.object({ code:z.literal(0), organization:z.object({
    organization_id:id, name:label, is_org_active:z.literal(true), currency_id:id,
    currency_code:z.string().regex(/^[A-Z]{3}$/), price_precision:z.number().int().min(0).max(8),
  }) }).safeParse(await read(`/books/v3/organizations/${config.organizationId}`));
  if (!organization.success || organization.data.organization.organization_id !== input.organizationId)
    throw blocked("BOOKS_ORGANIZATION_MISMATCH", "Books did not return the exact active organization requested.");
  const catalog: Record<CatalogKind, BooksCatalogEntry[]> = { accounts:[], currencies:[], taxes:[] };
  for (const kind of ["accounts","currencies","taxes"] as const) {
    const seen = new Set<string>();
    for (let page=1; page<=pageLimit; page++) {
      const result = parseBooksCatalogPage(kind, await read(paths[kind],page),page);
      if (result.entries.some((row) => seen.has(row.id)))
        throw blocked("CATALOG_RESPONSE_INVALID", "Books metadata repeated records across pages. No incomplete catalog was returned.");
      for (const row of result.entries) { seen.add(row.id); catalog[kind].push(row); }
      if (!result.hasMore) break;
      if (!result.entries.length || page === pageLimit)
        throw blocked("CATALOG_LIMIT_REACHED", "Books metadata exceeded the bounded catalog limit. Inspect the exact records in Books; no incomplete catalog was returned.");
    }
  }
  assertBooksCatalogEnvironment();
  const currentConfig = getConfig("ZOHO", process.env, input.organizationId);
  if (!currentConfig.networkEnabled || booksConfigurationHash(currentConfig) !== fingerprint ||
    JSON.stringify(await catalogContext(actor,input.companyId,config)) !== JSON.stringify(before))
    throw blocked("CONFIGURATION_CHANGED", "The company access or Books configuration changed during inspection. Repeat the read-only check.");
  return { companyId:input.companyId, organization:organization.data.organization, ...catalog,
    providerReads, providerFinancialWrites:0, accountingConfigurationWrites:0, mappingsSelected:false,
    instruction:"Review and explicitly select each category's expense account, tax rate and currency from the exact company catalog. Supported options are candidates, not automatic accounting recommendations." };
}
