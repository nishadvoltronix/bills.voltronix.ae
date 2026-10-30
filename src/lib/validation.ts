import { z } from "zod";
import Decimal from "decimal.js";
import { booksSelectionSchema } from "./books-selection";
import { PAYMENT_TERMS, resolveDueDate } from "./payment-terms";

export const currencySchema = z.enum(["AED", "USD", "EUR", "GBP", "SAR"]);
export const categorySchema = z.enum([
  "MATERIALS",
  "LABOUR",
  "EQUIPMENT",
  "TRANSPORT",
  "OTHER",
]);
export const billStatusSchema = z.enum([
  "DRAFT",
  "READY",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
]);
export const paymentTermsSchema = z.enum(
  PAYMENT_TERMS.map(({ value }) => value),
);
const id = z.string().trim().min(1).max(100);
const optionalText = (max: number) => z.string().trim().max(max).optional();
const decimalMatches = (
  value: string,
  check: (decimal: Decimal) => boolean,
): boolean => {
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() && check(parsed);
  } catch {
    return false;
  }
};

const money = z
  .string()
  .trim()
  .regex(
    /^\d{1,12}(\.\d{1,2})?$/,
    "Use a positive decimal with up to 2 decimal places.",
  );
const quantity = z
  .string()
  .trim()
  .regex(/^\d{1,8}(\.\d{1,3})?$/, "Quantity supports up to 3 decimal places.")
  .refine(
    (value) => decimalMatches(value, (parsed) => parsed.greaterThan(0)),
    "Quantity must be greater than zero.",
  );
const signedMoney = z
  .string()
  .trim()
  .regex(
    /^-?\d{1,12}(\.\d{1,2})?$/,
    "Use a decimal with up to 2 decimal places.",
  );
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value &&
      value >= "1900-01-01" &&
      value <= "2199-12-31"
    );
  }, "Use a valid calendar date between 1900 and 2199.");

export const billInputSchema = z
  .object({
    companyId: id.optional(),
    vendorId: id,
    jobId: id,
    invoiceNumber: z
      .string()
      .trim()
      .min(1, "Invoice number is required.")
      .max(120),
    orderNumber: optionalText(120),
    paymentTerms: paymentTermsSchema.default("CUSTOM"),
    invoiceDate: calendarDate,
    dueDate: z.union([calendarDate, z.literal("")]).optional(),
    category: categorySchema,
    currency: currencySchema,
    description: optionalText(1000),
    notes: optionalText(4000),
    discount: money.default("0"),
    vatRate: z
      .string()
      .trim()
      .regex(/^\d{1,3}(\.\d{1,2})?$/, "Use a valid VAT rate.")
      .refine(
        (value) =>
          decimalMatches(
            value,
            (parsed) =>
              parsed.greaterThanOrEqualTo(0) && parsed.lessThanOrEqualTo(100),
          ),
        "VAT must be between 0% and 100%.",
      )
      .default("5"),
    lines: z
      .array(
        z
          .object({
            description: z
              .string()
              .trim()
              .min(1, "Line description is required.")
              .max(500),
            quantity,
            unitPrice: money,
            booksSelection: booksSelectionSchema.nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    submit: z.boolean().default(false),
    version: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!calendarDate.safeParse(value.invoiceDate).success) return;
    try {
      const expected = resolveDueDate(
        value.invoiceDate,
        value.paymentTerms,
        value.dueDate,
      );
      if (
        value.paymentTerms !== "CUSTOM" &&
        value.dueDate &&
        value.dueDate !== expected
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["dueDate"],
          message:
            "Due date must match the selected payment terms. Choose Custom to set a different date.",
        });
      }
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["dueDate"],
        message:
          error instanceof Error ? error.message : "The due date is invalid.",
      });
    }
  })
  .transform((value) => ({
    ...value,
    dueDate: resolveDueDate(
      value.invoiceDate,
      value.paymentTerms,
      value.dueDate,
    ),
  }));

export const billActionSchema = z
  .object({
    action: z.enum(["submit", "approve", "reject", "cancel", "payment"]),
    version: z.number().int().positive(),
    reason: optionalText(1000),
    amount: money.optional(),
    reference: optionalText(200),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.action === "reject" || value.action === "cancel") &&
      !value.reason
    )
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "A reason is required.",
      });
    if (value.action === "payment") {
      if (
        !value.amount ||
        !decimalMatches(value.amount, (parsed) => parsed.greaterThan(0))
      )
        ctx.addIssue({
          code: "custom",
          path: ["amount"],
          message: "A positive payment amount is required.",
        });
      if (!value.reference)
        ctx.addIssue({
          code: "custom",
          path: ["reference"],
          message: "A payment reference is required.",
        });
    }
  });

export const vendorSchema = z
  .object({
    companyId: id.optional(),
    name: z.string().trim().min(2).max(200),
    email: z.union([z.email().max(254), z.literal("")]).optional(),
    trn: z.string().trim().max(40).optional(),
    currency: currencySchema.default("AED"),
  })
  .strict();

export const jobSchema = z
  .object({
    companyId: id.optional(),
    jobNumber: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9 _./-]*$/,
        "Use letters, numbers, spaces, hyphens, periods or slashes.",
      ),
    name: z.string().trim().min(2).max(200),
    customer: z.string().trim().min(2).max(200),
    contractValue: z.union([money, z.literal(""), z.null()]).optional(),
    approvedVariations: signedMoney.default("0"),
    currency: currencySchema.default("AED"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.contractValue &&
      !decimalMatches(value.contractValue, (parsed) =>
        decimalMatches(value.approvedVariations, (variation) =>
          parsed.plus(variation).greaterThanOrEqualTo(0),
        ),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["approvedVariations"],
        message: "Adjusted job value cannot be negative.",
      });
  });

export const loginSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase().trim()),
    password: z.string().min(1).max(128),
  })
  .strict();

export type BillInput = z.infer<typeof billInputSchema>;
export type BillActionInput = z.infer<typeof billActionSchema>;
