import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/http";

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), create: vi.fn(), update: vi.fn(), action: vi.fn(), review: vi.fn(), schedule: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/services/bills", () => ({ createBill: mocks.create, updateBill: mocks.update, actOnBill: mocks.action, getBill: vi.fn(), listBills: vi.fn() }));
vi.mock("@/lib/services/ocr", () => ({ reviewOcrDocument: mocks.review }));
vi.mock("@/lib/integrations/immediate-bill-sync", () => ({ scheduleBillSyncAfterResponse: mocks.schedule }));

import { POST as create } from "@/app/api/bills/route";
import { PATCH as update } from "@/app/api/bills/[id]/route";
import { POST as action } from "@/app/api/bills/[id]/actions/route";
import { POST as review } from "@/app/api/ocr/documents/[id]/review/route";

const origin = "https://billing.example.invalid", actor = { id: "fictional-writer", role: "ACCOUNTS" };
const bill = { id: "fictional-bill", companyId: "fictional-company", version: 4, status: "READY",
  syncRecords: [{ target: "ZOHO", status: "PENDING", organizationId: "88701" }] };
const context = { params: Promise.resolve({ id: bill.id }) };
const paths = [
  { name: "create", service: mocks.create, call: (request: Request) => create(request), method: "POST", status: 201 },
  { name: "finalized edit", service: mocks.update, call: (request: Request) => update(request, context), method: "PATCH", status: 200 },
  { name: "manual submit", service: mocks.action, call: (request: Request) => action(request, context), method: "POST", status: 200 },
  { name: "OCR review submit", service: mocks.review, call: (request: Request) => review(request, context), method: "POST", status: 200 },
];
function request(method: string, body: unknown = { action: "submit", version: 3 }, from = origin) {
  return new Request(`${origin}/api/bills`, { method, headers: { Origin: from, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("APP_URL", origin); mocks.requireUser.mockResolvedValue(actor); });
afterEach(() => vi.unstubAllEnvs());

describe.each(paths)("$name dispatch boundary", entry => {
  it("registers background work only after the durable mutation resolves and preserves its response", async () => {
    let commit!: (saved: typeof bill) => void;
    entry.service.mockReturnValue(new Promise<typeof bill>(resolve => { commit = resolve; }));
    const pending = entry.call(request(entry.method));
    await vi.waitFor(() => expect(entry.service).toHaveBeenCalledTimes(1));
    expect(mocks.schedule).not.toHaveBeenCalled();
    commit(bill);
    const response = await pending;
    expect(response.status).toBe(entry.status);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ bill });
    expect(mocks.schedule).toHaveBeenCalledExactlyOnceWith(actor, bill);
  });
  it("preserves rejected or rolled-back mutations without dispatching", async () => {
    entry.service.mockRejectedValue(new HttpError(409, "The record changed. Refresh and try again."));
    const response = await entry.call(request(entry.method));
    expect(response.status).toBe(409); expect(mocks.schedule).not.toHaveBeenCalled();
  });
  it("rejects expired authentication and cross-origin requests before mutation or dispatch", async () => {
    mocks.requireUser.mockRejectedValue(new HttpError(401, "Please sign in."));
    expect((await entry.call(request(entry.method))).status).toBe(401);
    expect((await entry.call(request(entry.method, {}, "https://untrusted.invalid"))).status).toBe(403);
    expect(entry.service).not.toHaveBeenCalled(); expect(mocks.schedule).not.toHaveBeenCalled();
  });
});

it.each(["recordPayment", "approve", "reject", "cancel"])("does not dispatch for the unrelated bill action %s", async selected => {
  mocks.action.mockResolvedValue(bill);
  expect((await action(request("POST", { action: selected, version: 3 }), context)).status).toBe(200);
  expect(mocks.schedule).not.toHaveBeenCalled();
});

it("keeps a committed successful response when immediate scheduling declines it", async () => {
  mocks.create.mockResolvedValue(bill); mocks.schedule.mockReturnValue(false);
  const response = await create(request("POST"));
  expect(response.status).toBe(201); expect(await response.json()).toEqual({ bill });
});
