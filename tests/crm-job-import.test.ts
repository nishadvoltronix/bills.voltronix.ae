import { describe, expect, it, vi } from "vitest";
import { VERIFIED_CRM_JOB_MAPPING as mapping } from "@/lib/integrations/crm";
import { crmJobImportFields, crmJobPageQuery, crmNativeAmount, parseCrmJobPage, projectCrmJobSource } from "@/lib/services/crm-job-import";
vi.mock("@/lib/db", () => ({ db: {} }));
const record = { id: "101", JobDealNumber: "JOB-101", Deal_Name: "Fictional source job", Account_Name: { id: "201", name: "Fictional customer" },
  Amount: "123.4500", Currency: "AED", Books_Organization_ID: "301", Stage: "Closed Lost", Modified_Time: "2026-10-29T10:00:00+04:00" };
const assignments = [{ companyId: "company", booksOrganizationId: "301" }];
const response = { data: [record], info: { page: 1, count: 1, more_records: false } };

describe("complete CRM source pagination", () => {
  it("requests all stages, exact source fields and stable pagination through the 2000-record boundary", () => {
    expect(crmJobImportFields(mapping)).toContain("Books_Organization_ID");
    expect(crmJobPageQuery(mapping, 1)).toMatchObject({ page: "1", per_page: "200", converted: "both", sort_by: "id", sort_order: "asc" });
    expect(crmJobPageQuery(mapping, 10)).toHaveProperty("page", "10");
    const next = crmJobPageQuery(mapping, 11, "fictional-page-token");
    expect(next).toHaveProperty("page_token", "fictional-page-token");
    expect(next).not.toHaveProperty("page");
    expect(next).not.toHaveProperty("criteria");
    expect(next).not.toHaveProperty("cvid");
    expect(() => crmJobPageQuery(mapping, 11)).toThrow();
    expect(() => crmJobPageQuery(mapping, 501, "fictional")).toThrow();
  });
  it("retains original JSON and native stages without filtering opportunities or inventing a job number", () => {
    expect(parseCrmJobPage(response, 1).records).toEqual([record]);
    const opportunity = { ...record, JobDealNumber: null, Books_Organization_ID: null };
    expect(parseCrmJobPage({ ...response, data: [opportunity] }, 1).records).toEqual([opportunity]);
    expect(projectCrmJobSource(opportunity, mapping, assignments)).toMatchObject({ jobNumber: null, companyId: null, linkStatus: "UNASSIGNED_COMPANY" });
  });
  it.each([
    { ...response, data: [record, record], info: { page: 1, count: 2, more_records: false } },
    { ...response, info: { page: 2, count: 1, more_records: false } },
    { ...response, info: { page: 1, count: 2, more_records: false } },
    { ...response, info: {} },
    { data: [], info: { page: 1, count: 0, more_records: true } },
  ])("rejects duplicate or unprovable pagination", (input) => expect(() => parseCrmJobPage(input, 1)).toThrow());
  it("requires a cursor at the numeric page limit and accepts native token page metadata afterwards", () => {
    expect(() => parseCrmJobPage({ ...response, info: { page: 10, more_records: true } }, 10)).toThrow();
    expect(parseCrmJobPage({ ...response, info: { page: 10, more_records: true, next_page_token: "fictional-next" } }, 10)).toMatchObject({ hasMore: true, nextPageToken: "fictional-next" });
    expect(parseCrmJobPage({ ...response, info: { more_records: false } }, 11)).toMatchObject({ hasMore: false });
  });
});

describe("native CRM values and strict company assignment", () => {
  it("preserves decimal text, stage, missing variations and the exact company source", () => {
    expect(projectCrmJobSource(record, mapping, assignments)).toMatchObject({ companyId: "company", amount: "123.4500", stage: "Closed Lost", approvedVariations: null, linkStatus: "PENDING" });
    expect(crmNativeAmount("9007199254740993.001")).toBe("9007199254740993.001");
    expect(crmNativeAmount(9007199254740992)).toBeNull();
    expect(crmNativeAmount(null)).toBeNull();
    expect(crmNativeAmount(0)).toBe("0");
  });
  it.each([null, undefined, "999", 301, "301 "])("does not guess a company from malformed or unmatched Books identity %s", (books) => {
    expect(projectCrmJobSource({ ...record, Books_Organization_ID: books }, mapping, assignments)).toMatchObject({ companyId: null, linkStatus: "UNASSIGNED_COMPANY" });
  });
  it.each([{ Currency: "KWD", Amount: "1.234" }, { Account_Name: null }, { Amount: "-1" }, { Amount: "bad" }, { JobDealNumber: null }])
    ("retains unsupported data as review-only without creating accounting defaults", (changes) => {
      expect(projectCrmJobSource({ ...record, ...changes }, mapping, assignments)).toMatchObject({ companyId: "company", linkStatus: "INVALID_SOURCE" });
    });
  it("keeps an absent budget unknown while allowing an otherwise valid source job", () => {
    expect(projectCrmJobSource({ ...record, Amount: null }, mapping, assignments)).toMatchObject({ amount: null, approvedVariations: null, linkStatus: "PENDING" });
  });
  it("retains a source variation beyond local decimal limits for review", () => {
    expect(projectCrmJobSource({ ...record, Variations: "10000000000000000.00" }, { ...mapping, approvedVariationsField: "Variations" }, assignments))
      .toMatchObject({ approvedVariations: "10000000000000000.00", linkStatus: "INVALID_SOURCE" });
  });
});
