import "server-only";
import type { Prisma } from "@prisma/client";
import { IntegrationError } from "@/lib/integrations/config";
import type { IncomingSyncInput } from "./incoming-sync-types";

export const incomingBooksIdentity = (input: IncomingSyncInput) => ({
  companyId: input.source.companyId!,
  organizationId: input.source.organizationId,
  dataCenter: input.source.dataCenter,
  environment: input.source.environment,
});

/** Read synchronization is independent of outbound accounting-write gates. */
export async function assertIncomingBooksContext(
  tx: Prisma.TransactionClient,
  input: IncomingSyncInput,
) {
  await input.assertLease(tx);
  if (
    input.source.target !== "ZOHO" ||
    !input.source.companyId ||
    input.actor.role !== "ADMIN" ||
    !(await tx.user.findFirst({
      where: {
        id: input.actor.id,
        active: true,
        role: "ADMIN",
        memberships: {
          some: {
            companyId: input.source.companyId,
            active: true,
            company: { active: true },
          },
        },
      },
      select: { id: true },
    }))
  )
    throw new IntegrationError(
      "INCOMING_BOOKS_ACCESS_CHANGED",
      "Current administrator company access is required.",
      "BLOCKED",
    );
  if (
    !(await tx.companyIntegrationDestination.findFirst({
      where: {
        ...incomingBooksIdentity(input),
        target: "ZOHO",
        company: { active: true },
      },
      select: { companyId: true },
    }))
  )
    throw new IntegrationError(
      "INCOMING_BOOKS_SOURCE_CHANGED",
      "The Books source is no longer assigned to this company.",
      "BLOCKED",
    );
}
