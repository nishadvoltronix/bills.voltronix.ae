import { describe, expect, it, vi } from "vitest";
import {
  aggregateAmounts,
  booksFinancialAmounts,
  sumKnown,
} from "@/lib/books-financials";
vi.mock("@/lib/db", () => ({ db: {} }));
import {
  ledgerJobAmounts,
  nativeMirrorLinks,
  type FinancialLedger,
} from "@/lib/services/financial-ledger";

const bill = {
  status: "partially_paid",
  total: "96.50",
  taxTotal: "4.50",
  balance: "61.50",
  paymentMade: "25",
  vendorCreditsApplied: "10",
  sourceDetail: { sub_total: 100, discount: 10, adjustment: 2, tax_total: 4.5 },
  detailImportRunId: "run",
  lastImportRunId: "run",
};

describe("source-backed Books amounts", () => {
  it("uses the discounted, adjusted provider total without subtracting discounts twice", () => {
    expect(booksFinancialAmounts(bill)).toMatchObject({
      recognizedExpenses: "92.00",
      invoicedTotal: "96.50",
      paidExpenses: "25.00",
      creditsApplied: "10.00",
      outstanding: "61.50",
      complete: true,
    });
  });
  it("keeps vendor credits separate from cash paid", () => {
    expect(
      booksFinancialAmounts({
        ...bill,
        paymentMade: "0",
        vendorCreditsApplied: "96.50",
        balance: "0",
      }),
    ).toMatchObject({
      paidExpenses: "0.00",
      creditsApplied: "96.50",
      outstanding: "0.00",
    });
  });
  it("does not infer cash from a balance when detail is missing or obsolete", () => {
    expect(
      booksFinancialAmounts({ ...bill, detailImportRunId: "old" }),
    ).toMatchObject({
      paidExpenses: null,
      recognizedExpenses: null,
      creditsApplied: null,
      outstanding: "61.50",
      complete: false,
    });
  });
  it("keeps three-decimal currencies and amounts above Number safe precision exact", () => {
    const values = booksFinancialAmounts({
      ...bill,
      total: "9007199254740993.001",
      taxTotal: "0.001",
      paymentMade: "0.001",
      vendorCreditsApplied: "0",
      balance: "9007199254740993.000",
    });
    expect(values.recognizedExpenses).toBe("9007199254740993.00");
    expect(values.paidExpenses).toBe("0.001");
    expect(sumKnown([values.invoicedTotal, "0.002"])).toBe(
      "9007199254740993.003",
    );
  });
  it("excludes drafts and voided bills but does not invent a meaning for unknown statuses", () => {
    for (const status of ["draft", "void"])
      expect(booksFinancialAmounts({ ...bill, status })).toMatchObject({
        recognized: false,
        recognizedExpenses: "0.00",
      });
    expect(
      booksFinancialAmounts({ ...bill, status: "new_provider_state" }),
    ).toMatchObject({ recognized: null, recognizedExpenses: null });
  });
  it("withholds net cost for special tax treatments while retaining explicit balances", () => {
    expect(
      booksFinancialAmounts({
        ...bill,
        sourceDetail: { is_tds_applied: true },
      }),
    ).toMatchObject({ recognizedExpenses: null, outstanding: "61.50" });
    expect(
      booksFinancialAmounts({
        ...bill,
        sourceDetail: { reverse_charge_vat_total: "2" },
      }).recognizedExpenses,
    ).toBeNull();
  });
  it("does not substitute zero for invalid or missing financial facts", () => {
    const unknown = booksFinancialAmounts({
      ...bill,
      paymentMade: null,
      taxTotal: "200",
    });
    expect(
      aggregateAmounts([booksFinancialAmounts(bill), unknown]),
    ).toMatchObject({
      recognizedExpenses: null,
      paidExpenses: null,
      outstanding: "123.00",
    });
    expect(sumKnown(["0", "0.00"])).toBe("0.00");
  });
});

describe("confirmed Books bill identity", () => {
  const native = {
    id: "native",
    companyId: "company-a",
    jobId: "job",
    syncRecords: [{ target: "ZOHO", organizationId: "org", externalId: "123" }],
  };
  const mirror = {
    id: "copy",
    companyId: "company-a",
    organizationId: "org",
    externalBillId: "123",
    dataCenter: "US",
    environment: "production",
  };
  const destination = {
    companyId: "company-a",
    organizationId: "org",
    dataCenter: "US",
    environment: "production",
  };
  it("counts a confirmed synchronized bill once and retains its verified job", () => {
    const links = nativeMirrorLinks([native], [mirror], [destination], []);
    expect([...links.duplicates]).toEqual(["native"]);
    expect(links.linkedJobs.get("copy")).toBe("job");
  });
  it("never links a similarly named or same-number bill without provider identifiers", () => {
    const links = nativeMirrorLinks(
      [{ ...native, syncRecords: [] }],
      [mirror],
      [destination],
      [],
    );
    expect(links.duplicates.size).toBe(0);
    expect(links.linkedJobs.size).toBe(0);
  });
  it("isolates the company, organization and environment", () => {
    expect(
      nativeMirrorLinks(
        [native],
        [{ ...mirror, companyId: "company-b" }],
        [destination],
        [],
      ).linkedJobs.size,
    ).toBe(0);
    expect(
      nativeMirrorLinks(
        [native],
        [{ ...mirror, organizationId: "other" }],
        [destination],
        [],
      ).linkedJobs.size,
    ).toBe(0);
    const ambiguous = nativeMirrorLinks(
      [native],
      [{ ...mirror, environment: "sandbox" }],
      [destination],
      [],
    );
    expect(ambiguous.linkedJobs.size).toBe(0);
    expect(ambiguous.ambiguousCount).toBe(1);
  });
  it("uses the destination captured on the write rather than a later rebound destination", () => {
    const links = nativeMirrorLinks(
      [native],
      [mirror],
      [{ ...destination, environment: "sandbox" }],
      [
        {
          billId: "native",
          organizationId: "org",
          snapshot: {
            destination: { dataCenter: "US", environment: "production" },
          },
        },
      ],
    );
    expect(links.linkedJobs.get("copy")).toBe("job");
  });
  it("does not assign a provider bill when competing native records disagree about its job", () => {
    const links = nativeMirrorLinks(
      [native, { ...native, id: "conflicting", jobId: "other-job" }],
      [mirror],
      [destination],
      [],
    );
    expect(links.duplicates.size).toBe(2);
    expect(links.linkedJobs.size).toBe(0);
    expect(links.ambiguousCount).toBe(1);
  });
  it("withholds job totals for a linked foreign-currency bill without an exchange rate", () => {
    const ledger = {
      mirrors: [
        {
          ...mirror,
          jobId: "job",
          currencyCode: "USD",
          amounts: booksFinancialAmounts(bill),
        },
      ],
      nativeBills: [],
      jobs: [{ id: "job", bills: [] }],
      truncated: false,
      booksListingComplete: true,
      links: { ambiguousCount: 0 },
    } as unknown as FinancialLedger;
    const result = ledgerJobAmounts(ledger, {
      id: "job",
      companyId: "company-a",
      currency: "AED",
    });
    expect(result.complete).toBe(false);
    expect(result.linked).toHaveLength(1);
  });
  it("withholds job totals when a currency-filtered ledger omits a historical native cost", () => {
    const ledger = {
      mirrors: [],
      nativeBills: [],
      jobs: [{ id: "job", bills: [{ currency: "USD" }] }],
      truncated: false,
      booksListingComplete: true,
      links: { ambiguousCount: 0 },
    } as unknown as FinancialLedger;
    expect(
      ledgerJobAmounts(ledger, {
        id: "job",
        companyId: "company-a",
        currency: "AED",
      }).complete,
    ).toBe(false);
  });
});
