import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ db: {} }));
import { isZohoProjectsSourceProject, parseBooksProjectAssociation } from "@/lib/services/books-project-history";
import { projectHistoryProof } from "./books-project-history-fixtures";

describe("complete Zoho Projects relationship evidence", () => {
  it("preserves exact source JSON and real CRM references without deriving job numbers or values", () => {
    const input = projectHistoryProof();
    const parsed = parseBooksProjectAssociation(input);
    expect(parsed.dealIds).toEqual(["300001"]);
    expect(parsed.sourceProject).toEqual(input.sourceProject);
    expect(parsed.sourceDealsPages).toEqual(input.sourceDealsPages);
    expect(parsed.sourceCrmRecords).toEqual(input.sourceCrmRecords);
    expect(parsed.sourceCrmRecords[0]).toMatchObject({ DealNumber: "LEGACY-300001", JobDealNumber: null, Books_Organization_ID: null });
    expect(parsed.status).toBe("VERIFIED");
    expect(parsed.validUntil.valueOf() - parsed.verifiedAt.valueOf()).toBe(24 * 60 * 60_000);
    expect(parsed.nextRefreshAt.valueOf() - parsed.verifiedAt.valueOf()).toBe(5 * 60_000);
    expect(parsed).not.toHaveProperty("canonicalJobId");
    expect(parsed).not.toHaveProperty("amount");
  });

  it("recognizes the provider's string false and preserves many Deals across complete ordered pages", () => {
    const input = projectHistoryProof(undefined, undefined, undefined, { dealIds: ["300001", "300002"] });
    input.sourceDealsPages = [
      { deals: [{ id: "300001" }], info: { page: 1, per_page: 1, has_next_page: true } },
      { deals: [{ id: "300002" }], info: { page: 2, per_page: 1, has_next_page: "false" } },
    ];
    expect(parseBooksProjectAssociation(input).dealIds).toEqual(["300001", "300002"]);
  });

  it("treats an authoritative complete empty result as removal of all associations", () => {
    const parsed = parseBooksProjectAssociation(projectHistoryProof(undefined, undefined, undefined, { dealIds: [] }));
    expect(parsed).toMatchObject({ dealIds: [], status: "UNLINKED", sourceCrmRecords: [] });
  });

  it.each([
    { deals: [{ id: "300001" }], info: { page: 1, per_page: 200, has_next_page: "true" } },
    { deals: [{ id: "300001" }], info: { page: 2, per_page: 200, has_next_page: false } },
    { deals: [{ id: "300001" }], info: { page: 1, per_page: 200 } },
    { deals: [{ id: "300001" }], info: { page: 1, per_page: 200, has_next_page: "FALSE" } },
    { deals: [{ id: 300001 }], info: { page: 1, per_page: 200, has_next_page: false } },
  ])("rejects incomplete, shifted or malformed page evidence %#", (page) => {
    expect(() => parseBooksProjectAssociation({ ...projectHistoryProof(), sourceDealsPages: [page] })).toThrow();
  });

  it("rejects duplicate provider IDs, repeated pages and pages after claimed completion", () => {
    const input = projectHistoryProof();
    input.sourceDealsPages = [{ deals: [{ id: "300001" }, { id: "300001" }], info: { page: 1, per_page: 200, has_next_page: false } }];
    expect(() => parseBooksProjectAssociation(input)).toThrow("duplicate");
    const complete = projectHistoryProof();
    expect(() => parseBooksProjectAssociation({ ...complete, sourceDealsPages: [...complete.sourceDealsPages, ...complete.sourceDealsPages] })).toThrow();
  });

  it("requires the exact CRM reference ID set and an actual native DealNumber field", () => {
    const input = projectHistoryProof();
    expect(() => parseBooksProjectAssociation({ ...input, sourceCrmRecords: [] })).toThrow();
    expect(() => parseBooksProjectAssociation({ ...input, sourceCrmRecords: [
      { id: "300002", DealNumber: "UNRELATED", Modified_Time: "2026-01-01T12:00:00Z" },
    ] })).toThrow();
    expect(() => parseBooksProjectAssociation({ ...input, sourceCrmRecords: [
      { id: "300001", Modified_Time: "2026-01-01T12:00:00Z" },
    ] })).toThrow();
  });

  it("requires explicit Zoho Projects provenance and numeric IDs rather than name matches", () => {
    const input = projectHistoryProof();
    expect(() => parseBooksProjectAssociation({ ...input, sourceProject: {
      project_id: "100001", project_name: "Fictional Legacy Site", zprojects_project_id: "200001",
    } })).toThrow();
    expect(() => parseBooksProjectAssociation({ ...input, portalId: "same-named-portal" })).toThrow();
  });

  it("accepts the distinct native detail marker but rejects contradictory source metadata", () => {
    const input = projectHistoryProof();
    const project: Record<string, unknown> = { ...(input.sourceProject as Record<string, unknown>), is_from_zoho_projects: true };
    delete project.other_service_app_source;
    expect(parseBooksProjectAssociation({ ...input, sourceProject: project }).zprojectsProjectId).toBe("200001");
    expect(isZohoProjectsSourceProject({ other_service_app_source: 1 })).toBe(true);
    expect(isZohoProjectsSourceProject({ is_from_zoho_projects: true })).toBe(true);
    expect(isZohoProjectsSourceProject({ other_service_app_source: 1, is_from_zoho_projects: false })).toBe(false);
    expect(isZohoProjectsSourceProject({ other_service_app_source: 0, is_from_zoho_projects: true })).toBe(false);
    expect(isZohoProjectsSourceProject({ other_service_app_source: "ZohoProjects" })).toBe(false);
  });

  it("hashes source evidence independently of object key order and rejects future verification", () => {
    const input = projectHistoryProof();
    const reversed = Object.fromEntries(Object.entries(input.sourceProject as object).reverse());
    expect(parseBooksProjectAssociation({ ...input, sourceProject: reversed }).sourceHash).toBe(parseBooksProjectAssociation(input).sourceHash);
    expect(() => parseBooksProjectAssociation({ ...input, verifiedAt: new Date(Date.now() + 120_000).toISOString() })).toThrow("future");
  });
});
