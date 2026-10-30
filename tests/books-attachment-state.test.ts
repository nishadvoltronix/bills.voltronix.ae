import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lockAttachmentDownloadState, privateAttachmentStateFile, readAttachmentDownloadState, writeAttachmentDownloadState } from "../scripts/lib/books-attachment-state";
import type { AttachmentDownloadState } from "@/lib/services/books-attachment-download";

let directory: string;
beforeAll(async () => { directory = await mkdtemp(path.join(tmpdir(), "books-attachment-state-test-")); });
afterAll(async () => {
  const absolute = path.resolve(directory);
  if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith("books-attachment-state-test-")) throw new Error("Unexpected fixture cleanup path");
  for (const file of await readdir(absolute)) await unlink(path.join(absolute, file));
  await rmdir(absolute);
});
const state: AttachmentDownloadState = { version: 1, scopeHash: "b".repeat(64), startedAt: "2026-10-29T12:00:00Z", updatedAt: "2026-10-29T12:00:00Z", status: "WAITING", providerReads: 100, providerFinancialWrites: 0, expected: 4000, available: 100, pending: 3900, metadataPendingBills: 0, nextResumeAt: "2026-10-29T20:02:01Z", organizations: { "1001": { expected: 4000, available: 100, quota: { limit: 5000, remaining: 13, resetAt: "2026-10-29T20:00:00Z", observedAt: "2026-10-29T12:15:00Z", notBefore: "2026-10-29T20:02:01Z", reason: "DAILY_QUOTA_RESERVED" } } }, failures: [] };

describe("private resumable attachment progress", () => {
  it("atomically round-trips quota state without leaving temporary files", async () => {
    const file = await privateAttachmentStateFile(path.join(directory, "progress.json"));
    expect(await readAttachmentDownloadState(file)).toBeNull();
    await writeAttachmentDownloadState(file, state);
    expect(await readAttachmentDownloadState(file)).toEqual(state);
    await writeAttachmentDownloadState(file, { ...state, providerReads: 101 });
    expect((await readAttachmentDownloadState(file))?.providerReads).toBe(101);
    expect((await readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
  it("refuses a second live owner and releases only its own lock", async () => {
    const file = await privateAttachmentStateFile(path.join(directory, "locked.json"));
    const release = await lockAttachmentDownloadState(file);
    await expect(lockAttachmentDownloadState(file)).rejects.toThrow("already owns");
    await release();
    const next = await lockAttachmentDownloadState(file);
    await next();
  });
  it("rejects malformed progress and any claim of provider financial writes", async () => {
    const file = await privateAttachmentStateFile(path.join(directory, "bad.json"));
    await writeFile(file, JSON.stringify({ ...state, providerFinancialWrites: 1 }));
    await expect(readAttachmentDownloadState(file)).rejects.toThrow();
    await writeFile(file, "{broken");
    await expect(readAttachmentDownloadState(file)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("{broken");
  });
  it.each(["public/attachment-progress.json", ".next/attachment-progress.json", "src/progress.json", "node_modules/progress.json", "package.json", ".env"])("refuses application assets/source paths: %s", async (file) => {
    await expect(privateAttachmentStateFile(file)).rejects.toThrow();
  });
});
