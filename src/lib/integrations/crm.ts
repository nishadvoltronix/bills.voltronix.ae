import "server-only";
import { destinationCompanyForActor } from "./company-destination";
import Decimal from "decimal.js";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { getConfig, IntegrationError, type CrmMapping } from "./config";
import { accessToken } from "./oauth";
import { ZohoTransport } from "./transport";

export const VERIFIED_CRM_JOB_MAPPING: CrmMapping = {
  verified: true,
  jobModule: "Deals",
  jobNumberField: "JobDealNumber",
  jobNameField: "Deal_Name",
  jobValueField: "Amount",
  customerField: "Account_Name",
  currencyField: "Currency",
};
export function mapCrmJob(
  record: Record<string, unknown>,
  mapping: CrmMapping,
) {
  const id = z
    .string()
    .regex(/^\d{1,30}$/)
    .parse(record.id);
  const jobNumber = z
    .string()
    .trim()
    .min(2)
    .max(80)
    .parse(record[mapping.jobNumberField])
    .normalize("NFKC")
    .toUpperCase();
  const name = z
    .string()
    .trim()
    .min(2)
    .max(200)
    .parse(record[mapping.jobNameField]);
  const customer = z
    .object({ id: z.string(), name: z.string().min(2).max(200) })
    .parse(record[mapping.customerField]);
  const currency = z
    .enum(["AED", "USD", "EUR", "GBP", "SAR"])
    .parse(record[mapping.currencyField]);
  const rawValue = record[mapping.jobValueField];
  if (
    mapping.approvedVariationsField &&
    (record[mapping.approvedVariationsField] === null ||
      record[mapping.approvedVariationsField] === undefined)
  )
    throw new IntegrationError(
      "CRM_VARIATIONS_MISSING",
      "The configured approved-variations field has no value. Resolve the source before importing.",
      "BLOCKED",
    );
  const contractValue =
    rawValue === null || rawValue === undefined
      ? null
      : new Decimal(String(rawValue));
  const variations = mapping.approvedVariationsField
    ? new Decimal(String(record[mapping.approvedVariationsField]))
    : new Decimal(0);
  if (
    (contractValue &&
      (!contractValue.isFinite() ||
        contractValue.isNegative() ||
        contractValue.decimalPlaces() > 2)) ||
    !variations.isFinite() ||
    variations.decimalPlaces() > 2 ||
    (contractValue && contractValue.plus(variations).isNegative())
  )
    throw new IntegrationError(
      "CRM_VALUE_INVALID",
      "The CRM job's monetary values require review.",
      "BLOCKED",
    );
  return {
    externalCrmId: id,
    jobNumber,
    name,
    customer: customer.name,
    currency,
    contractValue: contractValue?.toFixed(2) ?? null,
    approvedVariations: variations.toFixed(2),
  };
}
export async function importCrmJob(
  actor: Actor,
  externalId: string,
  provided?: ZohoTransport,
) {
  if (actor.role !== "ADMIN")
    throw new HttpError(
      403,
      "Only an administrator can import an existing CRM job.",
    );
  if (!/^\d{1,30}$/.test(externalId))
    throw new HttpError(422, "Enter a valid existing CRM record ID.");
  const config = provided?.config ?? getConfig("CRM");
  if (
    config.environment === "production" &&
    process.env.APP_ENV !== "production"
  )
    throw new HttpError(
      409,
      "Production CRM financial records cannot be imported into this development database. Use a sandbox organization.",
    );
  const mapping = config.crmMapping ?? VERIFIED_CRM_JOB_MAPPING;
  const companyId = await destinationCompanyForActor(actor, config);
  const transport =
    provided ?? new ZohoTransport(config, () => accessToken(config));
  const orgResponse = await transport.request("/crm/v8/org");
  const org = z
    .object({
      org: z.array(
        z.object({
          zgid: z.string().optional(),
          id: z.string().optional(),
          type: z.string(),
        }),
      ),
    })
    .safeParse(orgResponse);
  if (
    !org.success ||
    !org.data.org.some(
      (o) =>
        (o.zgid === config.organizationId || o.id === config.organizationId) &&
        o.type === config.environment,
    )
  )
    throw new IntegrationError(
      "CRM_ORGANIZATION_MISMATCH",
      "The CRM organization does not match the configured organization.",
      "BLOCKED",
    );
  const fields = [
    mapping.jobNumberField,
    mapping.jobNameField,
    mapping.jobValueField,
    mapping.customerField,
    mapping.currencyField,
    ...(mapping.approvedVariationsField
      ? [mapping.approvedVariationsField]
      : []),
  ];
  const response = await transport.request(
    `/crm/v8/${mapping.jobModule}/${externalId}`,
    { query: { fields: fields.join(",") } },
  );
  const parsed = z
    .object({ data: z.array(z.record(z.string(), z.unknown())).length(1) })
    .parse(response);
  const mapped = mapCrmJob(parsed.data[0], mapping);
  if (mapped.externalCrmId !== externalId)
    throw new IntegrationError(
      "CRM_RECORD_MISMATCH",
      "The CRM returned a different record ID.",
      "BLOCKED",
    );
  // CRM text-field equals can return similar or containing values. Check the
  // normalized exact value and refuse truncated search evidence.
  const rawJobNumber = String(parsed.data[0][mapping.jobNumberField]).trim();
  const escaped = rawJobNumber.replace(/[\\(),]/g, "\\$&");
  const searchResponse = await transport.request(
    `/crm/v8/${mapping.jobModule}/search`,
    {
      query: {
        criteria: `(${mapping.jobNumberField}:equals:${escaped})`,
        fields: `id,${mapping.jobNumberField}`,
        per_page: "200",
        page: "1",
      },
    },
  );
  const matches = z
    .object({
      data: z.array(z.record(z.string(), z.unknown())),
      info: z.object({ more_records: z.boolean() }),
    })
    .safeParse(searchResponse);
  if (!matches.success || matches.data.info.more_records)
    throw new IntegrationError(
      "CRM_UNIQUENESS_UNVERIFIED",
      "The CRM job-number search was incomplete. Resolve uniqueness before importing.",
      "BLOCKED",
    );
  const exact = matches.data.data.filter(
    (record) =>
      typeof record[mapping.jobNumberField] === "string" &&
      String(record[mapping.jobNumberField])
        .normalize("NFKC")
        .trim()
        .toUpperCase() === mapped.jobNumber,
  );
  if (exact.length !== 1 || exact[0].id !== externalId)
    throw new IntegrationError(
      "CRM_JOB_NUMBER_NOT_UNIQUE",
      "The CRM job number is absent or shared by multiple Deals. Resolve the source mapping before importing.",
      "BLOCKED",
    );
  return db.$transaction(
    async (tx) => {
      await destinationCompanyForActor(actor, config, tx);
      const collision = await tx.job.findFirst({
        where: { companyId, jobNumber: { equals: mapped.jobNumber } },
      });
      if (collision && collision.externalCrmId !== externalId)
        throw new HttpError(
          409,
          "This job number is already linked to another local or CRM record. Resolve the mapping manually.",
        );
      const current = await tx.job.findUnique({
        where: { companyId_externalCrmId: { companyId, externalCrmId: externalId } },
        include: { _count: { select: { bills: true } } },
      });
      if (
        current &&
        current.currency !== mapped.currency &&
        current._count.bills > 0
      )
        throw new HttpError(
          409,
          "A CRM currency change cannot be applied to a job with existing bills.",
        );
      const effectiveVariations = mapping.approvedVariationsField
        ? mapped.approvedVariations
        : (current?.approvedVariations.toFixed(2) ?? "0.00");
      if (
        mapped.contractValue !== null &&
        new Decimal(mapped.contractValue).plus(effectiveVariations).isNegative()
      )
        throw new IntegrationError(
          "CRM_VALUE_INVALID",
          "The CRM contract value conflicts with the preserved approved variations. Review the job value before importing.",
          "BLOCKED",
        );
      const job = await tx.job.upsert({
        where: { companyId_externalCrmId: { companyId, externalCrmId: externalId } },
        create: { ...mapped, companyId },
        update: {
          ...mapped,
          approvedVariations: effectiveVariations,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          companyId,
          action: "CRM_JOB_IMPORTED",
          entityType: "Job",
          entityId: job.id,
          details: {
            externalCrmId: externalId,
            jobNumber: job.jobNumber,
            source: "Zoho CRM",
            previousValue: current?.contractValue?.toString() ?? null,
            contractValue: mapped.contractValue,
            before: current
              ? {
                  jobNumber: current.jobNumber,
                  currency: current.currency,
                  contractValue: current.contractValue?.toFixed(2) ?? null,
                  approvedVariations: current.approvedVariations.toFixed(2),
                }
              : null,
            after: {
              jobNumber: job.jobNumber,
              currency: job.currency,
              contractValue: job.contractValue?.toFixed(2) ?? null,
              approvedVariations: job.approvedVariations.toFixed(2),
            },
          },
        },
      });
      return job;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
