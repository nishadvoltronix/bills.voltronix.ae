import { db } from "../src/lib/db";
import { authenticateAccountOperator } from "../src/lib/services/accounts";
import { assertBooksCatalogEnvironment, readBooksAccountingCatalog } from "../src/lib/services/books-accounting-catalog";
import { IntegrationError } from "../src/lib/integrations/config";
import { HttpError } from "../src/lib/http";

try {
  assertBooksCatalogEnvironment();
  if (process.env.ALLOW_BOOKS_CATALOG_READ !== "true" || process.argv.length !== 2)
    throw new Error("Explicit metadata inspection is required.");
  const actor = await authenticateAccountOperator(process.env.ACCOUNT_OPERATOR_EMAIL ?? "", process.env.ACCOUNT_OPERATOR_PASSWORD ?? "");
  console.log(JSON.stringify(await readBooksAccountingCatalog(actor, {
    companyId:process.env.BOOKS_COMPANY_ID, organizationId:process.env.BOOKS_ORGANIZATION_ID,
  }),null,2));
} catch(error) {
  console.error(error instanceof IntegrationError || error instanceof HttpError ? error.message :
    "Books catalog inspection failed. Check explicit enablement, authorized company/destination and active Admin credentials. No provider body or credentials were printed.");
  process.exitCode=1;
} finally { await db.$disconnect(); }
