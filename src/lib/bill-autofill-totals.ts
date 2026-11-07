import Decimal from "decimal.js";
import { BOOKS_NO_VAT, type BooksSelection } from "./books-selection";

const keys = ["subtotal", "discount", "vatAmount", "total"] as const;
type AmountKey = typeof keys[number];
type PrintedAmounts = Partial<Record<AmountKey, string | null>>;
type CalculatedAmounts = Record<AmountKey, string>;
const labels: Record<AmountKey, string> = { subtotal: "Subtotal", discount: "Discount", vatAmount: "VAT", total: "Total" };
function amount(value: unknown) {
  if (typeof value !== "string" || !/^\d{1,12}(?:\.\d{1,2})?$/.test(value)) return null;
  const parsed = new Decimal(value);
  return parsed.isFinite() ? parsed : null;
}

/** Compare evidence; never replace a price, invent a tax, or infer a payment. */
export function compareAutofillAmounts(printed: PrintedAmounts | undefined, calculated: CalculatedAmounts | null) {
  const differences = keys.flatMap(key => {
    const source = amount(printed?.[key]), current = amount(calculated?.[key]);
    if (!source || !current || source.equals(current)) return [];
    const difference = source.minus(current);
    return [{ key, label: labels[key], printed: source.toFixed(2), calculated: current.toFixed(2),
      difference: difference.toFixed(2), roundingOnly: difference.abs().lte("0.01") }];
  });
  return { differences, blocking: differences.some(row => !row.roundingOnly) };
}

type TaxDraft = Partial<BooksSelection> & { unfinished?: { tax?: boolean } };
type TaxCatalog = {
  companyId: string; organizationId: string | null; dataCenter: BooksSelection["dataCenter"] | null;
  environment: BooksSelection["environment"] | null; warning: string | null;
  taxes: { id: string; name: string; rate: string; selectable: boolean }[];
};

/** Bind a unique real scoped tax only after a user has begun Books selections. */
export function fillUnsetAutofillTax<T extends TaxDraft>(draft: T | undefined, catalog: TaxCatalog | null,
  companyId: string, printedRate: string | undefined, taxEdited = false): T | undefined {
  const rate = amount(printedRate);
  if (!draft || !draft.accountId && !draft.customerId || taxEdited || draft.taxId || draft.taxName || draft.unfinished?.tax ||
    !rate || rate.lte(0) || rate.gt(100) || !catalog || catalog.companyId !== companyId || catalog.warning ||
    !catalog.organizationId || !catalog.dataCenter || !catalog.environment ||
    draft.organizationId && draft.organizationId !== catalog.organizationId ||
    draft.dataCenter && draft.dataCenter !== catalog.dataCenter || draft.environment && draft.environment !== catalog.environment) return draft;
  const matches = catalog.taxes.filter(tax => {
    const candidate = amount(tax.rate);
    return tax.selectable && tax.id !== BOOKS_NO_VAT && /^\d{1,30}$/.test(tax.id) && candidate?.equals(rate);
  });
  if (matches.length !== 1) return draft;
  return { ...draft, organizationId: catalog.organizationId, dataCenter: catalog.dataCenter, environment: catalog.environment,
    taxId: matches[0].id, taxName: matches[0].name, taxRate: rate.toFixed(2),
    unfinished: { ...draft.unfinished, tax: false } };
}
