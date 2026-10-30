import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseRestoreExpectedCounts,
  validateRestoreTarget,
  verifyRestoredDatabase,
} from "@/lib/security/restore-verification";
vi.mock("@/lib/db", () => ({ db: {} }));

describe("restore-verification guard", () => {
  it("permits only a separately named disposable loopback restore database", () => {
    expect(
      validateRestoreTarget(
        "mysql://127.0.0.1:3308/bills_restore_drill_20261027",
      ).pathname,
    ).toBe("/bills_restore_drill_20261027");
    for (const target of [
      "mysql://remote.example/bills_restore_test",
      "mysql://127.0.0.1/bills_dev",
      "mysql://127.0.0.1/postgres",
      "mysql://127.0.0.1/bills_production",
      "https://127.0.0.1/bills_restore_test",
      "invalid",
    ])
      expect(() => validateRestoreTarget(target)).toThrow();
  });
});

describe("coordinated source manifest counts", () => {
  const env = {
    RESTORE_EXPECTED_BILLS: "2",
    RESTORE_EXPECTED_DOCUMENTS: "1",
    RESTORE_EXPECTED_BOOKS_BILLS: "4671",
    RESTORE_EXPECTED_BOOKS_ATTACHMENTS: "100",
  };

  it("requires explicit native and Books counts and accepts an explicit empty source", () => {
    expect(parseRestoreExpectedCounts(env)).toEqual({
      bills: 2,
      documents: 1,
      booksBills: 4671,
      booksAttachments: 100,
    });
    expect(
      parseRestoreExpectedCounts(
        Object.fromEntries(Object.keys(env).map((name) => [name, "0"])),
      ),
    ).toEqual({ bills: 0, documents: 0, booksBills: 0, booksAttachments: 0 });
  });

  it.each(Object.keys(env))(
    "does not infer absent source count %s from the restored target",
    (name) => {
      expect(() =>
        parseRestoreExpectedCounts({ ...env, [name]: undefined }),
      ).toThrow();
      expect(() =>
        parseRestoreExpectedCounts({ ...env, [name]: "" }),
      ).toThrow();
    },
  );

  it.each(["-1", "1.5", "NaN", "Infinity", " 0 ", "9007199254740992"])(
    "rejects invalid source count %s",
    (value) => {
      expect(() =>
        parseRestoreExpectedCounts({
          ...env,
          RESTORE_EXPECTED_BOOKS_ATTACHMENTS: value,
        }),
      ).toThrow();
    },
  );
});

describe("restored Books history and original files", () => {
  let directory: string;
  const keys: string[] = [];
  const pdf = Buffer.from(
    "%PDF-1.4\nFictional original restore bytes\n%%EOF\n",
  );
  type FileMetadata = { storageKey: string; sha256: string; byteSize: number };
  const expected = {
    bills: 0,
    documents: 0,
    booksBills: 4671,
    booksAttachments: 1,
  };

  beforeEach(async () => {
    directory = await mkdtemp(
      path.join(os.tmpdir(), "voltronix-books-restore-test-"),
    );
    vi.stubEnv("UPLOAD_DIR", directory);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Provider access is not allowed.");
      }),
    );
  });

  afterEach(async () => {
    expect(fetch).not.toHaveBeenCalled();
    for (const key of keys.splice(0))
      await unlink(path.join(directory, key)).catch(() => undefined);
    await rmdir(directory);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function original(): Promise<FileMetadata> {
    const storageKey = `${randomUUID()}.pdf`;
    keys.push(storageKey);
    await writeFile(path.join(directory, storageKey), pdf);
    return {
      storageKey,
      sha256: createHash("sha256").update(pdf).digest("hex"),
      byteSize: pdf.length,
    };
  }

  function restored(
    attachments: FileMetadata[],
    options: {
      booksBills?: number;
      nativeDocuments?: FileMetadata[];
      invalidLineTotals?: bigint;
    } = {},
  ) {
    return {
      bill: { count: vi.fn().mockResolvedValue(0) },
      document: {
        findMany: vi.fn().mockResolvedValue(options.nativeDocuments ?? []),
      },
      booksBill: {
        count: vi.fn().mockResolvedValue(options.booksBills ?? 4671),
      },
      booksBillAttachment: { findMany: vi.fn().mockResolvedValue(attachments) },
      $queryRaw: vi
        .fn()
        .mockResolvedValue([
          {
            invalidLineTotals: options.invalidLineTotals ?? 0n,
            invalidPaymentTotals: 0n,
            invalidCurrencies: 0n,
          },
        ]),
    } as unknown as PrismaClient;
  }

  it("counts imported history and downloaded originals independently of the native ledger", async () => {
    const metadata = await original();
    const database = restored([metadata], { nativeDocuments: [metadata] });
    const report = await verifyRestoredDatabase(database, {
      ...expected,
      documents: 1,
    });
    expect(report).toMatchObject({
      passed: true,
      bills: 0,
      documents: 1,
      booksBills: 4671,
      downloadedBooksOriginals: 1,
      expectedCountsProvided: true,
      expectedBooksCountsMatch: true,
      expectedCountsMatch: true,
      unreadableOrAlteredDocuments: 0,
      unreadableOrAlteredBooksOriginals: 0,
    });
    const nativeSql = vi.mocked(database.$queryRaw).mock
      .calls[0][0] as TemplateStringsArray;
    expect(nativeSql.join("")).not.toContain("BooksBill");
  });

  it("fails when either imported history or downloaded-original counts differ from the source manifest", async () => {
    const database = restored([await original()]);
    for (const counts of [
      { ...expected, booksBills: 4672 },
      { ...expected, booksAttachments: 2 },
    ]) {
      const report = await verifyRestoredDatabase(database, counts);
      expect(report).toMatchObject({
        passed: false,
        expectedNativeCountsMatch: true,
        expectedBooksCountsMatch: false,
        expectedCountsMatch: false,
      });
    }
  });

  it("does not pass with missing Books expectations even if the restored history is empty", async () => {
    const incomplete = { bills: 0, documents: 0 } as Parameters<
      typeof verifyRestoredDatabase
    >[1];
    expect(
      await verifyRestoredDatabase(restored([], { booksBills: 0 }), incomplete),
    ).toMatchObject({
      passed: false,
      expectedCountsProvided: false,
      expectedCountsMatch: false,
    });
    expect(
      await verifyRestoredDatabase(restored([], { booksBills: 0 }), {
        bills: 0,
        documents: 0,
        booksBills: 0,
        booksAttachments: 0,
      }),
    ).toMatchObject({ passed: true, downloadedBooksOriginals: 0 });
  });

  it("detects altered original bytes even when the file size still matches", async () => {
    const metadata = await original();
    const altered = Buffer.from(pdf);
    altered[altered.length - 2] ^= 1;
    await writeFile(path.join(directory, metadata.storageKey), altered);
    expect(
      await verifyRestoredDatabase(restored([metadata]), expected),
    ).toMatchObject({
      passed: false,
      expectedCountsMatch: true,
      unreadableOrAlteredBooksOriginals: 1,
      unreadableOrAlteredDocuments: 0,
    });
  });

  it("verifies every original's size and detects absent files separately from native documents", async () => {
    const missing = await original();
    const wrongSize = await original();
    await unlink(path.join(directory, missing.storageKey));
    const database = restored([
      missing,
      { ...wrongSize, byteSize: wrongSize.byteSize + 1 },
    ]);
    expect(
      await verifyRestoredDatabase(database, {
        ...expected,
        booksAttachments: 2,
      }),
    ).toMatchObject({
      passed: false,
      downloadedBooksOriginals: 2,
      expectedCountsMatch: true,
      unreadableOrAlteredBooksOriginals: 2,
      unreadableOrAlteredDocuments: 0,
    });
  });

  it("still fails native-ledger integrity checks when restored Books history is valid", async () => {
    expect(
      await verifyRestoredDatabase(
        restored([await original()], { invalidLineTotals: 1n }),
        expected,
      ),
    ).toMatchObject({
      passed: false,
      invalidLineTotals: 1,
      unreadableOrAlteredBooksOriginals: 0,
      expectedBooksCountsMatch: true,
    });
  });
});
