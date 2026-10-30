import { db } from "../src/lib/db";
import { authenticateAccountOperator } from "../src/lib/services/accounts";
import { prepareOperationalCrmSource } from "../src/lib/services/crm-operational-source";

async function main() {
  if (process.argv.length !== 2 || process.env.ALLOW_CRM_OPERATIONAL_SOURCE_SETUP !== "true" ||
      !process.env.ACCOUNT_OPERATOR_EMAIL || !process.env.ACCOUNT_OPERATOR_PASSWORD)
    throw new Error("Supply explicit operator setup through private environment configuration only.");
  const actor = await authenticateAccountOperator(process.env.ACCOUNT_OPERATOR_EMAIL, process.env.ACCOUNT_OPERATOR_PASSWORD);
  console.log(JSON.stringify(await prepareOperationalCrmSource(actor, {
    companyId: process.env.CRM_SETUP_COMPANY_ID,
    booksOrganizationId: process.env.CRM_SETUP_BOOKS_ORGANIZATION_ID,
    crmOrganizationId: process.env.CRM_SETUP_ORGANIZATION_ID,
    reference: process.env.CRM_SETUP_REFERENCE,
  }), null, 2));
}
main().catch(() => {
  console.error("CRM source setup failed. Check operational configuration, explicit identities, active Admin memberships and existing source records. No credentials were printed.");
  process.exitCode = 1;
}).finally(async () => { await db.$disconnect(); });
