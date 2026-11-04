import type { InvoiceAutofillExtraction } from "./bill-autofill";

export type InvoiceAutofillVendor = {
  id: string;
  name: string;
  trn: string | null;
  currency: string;
  match: "TRN" | "NAME";
};
export type InvoiceAutofillResponse = {
  requestId: string;
  source: {
    companyId: string;
    jobId: string;
    currency: string;
    fingerprint: string;
    files: { index: number; sha256: string; byteSize: number; mimeType: "application/pdf" | "image/jpeg" | "image/png" }[];
  };
  preview: {
    fields: InvoiceAutofillExtraction["fields"] & { vendorId?: string; currency?: string };
    vendor: InvoiceAutofillVendor | null;
    vendorCandidates: InvoiceAutofillVendor[];
    evidence: InvoiceAutofillExtraction["evidence"];
    warnings: string[];
    requiresHumanReview: false;
  };
};
export type InvoiceAutofillCapability = { enabled: boolean; configured: boolean; message: string };
