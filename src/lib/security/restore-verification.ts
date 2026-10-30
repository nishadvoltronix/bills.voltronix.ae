import "server-only";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { readPrivateDocument } from "@/lib/services/documents";

const expectedCount = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative());

/** All counts come from the coordinated source manifest, never the restored target. */
export function parseRestoreExpectedCounts(
  env: Record<string, string | undefined>,
) {
  return z
    .object({
      bills: expectedCount,
      documents: expectedCount,
      booksBills: expectedCount,
      booksAttachments: expectedCount,
    })
    .parse({
      bills: env.RESTORE_EXPECTED_BILLS,
      documents: env.RESTORE_EXPECTED_DOCUMENTS,
      booksBills: env.RESTORE_EXPECTED_BOOKS_BILLS,
      booksAttachments: env.RESTORE_EXPECTED_BOOKS_ATTACHMENTS,
    });
}

type RestoreExpectedCounts = ReturnType<typeof parseRestoreExpectedCounts>;

export function validateRestoreTarget(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(
      "Configure a disposable local restore-verification database.",
    );
  }
  if (
    url.protocol !== "mysql:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/bills_restore_[A-Za-z0-9_]+$/.test(url.pathname) ||
    url.hash ||
    // No URL query options may override the constrained target.
    Boolean(url.search)
  )
    throw new Error(
      "Restore verification is limited to loopback databases named bills_restore_<identifier>; application and remote databases are refused.",
    );
  return url;
}

/** Read-only consistency check. It does not create/restore/drop databases or certify backup completeness. */
export async function verifyRestoredDatabase(
  database: PrismaClient,
  expected: RestoreExpectedCounts,
) {
  const [bills, documents, booksBills, booksOriginals, checks] =
    await Promise.all([
      database.bill.count(),
      database.document.findMany({
        select: { storageKey: true, sha256: true, byteSize: true },
      }),
      database.booksBill.count(),
      database.booksBillAttachment.findMany({
        select: { storageKey: true, sha256: true, byteSize: true },
      }),
      database.$queryRaw<
        Array<{
          invalidLineTotals: bigint;
          invalidPaymentTotals: bigint;
          invalidCurrencies: bigint;
        }>
      >`
      SELECT
        (SELECT COUNT(*) FROM \`Bill\` b WHERE b.\`subtotal\` <> COALESCE((SELECT SUM(l.\`lineTotal\`) FROM \`BillLine\` l WHERE l.\`billId\` = b.\`id\`), 0)) AS \`invalidLineTotals\`,
        (SELECT COUNT(*) FROM \`Bill\` b WHERE b.\`paidAmount\` <> COALESCE((SELECT SUM(p.\`amount\`) FROM \`Payment\` p WHERE p.\`billId\` = b.\`id\`), 0)) AS \`invalidPaymentTotals\`,
        (SELECT COUNT(*) FROM \`Bill\` b JOIN \`Job\` j ON j.\`id\` = b.\`jobId\` JOIN \`Vendor\` v ON v.\`id\` = b.\`vendorId\` WHERE b.\`currency\` <> j.\`currency\` OR b.\`currency\` <> v.\`currency\`) AS \`invalidCurrencies\`
    `,
    ]);
  let unreadableOrAlteredDocuments = 0;
  for (const document of documents) {
    try {
      await readPrivateDocument(document);
    } catch {
      unreadableOrAlteredDocuments++;
    }
  }
  let unreadableOrAlteredBooksOriginals = 0;
  for (const original of booksOriginals) {
    try {
      await readPrivateDocument(original);
    } catch {
      unreadableOrAlteredBooksOriginals++;
    }
  }
  const expectedCountsProvided = [
    expected.bills,
    expected.documents,
    expected.booksBills,
    expected.booksAttachments,
  ].every((count) => Number.isSafeInteger(count) && count >= 0);
  const expectedNativeCountsMatch =
    bills === expected.bills && documents.length === expected.documents;
  const expectedBooksCountsMatch =
    booksBills === expected.booksBills &&
    booksOriginals.length === expected.booksAttachments;
  const report = {
    bills,
    documents: documents.length,
    booksBills,
    downloadedBooksOriginals: booksOriginals.length,
    expectedCountsProvided,
    expectedNativeCountsMatch,
    expectedBooksCountsMatch,
    expectedCountsMatch:
      expectedCountsProvided &&
      expectedNativeCountsMatch &&
      expectedBooksCountsMatch,
    invalidLineTotals: Number(checks[0].invalidLineTotals),
    invalidPaymentTotals: Number(checks[0].invalidPaymentTotals),
    invalidCurrencies: Number(checks[0].invalidCurrencies),
    unreadableOrAlteredDocuments,
    unreadableOrAlteredBooksOriginals,
  };
  return {
    ...report,
    passed:
      report.expectedCountsMatch &&
      !report.invalidLineTotals &&
      !report.invalidPaymentTotals &&
      !report.invalidCurrencies &&
      !unreadableOrAlteredDocuments &&
      !unreadableOrAlteredBooksOriginals,
  };
}
