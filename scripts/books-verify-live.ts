import { db } from "../src/lib/db";
import { authenticateAccountOperator } from "../src/lib/services/accounts";
import { assertBooksVerificationEnvironment, verifyOperationalBooksDestination } from "../src/lib/services/books-operational-setup";
import { IntegrationError } from "../src/lib/integrations/config";
import { HttpError } from "../src/lib/http";

try {
  assertBooksVerificationEnvironment();
  if (process.env.ALLOW_BOOKS_OPERATIONAL_VERIFICATION !== "true" || process.argv.length !== 2)
    throw new Error("Explicit operational verification is required.");
  const actor = await authenticateAccountOperator(process.env.ACCOUNT_OPERATOR_EMAIL ?? "", process.env.ACCOUNT_OPERATOR_PASSWORD ?? "");
  console.log(JSON.stringify(await verifyOperationalBooksDestination(actor, {
    companyId: process.env.BOOKS_COMPANY_ID,
    organizationId: process.env.BOOKS_ORGANIZATION_ID,
    organizationName: process.env.BOOKS_ORGANIZATION_NAME,
    reference: process.env.BOOKS_VERIFICATION_REFERENCE,
  }), null, 2));
} catch (error) {
  // Only fixed application errors are printable. Provider bodies and credential-bearing errors are not.
  console.error(error instanceof IntegrationError || error instanceof HttpError ? error.message :
    "Operational Books verification failed. Check production setup, explicit enablement, active Admin access and the exact reviewed company/destination inputs. No credentials were printed.");
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
