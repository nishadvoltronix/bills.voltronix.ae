import { db } from "../src/lib/db";
import { authenticateAccountOperator } from "../src/lib/services/accounts";
import {
  assertLocalBooksConnectionEnvironment,
  prepareLocalBooksConnections,
} from "../src/lib/services/books-local-connection";

try {
  assertLocalBooksConnectionEnvironment();
  if (
    process.env.ALLOW_BOOKS_LOCAL_CONNECTION_SETUP !== "true" ||
    process.argv.length !== 2
  )
    throw new Error("Explicit local connection setup is required.");
  const actor = await authenticateAccountOperator(
    process.env.ACCOUNT_OPERATOR_EMAIL ?? "",
    process.env.ACCOUNT_OPERATOR_PASSWORD ?? "",
  );
  console.log(
    JSON.stringify(await prepareLocalBooksConnections(actor), null, 2),
  );
} catch {
  console.error(
    "Local Books connection preparation failed. Verify the guarded local environment, disabled write modes and active Admin credentials. No credentials were printed.",
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
