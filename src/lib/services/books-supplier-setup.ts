import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import {
  booksConfigurationHash,
  getConfig,
  IntegrationError,
  type ZohoConfig,
} from "@/lib/integrations/config";
import { accessToken } from "@/lib/integrations/oauth";
import { ZohoTransport } from "@/lib/integrations/transport";
import { assertBooksVerificationEnvironment } from "./books-operational-setup";

const externalId = z.string().regex(/^\d{1,30}$/);
const inputSchema = z
  .object({
    companyId: z.string().min(1).max(100),
    organizationId: externalId,
    externalVendorIds: z
      .array(externalId)
      .min(1)
      .max(25)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Select each supplier ID only once.",
      ),
    reference: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/ -]{2,159}$/),
  })
  .strict();

// Zoho's contact GET contract: https://www.zoho.com/books/api/v3/contacts/
// Retain only the supplier identity needed locally, never the whole contact record.
const contactResponse = z.object({
  code: z.literal(0),
  contact: z.object({
    contact_id: externalId,
    contact_name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    contact_type: z.literal("vendor"),
    status: z.literal("active"),
    currency_id: externalId,
    currency_code: z.string().regex(/^[A-Z]{3}$/),
  }),
});
type Input = z.infer<typeof inputSchema>;
type Store = Prisma.TransactionClient;
const blocked = (code: string, message: string) =>
  new IntegrationError(code, message, "BLOCKED");

export function assertBooksSupplierSetupEnvironment() {
  assertBooksVerificationEnvironment();
  if (process.env.ALLOW_BOOKS_SUPPLIER_SETUP !== "true")
    throw blocked(
      "SUPPLIER_SETUP_NOT_ENABLED",
      "Explicit trusted-operator supplier setup enablement is required.",
    );
}

function supplierConfiguration(organizationId: string, expectedHash?: string) {
  assertBooksSupplierSetupEnvironment();
  const config = getConfig("ZOHO", process.env, organizationId);
  if (
    config.environment !== "production" ||
    !config.networkEnabled ||
    config.writeEnabled ||
    !config.booksMapping ||
    !Object.keys(config.booksMapping.currencies).length
  )
    throw blocked(
      "READ_ONLY_SUPPLIER_SETUP_REQUIRED",
      "Configure the exact production Books connection and reviewed currencies, with network access enabled and accounting writes disabled.",
    );
  if (expectedHash && booksConfigurationHash(config) !== expectedHash)
    throw blocked(
      "CONFIGURATION_CHANGED",
      "The Books connection or accounting configuration changed during supplier verification. Repeat setup with the reviewed configuration.",
    );
  return config;
}

async function requireSetupContext(
  store: Store,
  actor: Actor,
  input: Input,
  config: ZohoConfig,
) {
  const current = await store.user.findFirst({
    where: {
      id: actor.id,
      active: true,
      role: "ADMIN",
      memberships: {
        some: {
          companyId: input.companyId,
          active: true,
          company: { active: true },
        },
      },
    },
    select: { id: true },
  });
  if (!current)
    throw new HttpError(
      403,
      "An active administrator with access to this company is required.",
    );
  const company = await store.company.findUnique({
    where: { id: input.companyId },
    select: { id: true, active: true, isDemo: true },
  });
  if (
    !company ||
    !company.active ||
    company.isDemo ||
    /^(demo[-_]|connection-check-)/i.test(company.id)
  )
    throw blocked(
      "REAL_COMPANY_REQUIRED",
      "Select an active real operating company. Demo and connection-check workspaces cannot import real suppliers.",
    );
  const destination = await store.companyIntegrationDestination.findFirst({
    where: {
      target: "ZOHO",
      organizationId: config.organizationId,
      dataCenter: config.dataCenter,
      environment: "production",
    },
    select: { companyId: true },
  });
  if (!destination || destination.companyId !== input.companyId)
    throw blocked(
      "COMPANY_DESTINATION_MISMATCH",
      "The selected Books destination must belong to this exact operating company.",
    );
}

/** Reads only explicitly selected provider contacts; writes local supplier metadata atomically. */
export async function importBooksSuppliers(
  actor: Actor,
  payload: unknown,
  provided?: ZohoTransport,
) {
  assertBooksSupplierSetupEnvironment();
  if (actor.role !== "ADMIN")
    throw new HttpError(403, "An active administrator is required.");
  const input = inputSchema.parse(payload);
  const config = supplierConfiguration(input.organizationId);
  const configurationHash = booksConfigurationHash(config);
  if (
    provided &&
    (booksConfigurationHash(provided.config) !== configurationHash ||
      !provided.config.networkEnabled ||
      provided.config.writeEnabled)
  )
    throw blocked(
      "CONFIGURATION_CHANGED",
      "The supplier verification connection must match this exact read-only Books configuration.",
    );
  await requireSetupContext(db, actor, input, config);
  const transport =
    provided ?? new ZohoTransport(config, () => accessToken(config));
  const contacts: z.infer<typeof contactResponse>["contact"][] = [];
  for (const id of input.externalVendorIds) {
    supplierConfiguration(input.organizationId, configurationHash);
    const response = contactResponse.safeParse(
      await transport.request(`/books/v3/contacts/${id}`, { method: "GET" }),
    );
    if (!response.success || response.data.contact.contact_id !== id)
      throw blocked(
        "BOOKS_SUPPLIER_INVALID",
        "Each selected Books contact must return its exact ID, a valid name and an active vendor identity. No suppliers were imported.",
      );
    const contact = response.data.contact;
    if (
      config.booksMapping!.currencies[contact.currency_code]?.id !==
      contact.currency_id
    )
      throw blocked(
        "BOOKS_SUPPLIER_CURRENCY_MISMATCH",
        "Each supplier must use an exact currency ID and code configured for this Books organization. No suppliers were imported.",
      );
    contacts.push(contact);
  }
  supplierConfiguration(input.organizationId, configurationHash);
  return db.$transaction(
    async (tx) => {
      const currentConfig = supplierConfiguration(
        input.organizationId,
        configurationHash,
      );
      await requireSetupContext(tx, actor, input, currentConfig);
      const suppliers = [];
      for (const contact of contacts) {
        const destination = {
          organizationId: config.organizationId,
          dataCenter: config.dataCenter,
          environment: config.environment,
        };
        const mapping = await tx.vendorBooksMapping.findUnique({
          where: {
            organizationId_dataCenter_environment_externalVendorId: {
              ...destination,
              externalVendorId: contact.contact_id,
            },
          },
          include: {
            vendor: {
              select: {
                id: true,
                companyId: true,
                currency: true,
                isDemo: true,
                externalZohoId: true,
              },
            },
          },
        });
        const legacyVendor = await tx.vendor.findFirst({
          where: {
            companyId: input.companyId,
            externalZohoId: contact.contact_id,
          },
          select: { id: true },
        });
        if (mapping) {
          const vendor = mapping.vendor;
          if (
            vendor.companyId !== input.companyId ||
            vendor.isDemo ||
            /^demo[-_]/i.test(vendor.id) ||
            vendor.currency !== contact.currency_code ||
            (vendor.externalZohoId &&
              vendor.externalZohoId !== contact.contact_id) ||
            (legacyVendor && legacyVendor.id !== vendor.id)
          )
            throw blocked(
              "SUPPLIER_IDENTITY_CONFLICT",
              "An existing supplier mapping conflicts with this company, currency or supplier identity. Existing records were preserved.",
            );
          suppliers.push({
            vendorId: vendor.id,
            mappingId: mapping.id,
            created: false,
          });
          continue;
        }
        if (legacyVendor)
          throw blocked(
            "SUPPLIER_IDENTITY_CONFLICT",
            "A local supplier already carries this external ID without the exact destination mapping. Verify and map that explicit local supplier separately; no identity was inferred.",
          );
        const nameCollision = await tx.vendor.findFirst({
          where: { companyId: input.companyId, name: contact.contact_name },
          select: { id: true },
        });
        if (nameCollision)
          throw blocked(
            "SUPPLIER_NAME_CONFLICT",
            "A supplier with this name already exists in this company. Review and map the explicit local supplier separately; no duplicate or name-based match was created.",
          );
        const vendor = await tx.vendor.create({
          // External identity belongs to the scoped mapping, never a guessed name
          // match or an unscoped legacy externalZohoId assignment.
          data: {
            companyId: input.companyId,
            name: contact.contact_name,
            currency: contact.currency_code,
            isDemo: false,
          },
          select: { id: true },
        });
        const createdMapping = await tx.vendorBooksMapping.create({
          data: {
            vendorId: vendor.id,
            ...destination,
            externalVendorId: contact.contact_id,
          },
          select: { id: true },
        });
        await tx.auditLog.create({
          data: {
            actorId: actor.id,
            companyId: input.companyId,
            action: "BOOKS_SUPPLIER_IMPORTED",
            entityType: "Vendor",
            entityId: vendor.id,
            details: {
              ...destination,
              externalVendorId: contact.contact_id,
              reference: input.reference,
              source: "reauthenticated_operator",
              providerFinancialWrites: 0,
            },
          },
        });
        suppliers.push({
          vendorId: vendor.id,
          mappingId: createdMapping.id,
          created: true,
        });
      }
      // Environment flags are not transactionally stored; recheck immediately before commit.
      supplierConfiguration(input.organizationId, configurationHash);
      return {
        companyId: input.companyId,
        organizationId: input.organizationId,
        selected: contacts.length,
        created: suppliers.filter((supplier) => supplier.created).length,
        reused: suppliers.filter((supplier) => !supplier.created).length,
        suppliers,
        providerReads: contacts.length,
        providerFinancialWrites: 0,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 20_000,
    },
  );
}
