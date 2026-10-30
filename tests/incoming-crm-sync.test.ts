import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ db: {} }));
import { incomingCrmSince, parseIncomingCrmDeletedPage } from "@/lib/services/incoming-crm-sync";

const deleted = { id: "1001", deleted_time: "2020-01-01T12:00:00+04:00", type: "recycle" };
const page = (data: unknown[], more_records = false) => ({ data, info: { page: 1, count: data.length, more_records } });

describe("incoming CRM cursor boundaries", () => {
  it("keeps a five-minute overlap and preserves null for a complete first inventory", () => {
    expect(incomingCrmSince("2020-01-01T12:00:00+04:00")).toBe("2020-01-01T07:55:00+00:00");
    expect(incomingCrmSince(null)).toBeNull();
    expect(incomingCrmSince("1970-01-01T00:00:01Z")).toBe("1970-01-01T00:00:00+00:00");
    expect(() => incomingCrmSince("not-a-date")).toThrow();
    expect(() => incomingCrmSince("2999-01-01T00:00:00Z")).toThrow();
  });
  it("accepts explicit no-content and preserves provider deletion identity and time", () => {
    expect(parseIncomingCrmDeletedPage(null, 1)).toEqual({ records: [], hasMore: false });
    expect(parseIncomingCrmDeletedPage(page([deleted]), 1)).toEqual({ records: [deleted], hasMore: false });
  });
  it.each([
    [null, 0], [null, 501], [page([deleted]), 2], [page([deleted, deleted]), 1], [page([], true), 1],
    [page([{ ...deleted, id: "../1001" }]), 1], [page([{ ...deleted, deleted_time: "yesterday" }]), 1],
    [page([{ ...deleted, type: "unknown" }]), 1], [{ data: [deleted], info: { count: 0, more_records: false } }, 1],
  ])("rejects malformed, duplicate or incomplete deletion pages %#", (value, ordinal) => {
    expect(() => parseIncomingCrmDeletedPage(value, ordinal as number)).toThrow();
  });
});
