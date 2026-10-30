import type { BooksProjectAssociationInput } from "@/lib/services/books-project-history";

export function projectHistoryProof(companyId = "fictional-company", booksOrganizationId = "800001", crmOrganizationId = "900001",
  options: { projectId?: string; projectName?: string; dealIds?: string[]; verifiedAt?: string } = {}): BooksProjectAssociationInput {
  const dealIds = options.dealIds ?? ["300001"];
  return { companyId, booksSource: { organizationId: booksOrganizationId, dataCenter: "US", environment: "production" },
    crmSource: { organizationId: crmOrganizationId, dataCenter: "US", environment: "production" }, portalId: "700001",
    sourceProject: { project_id: options.projectId ?? "100001", project_name: options.projectName ?? "Fictional Legacy Site",
      zprojects_project_id: "200001", other_service_app_source: 1, private_provider_url: "https://example.invalid/private" },
    sourceDealsPages: [{ deals: dealIds.map((id) => ({ id, name: "Fictional legacy Deal" })),
      info: { page: 1, per_page: 200, has_next_page: "false" } }],
    sourceCrmRecords: dealIds.map((id) => ({ id, DealNumber: `LEGACY-${id}`, Deal_Name: "Fictional Legacy Site",
      JobDealNumber: null, Books_Organization_ID: null, Modified_Time: "2026-01-01T12:00:00+00:00", private_token: "fictional-secret" })),
    verifiedAt: options.verifiedAt ?? new Date(Date.now() - 60_000).toISOString() };
}
