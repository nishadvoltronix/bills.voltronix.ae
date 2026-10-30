import { db } from "../src/lib/db";
import { authenticateAccountOperator } from "../src/lib/services/accounts";
import { prepareManualCompany } from "../src/lib/services/manual-company";

async function main() {
  if (
    process.argv.length > 2 ||
    process.env.ALLOW_MANUAL_COMPANY_SETUP !== "true" ||
    !process.env.ACCOUNT_OPERATOR_EMAIL ||
    !process.env.ACCOUNT_OPERATOR_PASSWORD
  )
    throw new Error(
      "Supply explicit setup enablement and operator configuration through the private environment, without command arguments.",
    );
  const actor = await authenticateAccountOperator(
    process.env.ACCOUNT_OPERATOR_EMAIL,
    process.env.ACCOUNT_OPERATOR_PASSWORD,
  );
  const result = await prepareManualCompany(actor, {
    companyName: process.env.COMPANY_SETUP_NAME,
    reference: process.env.COMPANY_SETUP_REFERENCE,
    ...(process.env.COMPANY_MEMBER_EMAIL
      ? { memberEmail: process.env.COMPANY_MEMBER_EMAIL }
      : {}),
  });
  console.log(JSON.stringify(result, null, 2));
}
main()
  .catch(() => {
    console.error(
      "Manual company setup failed. Check the production runtime, explicit enablement, active administrator, exact company name and existing active member. No credentials were printed.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
