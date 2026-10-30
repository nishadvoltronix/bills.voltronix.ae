import { db } from "../src/lib/db";
import {
  administerAccount,
  authenticateAccountOperator,
} from "../src/lib/services/accounts";

async function main() {
  if (process.env.ALLOW_ACCOUNT_ADMINISTRATION !== "true")
    throw new Error(
      "Account administration must be explicitly enabled for this operator invocation.",
    );
  if (
    !process.env.ACCOUNT_OPERATOR_EMAIL ||
    !process.env.ACCOUNT_OPERATOR_PASSWORD
  )
    throw new Error(
      "Supply operator credentials through the trusted environment; never command arguments.",
    );
  const operator = await authenticateAccountOperator(
    process.env.ACCOUNT_OPERATOR_EMAIL,
    process.env.ACCOUNT_OPERATOR_PASSWORD,
  );
  const result = await administerAccount(operator, {
    operation: process.env.ACCOUNT_OPERATION,
    email: process.env.ACCOUNT_EMAIL,
    reason: process.env.ACCOUNT_REASON,
    ...(process.env.ACCOUNT_NEW_PASSWORD
      ? { newPassword: process.env.ACCOUNT_NEW_PASSWORD }
      : {}),
  });
  console.log(
    `Account ${result.operation} completed and audited; ${result.revokedSessions} session(s) revoked. No credentials were logged.`,
  );
}
main()
  .catch(() => {
    console.error(
      "Account operation failed. Check explicit enablement, active administrator credentials, target, reason, operation, and policy; no secrets are logged.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
