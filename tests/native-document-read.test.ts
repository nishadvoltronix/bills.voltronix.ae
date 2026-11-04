import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Actor } from "@/lib/auth";

const state = vi.hoisted(() => ({
  user: vi.fn(),
  document: vi.fn(),
  ocrDocument: vi.fn(),
  memberships: vi.fn(),
  afterRead: undefined as (() => void) | undefined,
}));
vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: state.user },
    document: { findUnique: state.document },
    ocrDocument: { findFirst: state.ocrDocument },
    userCompanyMembership: { findMany: state.memberships },
  },
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const bytes = await actual.readFile(...args);
      state.afterRead?.();
      return bytes;
    },
  };
});
import { downloadDocument } from "@/lib/services/documents";
import { downloadOcrDocument } from "@/lib/services/ocr";

const actor: Actor = {
  id: "fictional-reader",
  name: "Fictional reader",
  email: "reader@example.invalid",
  role: "DATA_ENTRY",
};
const bytes = Buffer.from("%PDF-1.7\nfictional native document\n%%EOF");
const storageKey = `${randomUUID()}.pdf`;
const document = {
  id: "fictional-document",
  billId: "fictional-bill",
  storageKey,
  fileName: "Fictional invoice.pdf",
  mimeType: "application/pdf",
  byteSize: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bill: { companyId: "fictional-company", createdById: actor.id },
};
const ocrDocument = {
  ...document,
  batchId: "fictional-batch",
  batch: { companyId: document.bill.companyId, createdById: actor.id },
  scannerImports: [],
};
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "native-document-reader-"));
  await writeFile(path.join(directory, storageKey), bytes);
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("UPLOAD_DIR", directory);
  state.afterRead = undefined;
  state.user.mockResolvedValue({ active: true, role: actor.role });
  state.document.mockImplementation(async () => structuredClone(document));
  state.ocrDocument.mockImplementation(async ({ where }) =>
    where.batch.companyId.in.includes(ocrDocument.batch.companyId)
      ? structuredClone(ocrDocument) : null,
  );
  state.memberships.mockResolvedValue([{ companyId: document.bill.companyId }]);
});

describe("OCR original read authorization and identity", () => {
  it("keeps Admin access to posted originals without an empty bill-relation filter", async () => {
    const administrator = { ...actor, role: "ADMIN" as const };
    state.user.mockResolvedValue({ active: true, role: "ADMIN" });
    await expect(downloadOcrDocument(administrator, ocrDocument.id)).resolves.toEqual({
      bytes, fileName: ocrDocument.fileName, mimeType: ocrDocument.mimeType,
    });
    expect(state.ocrDocument).toHaveBeenCalledTimes(2);
    for (const [query] of state.ocrDocument.mock.calls) {
      expect(query.where).toEqual({ id: ocrDocument.id, batch: { companyId: { in: [document.bill.companyId] } } });
    }
  });

  it("checks both the OCR uploader and linked native bill owner before and after file access", async () => {
    await expect(downloadOcrDocument(actor, ocrDocument.id)).resolves.toMatchObject({ bytes });
    expect(state.ocrDocument).toHaveBeenCalledTimes(2);
    for (const [query] of state.ocrDocument.mock.calls) {
      expect(query.where).toEqual({ id: ocrDocument.id,
        batch: { companyId: { in: [document.bill.companyId] }, createdById: actor.id },
        OR: [{ billId: null }, { bill: { createdById: actor.id } }],
      });
    }
  });

  it.each([
    ["deactivated actor", 403, () => state.user.mockResolvedValue({ active: false, role: actor.role })],
    ["changed role", 403, () => state.user.mockResolvedValue({ active: true, role: "ADMIN" })],
    ["revoked company", 404, () => state.memberships.mockResolvedValue([])],
    ["changed bill owner", 404, () => state.ocrDocument.mockResolvedValue(null)],
    ["removed original", 404, () => state.ocrDocument.mockResolvedValue(null)],
  ] as const)("does not release OCR bytes after %s during disk I/O", async (_reason, status, revoke) => {
    state.afterRead = revoke;
    await expect(downloadOcrDocument(actor, ocrDocument.id)).rejects.toMatchObject({ status });
  });

  it.each([
    ["batchId", "another-batch"], ["billId", "another-bill"],
    ["storageKey", `${randomUUID()}.pdf`], ["sha256", "f".repeat(64)],
    ["byteSize", bytes.length + 1], ["mimeType", "image/png"], ["fileName", "Replacement.pdf"],
  ])("rejects OCR %s changed while its old file was read", async (field, value) => {
    state.afterRead = () => state.ocrDocument.mockResolvedValue({ ...ocrDocument, [field]: value });
    await expect(downloadOcrDocument(actor, ocrDocument.id)).rejects.toMatchObject({ status: 409 });
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  // Only the exact fixture file and its empty temporary directory are removed.
  await unlink(path.join(directory, storageKey));
  await rmdir(directory);
});

describe("native original read authorization and identity", () => {
  it("returns the integrity-checked original after checking current actor and company access again", async () => {
    let bytesRead = false;
    const checked = { before: { actor: false, company: false }, after: { actor: false, company: false } };
    state.afterRead = () => { bytesRead = true; };
    state.user.mockImplementation(async () => {
      checked[bytesRead ? "after" : "before"].actor = true;
      return { active: true, role: actor.role };
    });
    state.memberships.mockImplementation(async () => {
      checked[bytesRead ? "after" : "before"].company = true;
      return [{ companyId: document.bill.companyId }];
    });
    const result = await downloadDocument(actor, document.id);
    expect(result).toEqual({
      bytes,
      fileName: document.fileName,
      mimeType: document.mimeType,
    });
    expect(checked).toEqual({ before: { actor: true, company: true }, after: { actor: true, company: true } });
    expect(state.user).toHaveBeenCalledWith({ where: { id: actor.id }, select: { active: true, role: true } });
    expect(state.memberships).toHaveBeenCalledWith({ where: { userId: actor.id, active: true, user: { active: true }, company: { active: true } }, select: { companyId: true } });
    expect(state.document).toHaveBeenCalledTimes(2);
  });

  it("rejects a stored MIME that differs from the actual original bytes", async () => {
    state.document.mockResolvedValue({ ...document, mimeType: "image/png" });
    await expect(downloadDocument(actor, document.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it.each([
    ["deactivation", { active: false, role: actor.role }],
    ["role change", { active: true, role: "MANAGEMENT" }],
  ])(
    "does not release bytes after %s during disk I/O",
    async (_reason, current) => {
      state.afterRead = () => {
        state.user.mockResolvedValue(current);
      };
      await expect(downloadDocument(actor, document.id)).rejects.toMatchObject({
        status: 403,
      });
    },
  );

  it("does not release bytes after company membership is revoked during disk I/O", async () => {
    state.afterRead = () => {
      state.memberships.mockResolvedValue([]);
    };
    await expect(downloadDocument(actor, document.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it.each(["DATA_ENTRY", "ACCOUNTS", "MANAGEMENT"] as const)("checks the current bill creator before releasing bytes to %s", async role => {
    const reader = { ...actor, role };
    state.user.mockResolvedValue({ active: true, role });
    state.afterRead = () => {
      state.document.mockResolvedValue({
        ...document,
        bill: { ...document.bill, createdById: "another-reader" },
      });
    };
    await expect(downloadDocument(reader, document.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("checks the current bill company before releasing bytes", async () => {
    state.afterRead = () => {
      state.document.mockResolvedValue({
        ...document,
        bill: { ...document.bill, companyId: "another-company" },
      });
    };
    await expect(downloadDocument(actor, document.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it.each([
    ["billId", "another-bill"],
    ["storageKey", `${randomUUID()}.pdf`],
    ["sha256", "f".repeat(64)],
    ["byteSize", bytes.length + 1],
    ["mimeType", "image/png"],
    ["fileName", "Replacement.pdf"],
  ])(
    "rejects a changed %s after reading the earlier file",
    async (field, value) => {
      state.afterRead = () => {
        state.document.mockResolvedValue({ ...document, [field]: value });
      };
      await expect(downloadDocument(actor, document.id)).rejects.toMatchObject({
        status: 409,
      });
    },
  );

  it("does not release an original removed during disk I/O", async () => {
    state.afterRead = () => {
      state.document.mockResolvedValue(null);
    };
    await expect(downloadDocument(actor, document.id)).rejects.toMatchObject({
      status: 404,
    });
  });
});
