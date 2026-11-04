import { describe, expect, it } from "vitest";
import { matchesExactJobSearch, parseExactJobSearch } from "@/lib/job-search";

describe("full job reference searches", () => {
  it.each(["5383", "JOB-5383", "job5383", " job - 5383 ", "JOB 5383", "５３８３"])("recognizes the full reference %s", query => {
    const search = parseExactJobSearch(query)!;
    expect(search.kind).toBe("JOB_NUMBER");
    expect(matchesExactJobSearch(search, { jobNumber: "JOB-5383" })).toBe(true);
    expect(matchesExactJobSearch(search, { jobNumber: "5383" })).toBe(true);
    expect(matchesExactJobSearch(search, { jobNumber: "JOB5383" })).toBe(true);
    expect(matchesExactJobSearch(search, { jobNumber: "JOB 5383" })).toBe(true);
    for (const jobNumber of ["JOB-15383", "JOB-53830", "JOB-538", "JOB-05383"])
      expect(matchesExactJobSearch(search, { jobNumber })).toBe(false);
    expect(matchesExactJobSearch(search, { jobNumber: "JOB-9000", externalCrmId: "5383" })).toBe(false);
  });
  it("preserves leading zeroes and explicit alphanumeric references", () => {
    const zeroes = parseExactJobSearch("JOB-0053")!;
    expect(matchesExactJobSearch(zeroes, { jobNumber: "0053" })).toBe(true);
    expect(matchesExactJobSearch(zeroes, { jobNumber: "JOB-53" })).toBe(false);
    const named = parseExactJobSearch("job-alpha")!;
    expect(matchesExactJobSearch(named, { jobNumber: "JOB-ALPHA" })).toBe(true);
    expect(matchesExactJobSearch(named, { jobNumber: "JOB-ALPHA-2" })).toBe(false);
  });
  it("matches record IDs only through identity fields", () => {
    const external = parseExactJobSearch("1234567890123456789")!;
    expect(external.kind).toBe("RECORD_ID");
    expect(matchesExactJobSearch(external, { externalCrmId: "1234567890123456789" })).toBe(true);
    expect(matchesExactJobSearch(external, { jobNumber: "1234567890123456789", externalCrmId: "91234567890123456789" })).toBe(false);
    const internal = parseExactJobSearch("4f05b67c-5617-489c-bcc9-2dd810f0585e")!;
    expect(matchesExactJobSearch(internal, { canonicalJobId: "4f05b67c-5617-489c-bcc9-2dd810f0585e" })).toBe(true);
  });
  it.each(["Switch room", "INVOICE-5383", "5%_", "JOB", "Job preparation", "A5383"])("keeps text search for %s", query => {
    expect(parseExactJobSearch(query)).toBeNull();
  });
});
