import { db } from "../src/lib/db";
import { authenticateAccountOperator } from "../src/lib/services/accounts";
import { assertLocalBooksConnectionEnvironment } from "../src/lib/services/books-local-connection";
import { prepareLocalCrmSources } from "../src/lib/services/crm-local-connection";

try {
  assertLocalBooksConnectionEnvironment();
  if (process.env.ALLOW_CRM_LOCAL_CONNECTION_SETUP !== "true" || process.argv.length !== 2)
    throw new Error("Explicit local CRM source setup is required.");
  const actor = await authenticateAccountOperator(process.env.ACCOUNT_OPERATOR_EMAIL ?? "", process.env.ACCOUNT_OPERATOR_PASSWORD ?? "");
  console.log(JSON.stringify(await prepareLocalCrmSources(actor), null, 2));
} catch {
  console.error("Local CRM setup failed. Verify the guarded local database, existing company destinations and active Admin credentials. No credentials were printed.");
  process.exitCode = 1;
} finally { await db.$disconnect(); }
