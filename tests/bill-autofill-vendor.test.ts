import { describe, expect, it } from "vitest";
import { matchesAutofillVendorIdentity, usableAutofillVendorIdentity } from "@/lib/bill-autofill-vendor";

const identity = { vendorName: "Hilal Al Madhina Supermarket L.L.C.", vendorTrn: "100203642200003", currency: "AED" };
const vendor = { name: "HILAL AL MADHINA SUPERMARKET LLC", trn: "100203642200003", currency: "AED" };

describe("automatic invoice supplier identity", () => {
  it("matches exact normalized names and TRNs without punctuation or width differences", () => {
    expect(matchesAutofillVendorIdentity(identity, vendor)).toBe(true);
    expect(matchesAutofillVendorIdentity({ ...identity, vendorName: "ＨＩＬＡＬ AL MADHINA SUPERMARKET LLC", vendorTrn: "１００２０３６４２２００００３" }, vendor)).toBe(true);
  });
  it("does not turn a shared TRN into a different supplier", () => {
    expect(matchesAutofillVendorIdentity(identity, { ...vendor, name: "MANGO HYPERMARKET" })).toBe(false);
  });
  it("requires both supplied identities instead of falling back to a matching name", () => {
    expect(matchesAutofillVendorIdentity(identity, { ...vendor, trn: "100263642200003" })).toBe(false);
    expect(matchesAutofillVendorIdentity(identity, { ...vendor, trn: null })).toBe(false);
  });
  it("permits exact name only when no TRN was supplied", () => {
    expect(matchesAutofillVendorIdentity({ ...identity, vendorTrn: null }, { ...vendor, trn: null })).toBe(true);
  });
  it("permits TRN-only evidence when no supplier name was readable", () => {
    expect(matchesAutofillVendorIdentity({ ...identity, vendorName: null }, vendor)).toBe(true);
  });
  it.each(["", " ", "---", "()"])("rejects unusable supplied TRN %j even if the name matches", vendorTrn => {
    expect(usableAutofillVendorIdentity({ ...identity, vendorTrn })).toBe(false);
    expect(matchesAutofillVendorIdentity({ ...identity, vendorTrn }, vendor)).toBe(false);
  });
  it.each(["", " ", "---"])("rejects unusable supplied name %j even if the TRN matches", vendorName => {
    expect(matchesAutofillVendorIdentity({ ...identity, vendorName }, vendor)).toBe(false);
  });
  it("never uses substring or fuzzy name equality", () => {
    expect(matchesAutofillVendorIdentity(identity, { ...vendor, name: `${vendor.name} Branch` })).toBe(false);
    expect(matchesAutofillVendorIdentity(identity, { ...vendor, name: "HILAL AL MADINA SUPERMARKET LLC" })).toBe(false);
  });
  it("keeps currency exact and refuses completely absent identity", () => {
    expect(matchesAutofillVendorIdentity(identity, { ...vendor, currency: "USD" })).toBe(false);
    expect(matchesAutofillVendorIdentity(identity, { ...vendor, currency: "aed" })).toBe(false);
    expect(matchesAutofillVendorIdentity({ ...identity, vendorName: null, vendorTrn: null }, vendor)).toBe(false);
  });
});
