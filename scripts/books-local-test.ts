import { db } from "../src/lib/db";
import { authenticateAccountOperator } from "../src/lib/services/accounts";
import { assertLocalBooksTestSetupEnvironment, issueLocalLiveTestAuthorization, prepareLocalLiveTestSupplier } from "../src/lib/integrations/local-live-test";
import { HttpError } from "../src/lib/http";
import { IntegrationError } from "../src/lib/integrations/config";

try {
  assertLocalBooksTestSetupEnvironment();
  const mode = process.argv[2];
  const raw = process.env.BOOKS_LOCAL_TEST_INPUT_JSON;
  if (process.argv.length !== 3 || !["supplier", "authorize"].includes(mode) || !raw || raw.length > 8192)
    throw new Error("Supply one mode and bounded reviewed input in the trusted environment.");
  const payload: unknown = JSON.parse(raw);
  const actor = await authenticateAccountOperator(process.env.ACCOUNT_OPERATOR_EMAIL ?? "", process.env.ACCOUNT_OPERATOR_PASSWORD ?? "");
  const result = mode === "supplier" ? await prepareLocalLiveTestSupplier(actor, payload) : await issueLocalLiveTestAuthorization(actor, payload);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof IntegrationError || error instanceof HttpError ? error.message :
    "Local bill-test setup failed. Check the guarded local runtime, explicit operator enablement, exact reviewed draft and source metadata. No credentials or provider records were printed.");
  process.exitCode = 1;
} finally { await db.$disconnect(); }
