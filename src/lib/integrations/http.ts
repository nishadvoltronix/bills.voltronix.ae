import "server-only";
import { handle, HttpError, json } from "@/lib/http";
import { IntegrationError, type Target } from "./config";
export function integrationTarget(value: string): Target {
  if (value === "zoho") return "ZOHO";
  if (value === "crm") return "CRM";
  throw new HttpError(404, "Integration provider not found.");
}
export function integrationHandle(action: () => Promise<Response>) {
  return handle(async () => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof IntegrationError)
        return json(
          { error: error.message, code: error.code },
          error.kind === "RETRY" ? 503 : 409,
        );
      throw error;
    }
  });
}
