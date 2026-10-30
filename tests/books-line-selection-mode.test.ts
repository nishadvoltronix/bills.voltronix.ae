import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { booksMappingFingerprint } from "@/lib/integrations/books";
import { booksLineSelectionRequired, booksMappingSchema, type ZohoConfig } from "@/lib/integrations/config";

const original = { verified: true, baseCurrency: "AED", currencies: { AED: { id: "101" } },
  taxes: { "5.00": { id: "102", percentage: "5" } }, categories: { MATERIALS: { accountId: "103" } } };
const explicit = { ...original, taxes: {}, categories: {}, lineSelectionRequired: true };
describe("explicit line-only accounting configuration", () => {
  it("does not insert a mode field or alter existing complete mapping hashes", () => {
    const parsed = booksMappingSchema.parse(original);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(original));
    expect(parsed).not.toHaveProperty("lineSelectionRequired");
    expect(booksMappingFingerprint({ booksMapping: parsed } as ZohoConfig))
      .toBe(createHash("sha256").update(JSON.stringify(original)).digest("hex"));
  });
  it("accepts explicit selections with only the exact base-currency mapping", () => {
    expect(booksMappingSchema.parse(explicit)).toEqual(explicit);
  });
  it("distinguishes absent legacy configuration from an invalid configured organization", () => {
    expect(booksLineSelectionRequired("100", { NODE_ENV: "test" })).toBe(false);
    expect(() => booksLineSelectionRequired("100", { NODE_ENV: "test", ZOHO_BOOKS_ORGANIZATION_ID: "100x", ZOHO_BOOKS_MAPPING_JSON: JSON.stringify(explicit) })).toThrow();
  });
  it("retains the final-save requirement without requiring available OAuth credentials", () => {
    const env = { ...process.env, ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([
      { organizationId: "100", name: "Fictional company", mapping: explicit },
    ]), ZOHO_BOOKS_CLIENT_ID: "", ZOHO_BOOKS_CLIENT_SECRET: "" };
    expect(booksLineSelectionRequired("100", env)).toBe(true);
    expect(booksLineSelectionRequired("200", env)).toBe(false);
  });
  it.each([
    { ...explicit, categories: original.categories }, { ...explicit, taxes: original.taxes },
    { ...explicit, currencies: {} }, { ...explicit, currencies: { USD: { id: "104" } } },
    { ...explicit, lineSelectionRequired: false },
  ])("rejects ambiguous defaults, absent base currency, or a false mode field", value => {
    expect(booksMappingSchema.safeParse(value).success).toBe(false);
  });
});
