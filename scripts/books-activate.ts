import { db } from "../src/lib/db";
import { authenticateAccountOperator } from "../src/lib/services/accounts";
import { assertBooksVerificationEnvironment } from "../src/lib/services/books-operational-setup";
import { activateBooksPosting } from "../src/lib/services/books-posting-activation";
import { IntegrationError } from "../src/lib/integrations/config";

try {
  assertBooksVerificationEnvironment();
  if (process.argv.length !== 2 || process.env.ALLOW_BOOKS_POSTING_ACTIVATION !== "true") throw new Error("ACTIVATION_NOT_ENABLED");
  const actor = await authenticateAccountOperator(process.env.ACCOUNT_OPERATOR_EMAIL ?? "", process.env.ACCOUNT_OPERATOR_PASSWORD ?? "");
  const report = await activateBooksPosting(actor, process.env.BOOKS_ACTIVATION_REFERENCE ?? "");
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "DESTINATIONS_VERIFIED") process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ status: "REJECTED", code: error instanceof IntegrationError ? error.code : "ACTIVATION_FAILED",
    action: "Use the protected accounting configuration, an active company Admin and an explicit activation reference. No bill is created by this command." }));
  process.exitCode = 1;
} finally { await db.$disconnect(); }
