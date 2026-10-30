export type AppRole = "ADMIN" | "ACCOUNTS" | "DATA_ENTRY" | "MANAGEMENT";
export interface Actor {
  id: string;
  role: AppRole;
}
export interface BillAccess {
  createdById: string;
  status: string;
}

export function canCreateBill(actor: Actor): boolean {
  return ["ADMIN", "ACCOUNTS", "DATA_ENTRY"].includes(actor.role);
}

export function canViewBill(
  actor: Actor,
  bill: Pick<BillAccess, "createdById">,
): boolean {
  return actor.role !== "DATA_ENTRY" || bill.createdById === actor.id;
}

export function canEditBill(actor: Actor, bill: BillAccess): boolean {
  return (
    canCreateBill(actor) &&
    canViewBill(actor, bill) &&
    ["DRAFT", "REJECTED"].includes(bill.status)
  );
}

export function canApproveBill(actor: Actor, bill: BillAccess): boolean {
  return (
    ["ADMIN", "ACCOUNTS"].includes(actor.role) &&
    bill.status === "PENDING_APPROVAL" &&
    actor.id !== bill.createdById
  );
}

export function canManageVendors(actor: Actor): boolean {
  return ["ADMIN", "ACCOUNTS"].includes(actor.role);
}

export function canManageJobs(actor: Actor): boolean {
  return actor.role === "ADMIN";
}

export function canViewFinancialSummary(actor: Actor): boolean {
  return actor.role !== "DATA_ENTRY";
}

export function canViewAuditLog(actor: Actor): boolean {
  return ["ADMIN", "ACCOUNTS"].includes(actor.role);
}

/** Ownership restriction only. Every database query must also apply current company membership. */
export function billScope(actor: Actor): { createdById?: string } {
  return actor.role === "DATA_ENTRY" ? { createdById: actor.id } : {};
}
