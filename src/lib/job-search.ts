/** Full job references use exact matching; names and invoice references keep text search. */
export type ExactJobSearch = {
  kind: "JOB_NUMBER" | "RECORD_ID";
  identifiers: string[];
};

const normalize = (value: string) => value.normalize("NFKC").trim().toUpperCase();

export function parseExactJobSearch(query: string): ExactJobSearch | null {
  const value = normalize(query);
  const number = /^(?:JOB(?:\s*-\s*|\s+)?)?(\d{1,14})$/.exec(value)?.[1];
  if (number) return { kind: "JOB_NUMBER", identifiers: [...new Set([
    number, `JOB-${number}`, `JOB${number}`, `JOB ${number}`, `JOB - ${number}`, value,
  ])] };
  const reference = /^JOB\s*-\s*([A-Z0-9][A-Z0-9_-]*)$/.exec(value)?.[1];
  if (reference) return { kind: "JOB_NUMBER", identifiers: [`JOB-${reference}`] };
  if (/^\d{15,30}$/.test(value) || /^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/.test(value))
    return { kind: "RECORD_ID", identifiers: [value] };
  return null;
}

export function matchesExactJobSearch(search: ExactJobSearch, job: {
  id?: string | null;
  canonicalJobId?: string | null;
  jobNumber?: string | null;
  normalizedJobNumber?: string | null;
  externalCrmId?: string | null;
}): boolean {
  const fields = search.kind === "JOB_NUMBER" ? [job.jobNumber, job.normalizedJobNumber]
    : [job.id, job.canonicalJobId, job.externalCrmId];
  return fields.some(value => typeof value === "string" && search.identifiers.includes(normalize(value)));
}
