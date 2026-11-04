import { jsonRecord } from "@/lib/books-financials";

export type MirrorIdentity = {
  id: string;
  companyId: string;
  organizationId: string;
  externalBillId: string;
  dataCenter: string;
  environment: string;
};
type NativeIdentity = {
  id: string;
  companyId: string;
  jobId: string;
  syncRecords: {
    target: string;
    externalId: string | null;
    organizationId: string | null;
  }[];
};
type Destination = {
  companyId: string;
  organizationId: string;
  dataCenter: string;
  environment: string;
};
type History = {
  billId: string;
  organizationId: string | null;
  snapshot: unknown;
};
/** Only confirmed provider identifiers can relate an imported bill to a job.
 * Project names, PO strings and free text are deliberately not matching keys. */
export function nativeMirrorLinks(
  natives: NativeIdentity[],
  mirrors: MirrorIdentity[],
  destinations: Destination[],
  history: History[],
) {
  const duplicates = new Set<string>();
  const linkedJobs = new Map<string, string>();
  const nativeCandidates = new Map<string, Set<string>>();
  const uncertainBills = new Set<string>();
  const conflictingMirrors = new Set<string>();
  let ambiguousCount = 0;
  for (const native of natives) {
    for (const sync of native.syncRecords.filter(
      (record) =>
        record.target === "ZOHO" && record.externalId && record.organizationId,
    )) {
      const candidates = mirrors.filter(
        (mirror) =>
          mirror.companyId === native.companyId &&
          mirror.organizationId === sync.organizationId &&
          mirror.externalBillId === sync.externalId,
      );
      if (!candidates.length) continue;
      // A mirrored provider identity must not be counted a second time locally.
      duplicates.add(native.id);
      const recorded = history
        .filter(
          (item) =>
            item.billId === native.id &&
            item.organizationId === sync.organizationId,
        )
        .map((item) => jsonRecord(jsonRecord(item.snapshot).destination));
      const contexts = recorded.length
        ? recorded
        : destinations.filter(
            (item) =>
              item.companyId === native.companyId &&
              item.organizationId === sync.organizationId,
          );
      // Context ambiguity must not depend on which page of mirrors was loaded.
      // SyncRecord alone does not record a data center or environment.
      const authorContexts = new Set(contexts.map((context) =>
        JSON.stringify([context.dataCenter, context.environment])));
      const verified = candidates.filter((mirror) =>
        contexts.some(
          (context) =>
            context.dataCenter === mirror.dataCenter &&
            context.environment === mirror.environment,
        ),
      );
      for (const mirror of verified) {
        const ids = nativeCandidates.get(mirror.id) ?? new Set<string>();
        ids.add(native.id);
        nativeCandidates.set(mirror.id, ids);
        if (authorContexts.size !== 1) uncertainBills.add(mirror.id);
      }
      if (
        verified.length === 1 &&
        !conflictingMirrors.has(verified[0].id) &&
        (!linkedJobs.has(verified[0].id) ||
          linkedJobs.get(verified[0].id) === native.jobId)
      )
        linkedJobs.set(verified[0].id, native.jobId);
      else {
        ambiguousCount++;
        for (const mirror of verified) {
          conflictingMirrors.add(mirror.id);
          linkedJobs.delete(mirror.id);
        }
      }
    }
  }
  // A shared job is not proof of who entered a particular bill. Authorship
  // requires exactly one native bill, even when competing bills share a job.
  const linkedBills = new Map([...nativeCandidates].flatMap(([id, natives]) =>
    natives.size === 1 && !uncertainBills.has(id) ? [[id, [...natives][0]] as const] : []));
  return { duplicates, linkedJobs, linkedBills, ambiguousCount };
}
