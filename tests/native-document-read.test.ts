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
  memberships: vi.fn(),
  afterRead: undefined as (() => void) | undefined,
}));
vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: state.user },
    document: { findUnique: state.document },
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
  state.memberships.mockResolvedValue([{ companyId: document.bill.companyId }]);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  // Only the exact fixture file and its empty temporary directory are removed.
  await unlink(path.join(directory, storageKey));
  await rmdir(directory);
});

describe("native original read authorization and identity", () => {
  it("returns the integrity-checked original after checking current actor and company access again", async () => {
    const result = await downloadDocument(actor, document.id);
    expect(result).toEqual({
      bytes,
      fileName: document.fileName,
      mimeType: document.mimeType,
    });
    expect(state.user).toHaveBeenCalledTimes(2);
    expect(state.memberships).toHaveBeenCalledTimes(2);
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

  it("checks the current bill creator before releasing bytes to a data-entry reader", async () => {
    state.afterRead = () => {
      state.document.mockResolvedValue({
        ...document,
        bill: { ...document.bill, createdById: "another-reader" },
      });
    };
    await expect(downloadDocument(actor, document.id)).rejects.toMatchObject({
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
