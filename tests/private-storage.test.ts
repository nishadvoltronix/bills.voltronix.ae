import { randomUUID } from "node:crypto";
import { rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  deletePrivateDocument,
  readPrivateDocument,
  storePrivateDocument,
} from "@/lib/services/documents";
vi.mock("@/lib/db", () => ({ db: {} }));

const directory = path.resolve(".local", `security-storage-${randomUUID()}`);
const previous = process.env.UPLOAD_DIR;
beforeAll(() => {
  process.env.UPLOAD_DIR = directory;
});
afterAll(async () => {
  if (previous === undefined) delete process.env.UPLOAD_DIR;
  else process.env.UPLOAD_DIR = previous;
  // Only the empty directory created by this test is removed; never recursive.
  await rmdir(directory).catch(() => undefined);
});

describe("shared private document storage", () => {
  it("stores generated keys and permits a verified read without exposing original paths", async () => {
    const stored = await storePrivateDocument(
      new File(["%PDF-1.4\nFictional invoice\n%%EOF"], "../../invoice.pdf", {
        type: "application/pdf",
      }),
    );
    try {
      expect(stored.fileName).toBe("invoice.pdf");
      expect(stored.storageKey).toMatch(/^[a-f0-9-]{36}\.pdf$/);
      expect((await readPrivateDocument(stored)).toString()).toContain(
        "Fictional invoice",
      );
    } finally {
      await deletePrivateDocument(stored.storageKey);
    }
  });
  it("fails integrity verification when stored bytes or metadata change", async () => {
    const stored = await storePrivateDocument(
      new File(["%PDF-1.4\nOriginal"], "original.pdf", {
        type: "application/pdf",
      }),
    );
    try {
      await expect(
        readPrivateDocument({ ...stored, byteSize: 99 }),
      ).rejects.toMatchObject({ status: 409 });
      await writeFile(
        path.join(directory, stored.storageKey),
        "%PDF-1.4\nAltered!",
      );
      await expect(readPrivateDocument(stored)).rejects.toMatchObject({
        status: 409,
      });
    } finally {
      await deletePrivateDocument(stored.storageKey);
    }
  });
  it("refuses traversal and disguised content without creating a stored document", async () => {
    await expect(
      readPrivateDocument({ storageKey: "../../.env", sha256: "invalid" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(deletePrivateDocument("../../.env")).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      storePrivateDocument(
        new File(["%PDF-1.4\nFictional"], "invoice.png", { type: "image/png" }),
      ),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      storePrivateDocument(
        new File(["<svg><script>bad</script></svg>"], "invoice.pdf", {
          type: "application/pdf",
        }),
      ),
    ).rejects.toMatchObject({ status: 415 });
  });
  it("normalizes the download extension to the detected document type", async () => {
    const stored = await storePrivateDocument(
      new File(["%PDF-1.4\nFictional"], "invoice.html", {
        type: "application/pdf",
      }),
    );
    try {
      expect(stored.fileName).toBe("invoice.pdf");
    } finally {
      await deletePrivateDocument(stored.storageKey);
    }
  });
});
