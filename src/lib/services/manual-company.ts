import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireCompanyAccess } from "@/lib/company";
import { HttpError } from "@/lib/http";
import { productionBooksRuntimeReady } from "@/lib/integrations/config";

const inputSchema = z
  .object({
    companyName: z
      .string()
      .trim()
      .min(2)
      .max(160)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    reference: z
      .string()
      .trim()
      .min(10)
      .max(160)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    memberEmail: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase())
      .optional(),
  })
  .strict();

/** Trusted operator bootstrap for manual entry. It creates no provider destination or grant. */
export async function prepareManualCompany(actor: Actor, payload: unknown) {
  // This pure runtime validator requires no Books credentials, profiles or network access.
  if (
    process.env.ALLOW_MANUAL_COMPANY_SETUP !== "true" ||
    !productionBooksRuntimeReady(process.env) ||
    [
      "ZOHO_BOOKS_WRITE_ENABLED",
      "ZOHO_BOOKS_LIVE_ENABLED",
      "ALLOW_PRODUCTION_ACCOUNTING_WRITES",
    ].some((name) => process.env[name] !== "false")
  )
    throw new HttpError(
      409,
      "Manual company setup requires an operational production runtime, explicit enablement and disabled Books writes.",
    );
  if (actor.role !== "ADMIN")
    throw new HttpError(403, "An active administrator is required.");
  const input = inputSchema.parse(payload);
  if (/\[(DEMO|CONNECTION CHECK)\]/i.test(input.companyName))
    throw new HttpError(422, "Use the actual operating company name.");
  const companyId = `company-manual-${createHash("sha256").update(input.companyName.normalize("NFKC").toLowerCase()).digest("hex").slice(0, 40)}`;
  return db.$transaction(
    async (tx) => {
      const operator = await tx.user.findUnique({
        where: { id: actor.id },
        select: { active: true, role: true },
      });
      if (!operator?.active || operator.role !== "ADMIN")
        throw new HttpError(403, "An active administrator is required.");
      const member = input.memberEmail
        ? await tx.user.findUnique({
            where: { email: input.memberEmail },
            select: { id: true, active: true },
          })
        : null;
      if (input.memberEmail && !member?.active)
        throw new HttpError(
          422,
          "The requested company member must be an existing active user.",
        );
      const existing = await tx.company.findUnique({
        where: { id: companyId },
      });
      if (existing) {
        if (
          !existing.active ||
          existing.isDemo ||
          existing.liveAccountingEnabled ||
          existing.name !== input.companyName
        )
          throw new HttpError(
            409,
            "The existing company cannot be repurposed by manual setup.",
          );
        await requireCompanyAccess(actor, companyId, tx);
      } else {
        if (
          await tx.company.findFirst({
            where: { name: input.companyName },
            select: { id: true },
          })
        )
          throw new HttpError(
            409,
            "A company with this name already exists. Review its existing assignment.",
          );
        await tx.company.create({
          data: {
            id: companyId,
            name: input.companyName,
            isDemo: false,
            liveAccountingEnabled: false,
            memberships: { create: { userId: actor.id } },
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: actor.id,
            companyId,
            action: "MANUAL_COMPANY_PREPARED",
            entityType: "Company",
            entityId: companyId,
            details: {
              reference: input.reference,
              source: "reauthenticated_operator",
              operatorMembershipCreated: true,
              financialWritesEnabled: false,
            },
          },
        });
      }
      let memberAssigned = false;
      if (member && member.id !== actor.id) {
        const identity = { userId: member.id, companyId };
        const membership = await tx.userCompanyMembership.findUnique({
          where: { userId_companyId: identity },
        });
        if (!membership?.active) {
          await tx.userCompanyMembership.upsert({
            where: { userId_companyId: identity },
            create: identity,
            update: { active: true },
          });
          await tx.auditLog.create({
            data: {
              actorId: actor.id,
              companyId,
              action: "COMPANY_MEMBERSHIP_GRANTED",
              entityType: "User",
              entityId: member.id,
              details: {
                reference: input.reference,
                source: "reauthenticated_operator",
                previousActive: membership?.active ?? null,
                active: true,
              },
            },
          });
          memberAssigned = true;
        }
      }
      return {
        companyId,
        created: !existing,
        memberAssigned,
        providerRequests: 0,
        financialWritesEnabled: false,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
