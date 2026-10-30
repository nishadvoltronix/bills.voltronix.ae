import { db } from "../src/lib/db";
import { authenticateAccountOperator } from "../src/lib/services/accounts";
import {
  assertBooksSupplierSetupEnvironment,
  importBooksSuppliers,
} from "../src/lib/services/books-supplier-setup";
import { HttpError } from "../src/lib/http";
import { IntegrationError } from "../src/lib/integrations/config";

try {
  assertBooksSupplierSetupEnvironment();
  const selectedIds = process.env.BOOKS_SUPPLIER_IDS_JSON;
  if (process.argv.length !== 2 || !selectedIds || selectedIds.length > 4096)
    throw new Error(
      "Supply bounded explicit supplier IDs through the trusted environment without command arguments.",
    );
  const externalVendorIds: unknown = JSON.parse(selectedIds);
  const actor = await authenticateAccountOperator(
    process.env.ACCOUNT_OPERATOR_EMAIL ?? "",
    process.env.ACCOUNT_OPERATOR_PASSWORD ?? "",
  );
  const result = await importBooksSuppliers(actor, {
    companyId: process.env.BOOKS_COMPANY_ID,
    organizationId: process.env.BOOKS_ORGANIZATION_ID,
    externalVendorIds,
    reference: process.env.BOOKS_SUPPLIER_SETUP_REFERENCE,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // Application errors are fixed strings. Never print provider bodies, tokens or parser details.
  console.error(
    error instanceof IntegrationError || error instanceof HttpError
      ? error.message
      : "Books supplier setup failed. Check the operational runtime, explicit enablement, active Admin/company access, exact supplier IDs and configured currencies. No credentials or provider records were printed.",
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
