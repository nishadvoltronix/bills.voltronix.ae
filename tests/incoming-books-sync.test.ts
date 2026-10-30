import { describe, expect, it, vi } from "vitest";
import type { BooksBill, Prisma } from "@prisma/client";
vi.mock("@/lib/db", () => ({ db: {} }));
import {
  booksBillNeedsDetail,
  booksModifiedAfter,
} from "@/lib/services/incoming-books-sync";

const summary = {
  bill_id: "101",
  bill_number: "A-101",
  total: "105.00",
  balance: "105.00",
  status: "open",
  last_modified_time: "2026-10-29T10:00:00+0400",
  due_days: "1 day",
};
const current = {
  sourceSummary: summary,
  sourceDetail: { total: "105.00" },
  sourceModifiedAt: summary.last_modified_time,
  lastImportRunId: "run",
  detailImportRunId: "run",
  isStale: false,
} as Pick<
  BooksBill,
  | "sourceSummary"
  | "sourceDetail"
  | "sourceModifiedAt"
  | "lastImportRunId"
  | "detailImportRunId"
  | "isStale"
>;
describe("Books incremental request planning", () => {
  it("overlaps a successful watermark and formats an explicit UTC offset", () => {
    expect(booksModifiedAfter("2026-10-29T10:00:00+0400")).toBe(
      "2026-10-29T05:55:00+0000",
    );
    expect(() => booksModifiedAfter("bad")).toThrow();
  });
  it("fetches new, changed, stale and incomplete bill details", () => {
    expect(booksBillNeedsDetail(null, summary)).toBe(true);
    expect(booksBillNeedsDetail({ ...current, isStale: true }, summary)).toBe(
      true,
    );
    expect(
      booksBillNeedsDetail({ ...current, detailImportRunId: "old" }, summary),
    ).toBe(true);
    for (const extra of [
      { status: "paid" },
      { balance: "0" },
      { last_modified_time: "2026-10-29T10:01:00+0400" },
      { has_attachment: true },
    ])
      expect(
        booksBillNeedsDetail(current, {
          ...summary,
          ...extra,
        } as Prisma.InputJsonObject),
      ).toBe(true);
  });
  it("does not spend requests on unchanged detail or dynamic due-day labels", () => {
    expect(booksBillNeedsDetail(current, summary)).toBe(false);
    expect(
      booksBillNeedsDetail(current, { ...summary, due_days: "2 days" }),
    ).toBe(false);
  });
  it("preserves a newer existing source version and distrusts missing modification times", () => {
    expect(
      booksBillNeedsDetail(current, {
        ...summary,
        status: "draft",
        last_modified_time: "2026-10-28T10:00:00+0400",
      }),
    ).toBe(false);
    expect(
      booksBillNeedsDetail(current, { ...summary, last_modified_time: "" }),
    ).toBe(true);
  });
});
