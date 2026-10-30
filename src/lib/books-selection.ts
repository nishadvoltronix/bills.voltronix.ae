import { z } from "zod";

const externalId = z.string().regex(/^\d{1,30}$/);
const name = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
export const BOOKS_PURCHASE_ACCOUNT_TYPES = ["expense", "cost_of_goods_sold", "other_expense", "other_asset", "other_current_asset", "fixed_asset"] as const;

/** Server-normalized provider metadata. Parsing alone does not establish provider identity. */
export const booksSelectionSchema = z.object({
  organizationId: externalId,
  dataCenter: z.enum(["US", "EU", "IN", "AU", "JP", "CA", "CN", "SA", "AE"]),
  environment: z.enum(["sandbox", "production"]),
  accountId: externalId,
  accountName: name,
  taxId: externalId,
  taxName: name,
  taxRate: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).refine((value) => Number(value) <= 100),
  customerId: externalId.nullable(),
  customerName: name.nullable(),
}).strict().refine((value) => (value.customerId === null) === (value.customerName === null), {
  message: "Customer identity and label must be selected together.",
});

export type BooksSelection = z.infer<typeof booksSelectionSchema>;
export function booksSelectionDestination(selection: BooksSelection) {
  return JSON.stringify([selection.organizationId, selection.dataCenter, selection.environment]);
}

/** Omit null selections so existing snapshots and their hashes keep their original shape. */
export function booksSelectionFields(value: unknown): { booksSelection?: BooksSelection } {
  return value === null || value === undefined ? {} : { booksSelection: booksSelectionSchema.parse(value) };
}

/** Derive the persisted mode from complete line selections, never from request flags. */
export function booksLineTaxMode(lines: readonly { booksSelection?: unknown }[]) {
  const selected = lines.filter((line) => booksSelectionFields(line.booksSelection).booksSelection).length;
  if (selected && selected !== lines.length)
    throw new Error("Every line must use the same Books line tax mode.");
  return selected > 0;
}

export function assertBooksLineTaxMode(mode: boolean | undefined, lines: readonly { booksSelection?: unknown }[]) {
  if ((mode === true) !== booksLineTaxMode(lines))
    throw new Error("The saved bill's tax mode does not match its line selections. Review the bill before continuing.");
}
