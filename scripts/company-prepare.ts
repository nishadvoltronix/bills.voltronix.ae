import { db } from "../src/lib/db";
import { authenticateAccountOperator } from "../src/lib/services/accounts";
import { prepareOperationalBooksCompany } from "../src/lib/services/operational-company";

async function main() {
  if (
    process.argv.length > 2 ||
    !process.env.ACCOUNT_OPERATOR_EMAIL ||
    !process.env.ACCOUNT_OPERATOR_PASSWORD
  )
    throw new Error(
      "Supply operator configuration through the private environment, without command arguments.",
    );
  const actor = await authenticateAccountOperator(
    process.env.ACCOUNT_OPERATOR_EMAIL,
    process.env.ACCOUNT_OPERATOR_PASSWORD,
  );
  const result = await prepareOperationalBooksCompany(actor, {
    companyName: process.env.COMPANY_SETUP_NAME,
    organizationId: process.env.COMPANY_SETUP_ORGANIZATION_ID,
    reference: process.env.COMPANY_SETUP_REFERENCE,
  });
  console.log(JSON.stringify(result, null, 2));
}
main()
  .catch(() => {
    console.error(
      "Company setup failed. Check the operational runtime, explicit enablement, active administrator, exact company profile and existing assignments. No credentials were printed.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
