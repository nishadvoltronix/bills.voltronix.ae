import { createHash } from "node:crypto";
import { transferJsonHash, transferAssetPath, type ZohoDataTransferManifest } from "@/lib/services/zoho-data-transfer-format";

export const transferOriginalBytes = Buffer.from("%PDF-1.7\nprivate fixture original\n%%EOF\n");
export const transferFixtureMapping = { verified: true as const, jobModule: "Deals", jobNumberField: "JobDealNumber",
  jobNameField: "Deal_Name", jobValueField: "Amount", customerField: "Account_Name", currencyField: "Currency" };

/** Fictional complete Books/CRM inventory, with two companies and an intentionally unassigned legacy deal. */
export function zohoDataTransferFixture(): ZohoDataTransferManifest {
  const time = "2026-10-01T00:00:00.000Z", later = "2026-10-01T01:00:00.000Z";
  const crm = { organizationId: "31", dataCenter: "US" as const, environment: "production" as const };
  const companies = ["11", "12"].map((organizationId) => ({ id: `connection-check-books-${organizationId}`,
    name: `Connection check ${organizationId}`, isDemo: true, createdAt: time,
    books: { organizationId, dataCenter: "US" as const, environment: "production" as const, createdAt: time }, crm: { ...crm, createdAt: time } }));
  const document = { document_id: "900", file_name: "fixture.pdf", file_size: transferOriginalBytes.length, file_type: "pdf" };
  const hash = createHash("sha256").update(transferOriginalBytes).digest("hex");
  const booksBills = companies.map((company, index) => {
    const source = { bill_id: `${100 + index}`, bill_number: `SOURCE-${index}`, vendor_id: "200", vendor_name: "Source supplier",
      status: "open", currency_code: "AED", date: "2026-10-01", due_date: "2026-10-01", total: "105.00", balance: "105.00", last_modified_time: time };
    const detail = { ...source, sub_total: "100.00", tax_total: "5.00", line_items: [{ line_item_id: `${500 + index}`,
      quantity: 1, rate: 100, item_total: 100, project_id: "700" }], documents: [document] };
    const { createdAt: _createdAt, ...identity } = company.books;
    void _createdAt;
    return { id: `bill-${index}`, companyId: company.id, ...identity, organizationName: `Source organization ${index}`, externalBillId: source.bill_id,
      billNumber: source.bill_number, vendorId: source.vendor_id, vendorName: source.vendor_name, status: source.status,
      currencyCode: source.currency_code, billDate: time, dueDate: time, subtotal: detail.sub_total, taxTotal: detail.tax_total,
      total: source.total, balance: source.balance, paymentMade: null, vendorCreditsApplied: null, sourceModifiedAt: time,
      sourceSummary: source, sourceDetail: detail, lastImportRunId: `books-run-${index}`, detailImportRunId: `books-run-${index}`,
      importedAt: time, lastSeenAt: time, detailFetchedAt: time, isStale: false };
  });
  const attachments = booksBills.map((bill, index) => ({ id: `attachment-${index}`, billId: bill.id, companyId: bill.companyId,
    organizationId: bill.organizationId, dataCenter: bill.dataCenter, environment: bill.environment, externalDocumentId: "900",
    sourceMetadata: document, sourceMetadataHash: transferJsonHash(document), fileName: "fixture.pdf", mimeType: "application/pdf" as const,
    byteSize: transferOriginalBytes.length, sha256: hash, downloadedAt: time, importedAt: time, assetPath: transferAssetPath(hash, "application/pdf") }));
  const crmSnapshots: ZohoDataTransferManifest["crmSnapshots"] = [...companies, null].map((company, index) => {
    const source = { id: `${300 + index}`, JobDealNumber: company ? `JOB-${index}` : null, Deal_Name: `Source job ${index}`,
      Amount: "1000.00", Account_Name: { id: "800", name: "Source customer" }, Currency: "AED", Books_Organization_ID: company?.books.organizationId ?? "99",
      Stage: "Closed Won", Created_Time: time, Modified_Time: time };
    return { id: `snapshot-${index}`, crmOrganizationId: crm.organizationId, dataCenter: crm.dataCenter, environment: crm.environment,
      sourceModule: "Deals", externalCrmId: source.id, companyId: company?.id ?? null, booksOrganizationId: source.Books_Organization_ID,
      jobNumber: source.JobDealNumber, normalizedJobNumber: source.JobDealNumber, name: source.Deal_Name,
      customerId: "800", customerName: "Source customer", currencyCode: "AED", amount: "1000.00", approvedVariations: null,
      stage: source.Stage, canonicalJobId: company ? `job-${index}` : null, linkStatus: company ? "READY" : "UNASSIGNED_COMPANY",
      sourceModifiedAt: time, sourceRecordJson: source, importRunId: "crm-run", importedAt: time, lastSeenAt: time, isStale: false };
  });
  const canonicalJobs = companies.map((company, index) => ({ id: `job-${index}`, companyId: company.id, jobNumber: `JOB-${index}`,
    name: `Source job ${index}`, customer: "Source customer", contractValue: "1000.00", approvedVariations: "0.00",
    currency: "AED" as const, externalCrmId: `${300 + index}`, isDemo: true, createdAt: time }));
  const proof = { booksSource: { organizationId: "11", dataCenter: "US" as const, environment: "production" as const }, crmSource: crm, portalId: "600",
    sourceProject: { project_id: "700", zprojects_project_id: "701", project_name: "Source project", is_from_zoho_projects: true },
    sourceDealsPages: [{ deals: [{ id: "302" }], info: { page: 1, per_page: 200, has_next_page: false } }],
    sourceCrmRecords: [{ id: "302", DealNumber: null, Modified_Time: time }] };
  return { schemaVersion: 1, kind: "ZOHO_SOURCE_CACHE", exportedAt: later, companies,
    sourceCredentials: [companies[0].books, companies[1].books, crm].map((source, index) => ({ target: index === 2 ? "CRM" as const : "ZOHO" as const,
      organizationId: source.organizationId, dataCenter: source.dataCenter, connectionFingerprint: "a".repeat(64), createdAt: time, updatedAt: time })),
    booksRuns: booksBills.map((bill) => ({ id: bill.lastImportRunId, companyId: bill.companyId, organizationId: bill.organizationId,
      organizationName: bill.organizationName, dataCenter: bill.dataCenter, environment: bill.environment, status: "COMPLETE", runKind: "FULL",
      lastPage: 1, lastPageHash: null, listingComplete: true, listedCount: 1, detailCount: 1, startedAt: time, completedAt: later })),
    crmRuns: [{ id: "crm-run", crmOrganizationId: crm.organizationId, dataCenter: crm.dataCenter, environment: crm.environment,
      sourceModule: "Deals", scopeHash: "b".repeat(64), mappingJson: transferFixtureMapping,
      fieldsJson: ["id", "JobDealNumber", "Deal_Name", "Amount", "Account_Name", "Currency", "Books_Organization_ID", "Stage", "Created_Time", "Modified_Time"],
      status: "COMPLETE", runKind: "FULL", lastPage: 1, lastPageHash: null, listingComplete: true, snapshotCount: 3,
      mappedCount: 2, canonicalCount: 2, unassignedCount: 1, reviewCount: 0, startedAt: time, completedAt: later }],
    booksBills, attachments, crmSnapshots, canonicalJobs,
    associations: [{ id: "association", companyId: companies[0].id, ...proof.booksSource, booksProjectId: "700", projectName: "Source project",
      zprojectsProjectId: "701", portalId: proof.portalId, crmOrganizationId: crm.organizationId, crmDataCenter: crm.dataCenter,
      crmEnvironment: crm.environment, dealIds: ["302"], sourceProject: proof.sourceProject, sourceDealsPages: proof.sourceDealsPages,
      sourceCrmRecords: proof.sourceCrmRecords, sourceHash: transferJsonHash(proof), status: "VERIFIED", verifiedAt: time,
      validUntil: "2026-10-02T00:00:00.000Z", nextRefreshAt: "2026-10-01T00:05:00.000Z", lastAttemptAt: time,
      lastErrorCode: null, failures: 0, backoffUntil: null, importedAt: time, updatedAt: time }],
    cooldowns: [{ target: "ZOHO", ...proof.booksSource, notBefore: "2026-11-01T00:00:00.000Z" }] };
}
