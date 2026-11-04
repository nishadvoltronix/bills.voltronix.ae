import "server-only";
import type { Prisma } from "@prisma/client";
import { isSupersededIntegrationJob } from "./source-supersession";

/** Creation stays immutable. Versioned updates share its exact external bill ID. */
export async function currentBooksMutation(store: Prisma.TransactionClient, billId: string) {
  const operations = await store.integrationJob.findMany({ where: { billId, target: "ZOHO", operation: { in: ["CREATE_BILL", "UPDATE_BILL"] } },
    orderBy: [{ sourceVersion: "desc" }, { createdAt: "desc" }, { id: "desc" }] });
  return operations.find(operation => !isSupersededIntegrationJob(operation)) ?? null;
}
export async function confirmedBooksMutation(store: Prisma.TransactionClient, billId: string) {
  const operations = await store.integrationJob.findMany({ where: { billId, target: "ZOHO", operation: { in: ["CREATE_BILL", "UPDATE_BILL"] }, status: "SUCCEEDED" },
    orderBy: [{ sourceVersion: "desc" }, { createdAt: "desc" }, { id: "desc" }] });
  return operations.find(operation => !isSupersededIntegrationJob(operation) && operation.externalId) ?? null;
}
