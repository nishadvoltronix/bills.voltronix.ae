/** An explicit provider tax, including zero rate, is different from No VAT. */
export function hasBooksVendorTaxConflict(
  taxTreatment: unknown,
  lineItems: readonly { tax_id?: string | null }[],
) {
  // Only act on the provider's explicit classification. An absent registration
  // number or an unknown treatment does not establish a supplier's VAT status.
  return taxTreatment === "vat_not_registered" &&
    lineItems.some((line) => typeof line.tax_id === "string" && line.tax_id.trim().length > 0);
}

export const BOOKS_VENDOR_VAT_REVIEW_MESSAGE = "Zoho marks this supplier as VAT not registered, but this bill selects VAT (including Zero Rate). Check the supplier and original invoice. Keep valid invoice VAT and ask an administrator to correct the supplier profile. Choose No VAT only when the original invoice has no VAT.";

export type BooksVendorVatMetadata = {
  status: "verified" | "unavailable";
  taxTreatment: "vat_registered" | "vat_not_registered" | "unknown";
  hasTaxRegistrationNumber: boolean;
  checkedAt: string | null;
  warning: string | null;
};

/** Advisory metadata only; the caller must first verify the exact contact identity. */
export function booksVendorVatMetadata(contact: { tax_treatment?: unknown; tax_reg_no?: unknown }, checkedAt = new Date().toISOString()): BooksVendorVatMetadata {
  const treatment = typeof contact.tax_treatment === "string" ? contact.tax_treatment.trim().toLowerCase() : "";
  const taxTreatment = treatment === "vat_registered" || treatment === "vat_not_registered" ? treatment : "unknown";
  return { status: "verified", taxTreatment,
    hasTaxRegistrationNumber: typeof contact.tax_reg_no === "string" && contact.tax_reg_no.trim().length > 0,
    checkedAt, warning: taxTreatment === "vat_not_registered" ? BOOKS_VENDOR_VAT_REVIEW_MESSAGE : null };
}
