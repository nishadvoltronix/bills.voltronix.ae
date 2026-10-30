import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { getConfig, IntegrationError } from "./config";
import { accessToken } from "./oauth";
import { ZohoTransport } from "./transport";
import { destinationCompanyForActor, requireDestinationForCompany } from "./company-destination";

const mappingInput = z
  .object({
    vendorId: z.string().min(1).max(100),
    externalZohoId: z.string().regex(/^\d{1,30}$/),
    organizationId: z
      .string()
      .regex(/^\d{1,30}$/)
      .optional(),
  })
  .strict();
export async function mapBooksVendor(
  actor: Actor,
  payload: unknown,
  provided?: ZohoTransport,
) {
  if (actor.role !== "ADMIN")
    throw new HttpError(403, "Only an administrator can map a Books vendor.");
  const input = mappingInput.parse(payload);
  const vendor = await db.vendor.findUnique({ where: { id: input.vendorId } });
  if (!vendor) throw new HttpError(404, "Vendor not found.");
  const config =
    provided?.config ?? getConfig("ZOHO", process.env, input.organizationId);
  const companyId = await destinationCompanyForActor(actor, config);
  if (vendor.companyId !== companyId) throw new HttpError(404, "Vendor not found in the selected company.");
  if (input.organizationId && input.organizationId !== config.organizationId)
    throw new HttpError(
      409,
      "The selected Books organization does not match the mapping connection.",
    );
  const transport =
    provided ?? new ZohoTransport(config, () => accessToken(config));
  const response = await transport.request(
    `/books/v3/contacts/${input.externalZohoId}`,
  );
  const contact = z
    .object({
      code: z.literal(0),
      contact: z.object({
        contact_id: z.string(),
        contact_type: z.string(),
        currency_code: z.string(),
        status: z.string(),
      }),
    })
    .safeParse(response);
  if (
    !contact.success ||
    contact.data.contact.contact_id !== input.externalZohoId ||
    contact.data.contact.contact_type !== "vendor" ||
    contact.data.contact.currency_code !== vendor.currency ||
    contact.data.contact.status !== "active"
  )
    throw new IntegrationError(
      "VENDOR_MAPPING_MISMATCH",
      "The Books contact must be an active supplier in the same currency as the local vendor.",
      "BLOCKED",
    );
  return db.$transaction(
    async (tx) => {
      await destinationCompanyForActor(actor, config, tx);
      await requireDestinationForCompany(config, vendor.companyId, tx);
      const current = await tx.vendor.findUniqueOrThrow({
        where: { id: input.vendorId },
      });
      if (current.currency !== vendor.currency)
        throw new HttpError(
          409,
          "The vendor changed during verification. Retry the mapping.",
        );
      const destination = {
        vendorId: vendor.id,
        organizationId: config.organizationId,
        dataCenter: config.dataCenter,
        environment: config.environment,
      };
      const existingMapping = await tx.vendorBooksMapping.findUnique({
        where: { vendorId_organizationId_dataCenter_environment: destination },
      });
      if (
        existingMapping &&
        existingMapping.externalVendorId !== input.externalZohoId
      ) {
        const existing = await tx.integrationJob.count({
          where: {
            bill: { vendorId: vendor.id },
            target: "ZOHO",
            organizationId: config.organizationId,
          },
        });
        if (existing)
          throw new HttpError(
            409,
            "This vendor has synchronization history. Resolve the accounting mapping before changing its external ID.",
          );
      }
      const collision = await tx.vendorBooksMapping.findFirst({
        where: {
          organizationId: config.organizationId,
          dataCenter: config.dataCenter,
          environment: config.environment,
          externalVendorId: input.externalZohoId,
          vendorId: { not: vendor.id },
        },
      });
      if (collision)
        throw new HttpError(
          409,
          "This Books supplier is already mapped to another local vendor in the selected organization.",
        );
      const result = await tx.vendorBooksMapping.upsert({
        where: { vendorId_organizationId_dataCenter_environment: destination },
        create: { ...destination, externalVendorId: input.externalZohoId },
        update: { externalVendorId: input.externalZohoId },
      });
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          companyId: vendor.companyId,
          action: "VENDOR_BOOKS_MAPPING_VERIFIED",
          entityType: "Vendor",
          entityId: vendor.id,
          details: {
            previousExternalId: existingMapping?.externalVendorId ?? null,
            externalId: input.externalZohoId,
            organizationId: config.organizationId,
            dataCenter: config.dataCenter,
            environment: config.environment,
            currency: current.currency,
          },
        },
      });
      return {
        vendor: {
          id: vendor.id,
          name: current.name,
          currency: current.currency,
          externalZohoId: result.externalVendorId,
          organizationId: result.organizationId,
        },
        mapping: {
          id: result.id,
          vendorId: vendor.id,
          organizationId: result.organizationId,
          dataCenter: result.dataCenter,
          environment: result.environment,
          externalZohoId: result.externalVendorId,
        },
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function listBooksVendorMappings(
  actor: Actor,
  organizationId?: string,
) {
  if (!["ADMIN", "ACCOUNTS", "MANAGEMENT"].includes(actor.role))
    throw new HttpError(403, "Your role cannot view Books vendor mappings.");
  const config = getConfig("ZOHO", process.env, organizationId);
  const companyId = await destinationCompanyForActor(actor, config);
  const mappings = await db.vendorBooksMapping.findMany({
    where: {
      vendor: { companyId },
      organizationId: config.organizationId,
      dataCenter: config.dataCenter,
      environment: config.environment,
    },
    include: { vendor: { select: { id: true, name: true, currency: true } } },
    orderBy: { createdAt: "desc" },
  });
  return {
    organizationId: config.organizationId,
    mappings: mappings.map((mapping) => ({
      id: mapping.id,
      vendorId: mapping.vendorId,
      organizationId: mapping.organizationId,
      dataCenter: mapping.dataCenter,
      environment: mapping.environment,
      externalZohoId: mapping.externalVendorId,
      vendor: mapping.vendor,
    })),
  };
}
