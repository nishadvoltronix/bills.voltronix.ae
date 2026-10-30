import type { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/auth";

export type IncomingSource = {
  target: "ZOHO" | "CRM";
  companyId: string | null;
  organizationId: string;
  dataCenter: string;
  environment: string;
  organizationName: string;
};
export type IncomingSyncInput = {
  actor: Actor;
  source: IncomingSource;
  mode: "incremental" | "reconcile";
  watermark: string | null;
  continuation: unknown;
  get(path: string, query?: Record<string, string>, headers?: Record<string, string>): Promise<unknown>;
  getBytes?(path: string): Promise<Uint8Array>;
  assertLease(tx: Prisma.TransactionClient): Promise<void>;
  checkpoint(value: Prisma.InputJsonValue | null, tx?: Prisma.TransactionClient): Promise<void>;
  maxRequests: number;
  stopped(): boolean;
};
export type IncomingSyncResult = {
  complete: boolean;
  continuation?: Prisma.InputJsonValue | null;
  watermark?: string;
  reconciled?: boolean;
  processed: number;
};
