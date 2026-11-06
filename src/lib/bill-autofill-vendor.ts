export type AutofillVendorIdentity = {
  vendorName: string | null;
  vendorTrn: string | null;
  currency: string;
};

export const normalizeAutofillVendorIdentity = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export function usableAutofillVendorIdentity(identity: AutofillVendorIdentity): boolean {
  if (identity.vendorName !== null && !normalizeAutofillVendorIdentity(identity.vendorName)) return false;
  if (identity.vendorTrn !== null && !normalizeAutofillVendorIdentity(identity.vendorTrn)) return false;
  return identity.vendorName !== null || identity.vendorTrn !== null;
}

/** Printed name and TRN are independent constraints; neither can replace the other. */
export function matchesAutofillVendorIdentity(identity: AutofillVendorIdentity,
  vendor: { name: string; trn?: string | null; currency: string }): boolean {
  return usableAutofillVendorIdentity(identity) && vendor.currency === identity.currency &&
    (identity.vendorName === null || normalizeAutofillVendorIdentity(vendor.name) === normalizeAutofillVendorIdentity(identity.vendorName)) &&
    (identity.vendorTrn === null || normalizeAutofillVendorIdentity(vendor.trn ?? "") === normalizeAutofillVendorIdentity(identity.vendorTrn));
}
