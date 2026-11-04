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
