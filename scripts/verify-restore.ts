import path from "node:path";
import { createDb } from "../src/lib/db";
import {
  validateRestoreTarget,
  verifyRestoredDatabase,
  parseRestoreExpectedCounts,
} from "../src/lib/security/restore-verification";

async function main() {
  if (process.env.ALLOW_RESTORE_VERIFICATION !== "true")
    throw new Error("Explicit restore-verification enablement is required.");
  const target = validateRestoreTarget(process.env.RESTORE_DATABASE_URL ?? "");
  const expected = parseRestoreExpectedCounts(process.env);
  if (
    !process.env.RESTORE_UPLOAD_DIR ||
    !path.isAbsolute(process.env.RESTORE_UPLOAD_DIR)
  )
    throw new Error(
      "Supply an absolute path to the separately restored private document directory.",
    );
  process.env.UPLOAD_DIR = process.env.RESTORE_UPLOAD_DIR;
  const database = createDb(target.toString());
  try {
    const report = await verifyRestoredDatabase(database, expected);
    console.log(
      JSON.stringify(
        {
          ...report,
          scope:
            "Read-only native bill/payment/currency checks, imported Books bill/original counts and private-file SHA-256/byte verification. Books source totals retain provider semantics. This verifies the supplied source manifest, not completeness of provider downloads; restore execution and external provider reconciliation remain separate operator responsibilities.",
        },
        null,
        2,
      ),
    );
    if (!report.passed) process.exitCode = 1;
  } finally {
    await database.$disconnect();
  }
}
main().catch(() => {
  console.error(
    "Restore verification failed. Confirm explicit enablement, disposable loopback target, restored private storage, current schema and all four source-manifest counts: RESTORE_EXPECTED_BILLS, RESTORE_EXPECTED_DOCUMENTS, RESTORE_EXPECTED_BOOKS_BILLS and RESTORE_EXPECTED_BOOKS_ATTACHMENTS. Use explicit zero only when absent from the source manifest. No credentials were logged.",
  );
  process.exitCode = 1;
});
