import { db } from "../src/lib/db";
import { authenticateAccountOperator } from "../src/lib/services/accounts";
import { beginOAuth, callbackUrl } from "../src/lib/integrations/oauth";

async function main() {
  if (
    process.argv.length > 2 ||
    process.env.ALLOW_BOOKS_AUTHORIZATION !== "true" ||
    !process.env.ACCOUNT_OPERATOR_EMAIL ||
    !process.env.ACCOUNT_OPERATOR_PASSWORD ||
    !/^\d{1,30}$/.test(process.env.BOOKS_AUTHORIZATION_ORGANIZATION_ID ?? "")
  )
    throw new Error(
      "Explicit authorization and private operator settings are required.",
    );
  const actor = await authenticateAccountOperator(
    process.env.ACCOUNT_OPERATOR_EMAIL,
    process.env.ACCOUNT_OPERATOR_PASSWORD,
  );
  const organizationId = process.env.BOOKS_AUTHORIZATION_ORGANIZATION_ID!;
  const result = await beginOAuth(actor, "ZOHO", organizationId);
  // This URL is intended for the operator's browser. It contains one-use state,
  // never an access/refresh token or client secret; don't collect it in shared logs.
  console.log(
    JSON.stringify(
      {
        organizationId,
        callbackUrl: callbackUrl("ZOHO"),
        authorizationUrl: result.authorizationUrl,
        expiresInMinutes: 10,
        instruction:
          "Sign in to the application as this same administrator, then open the authorization URL in that browser. Confirm the intended Books account in Zoho. Do not share callback codes or record this URL in shared logs.",
        financialWritesEnabledByThisCommand: false,
      },
      null,
      2,
    ),
  );
}
main()
  .catch(() => {
    console.error(
      "Books authorization could not be prepared. Check explicit enablement, active administrator credentials, exact company assignment, network settings and registered callback. No credentials were printed.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
