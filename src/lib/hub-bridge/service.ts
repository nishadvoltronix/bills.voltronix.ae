import "server-only";
import { Prisma, type PrismaClient } from "@prisma/client";
import Decimal from "decimal.js";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { isRecognizedBillStatus } from "@/lib/finance";
import { hubNonceHash, type HubClaims } from "./verify";

const unavailable = () => new HttpError(404, "Billing record unavailable.");
const money = (value: { toString(): string } | null) => new Decimal(value?.toString() ?? "0");

/** Current Billing roles/memberships are checked independently of Hub claims. */
export async function readHubJobBilling(claims: HubClaims, store: PrismaClient = db, now = new Date()) {
  try {
    return await store.$transaction(async tx => {
      if (claims.exp * 1000 <= now.getTime()) throw unavailable();
      const binding = await tx.hubUserBinding.findUnique({
        where: { issuer_subject: { issuer: claims.iss, subject: claims.sub } },
        include: { billingUser: { include: { memberships: {
          where: { companyId: claims.companyId, active: true, company: { active: true } },
        } } } },
      });
      const actor = binding?.billingUser;
      if (!actor?.active || !["ADMIN", "ACCOUNTS", "MANAGEMENT"].includes(actor.role) || actor.memberships.length !== 1)
        throw unavailable();
      const destination = await tx.companyIntegrationDestination.findFirst({ where: {
        companyId: claims.companyId, target: "CRM", organizationId: claims.crmOrganizationId,
        dataCenter: claims.dataCenter, environment: claims.environment,
      }, select: { companyId: true } });
      if (!destination) throw unavailable();
      const job = await tx.job.findFirst({ where: { companyId: claims.companyId, externalCrmId: claims.dealId },
        select: { id: true, jobNumber: true, currency: true } });
      if (!job || job.jobNumber.normalize("NFKC").trim().toUpperCase() !== claims.jobNumber.normalize("NFKC").trim().toUpperCase())
        throw unavailable();
      // Expired tokens fail before cleanup; a nonce remains unique throughout its lifetime.
      await tx.hubBridgeNonce.deleteMany({ where: { expiresAt: { lt: now } } });
      await tx.hubBridgeNonce.create({ data: { nonceHash: hubNonceHash(claims), expiresAt: new Date(claims.exp * 1000) } });
      const where = { jobId: job.id, companyId: claims.companyId };
      if (await tx.bill.count({ where: { ...where, currency: { not: job.currency } } })) throw unavailable();
      const billCount = await tx.bill.count({ where });
      const totals = await tx.bill.aggregate({ where: { ...where, status: { in: ["READY", "APPROVED"] } },
        _sum: { subtotal: true, discount: true, total: true, paidAmount: true } });
      const bills = await tx.bill.findMany({ where, take: 100,
        orderBy: [{ invoiceDate: "desc" }, { id: "desc" }],
        select: { id: true, invoiceNumber: true, invoiceDate: true, status: true, currency: true,
          total: true, paidAmount: true, syncRecords: { where: { target: "ZOHO" },
            select: { status: true, organizationId: true, externalId: true, lastSyncedAt: true } } },
      });
      if (bills.some(bill => bill.currency !== job.currency)) throw unavailable();
      return {
        state: "ready" as const, companyId: claims.companyId, crmOrganizationId: claims.crmOrganizationId,
        dealId: claims.dealId, jobId: job.id, jobNumber: job.jobNumber, currency: job.currency, crmLinkStatus: "LINKED" as const,
        billCount, truncated: billCount > bills.length,
        summary: {
          recognizedExpenses: money(totals._sum.subtotal).minus(money(totals._sum.discount)).toFixed(2),
          grossPayable: money(totals._sum.total).toFixed(2),
          paid: money(totals._sum.paidAmount).toFixed(2),
          outstanding: money(totals._sum.total).minus(money(totals._sum.paidAmount)).toFixed(2),
        },
        bills: bills.map(bill => ({ id: bill.id, invoiceNumber: bill.invoiceNumber,
          invoiceDate: bill.invoiceDate.toISOString().slice(0, 10), status: bill.status,
          total: bill.total.toFixed(2), paid: bill.paidAmount.toFixed(2),
          outstanding: isRecognizedBillStatus(bill.status) ? money(bill.total).minus(money(bill.paidAmount)).toFixed(2) : "0.00",
          syncStatus: bill.syncRecords[0]?.status ?? "NOT_CONFIGURED",
          syncOrganizationId: bill.syncRecords[0]?.organizationId ?? null,
          syncExternalId: bill.syncRecords[0]?.externalId ?? null,
          lastSyncedAt: bill.syncRecords[0]?.lastSyncedAt?.toISOString() ?? null,
        })),
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
      throw new HttpError(401, "Billing request not authorized.");
    throw error;
  }
}
