import "server-only";
import type { Actor } from "@/lib/auth";
import { db } from "@/lib/db";
import { HttpError } from "@/lib/http";
import { getConfig, IntegrationError } from "@/lib/integrations/config";
import { crmAuthorizationContext } from "@/lib/integrations/crm-source";
import { callbackUrl, connectionFingerprint } from "@/lib/integrations/oauth";

export async function crmAuthorizationStatus(actor: Actor) {
  if (actor.role !== "ADMIN") throw new HttpError(403, "Only an administrator can manage CRM authorization.");
  const result = {
    connected: false,
    status: "NOT_CONFIGURED" as "CONNECTED" | "AUTHORIZATION_REQUIRED" | "NOT_CONFIGURED" | "BLOCKED",
    message: "CRM authorization is not configured.",
    organizationId: undefined as string | undefined,
    companies: [] as { id: string; name: string }[],
    authorization: { canAuthorize: false, reason: null as string | null, callbackUrl: null as string | null, accountsOrigin: null as string | null, networkEnabled: false },
  };
  try {
    const config = getConfig("CRM");
    const context = await crmAuthorizationContext(actor, config);
    result.organizationId = config.organizationId;
    result.companies = context.companies;
    result.authorization.callbackUrl = callbackUrl("CRM");
    result.authorization.accountsOrigin = config.accountsOrigin;
    result.authorization.networkEnabled = config.networkEnabled;
    if (!config.networkEnabled || !/^[a-fA-F0-9]{64}$/.test(process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY ?? "")) {
      result.status = "BLOCKED";
      result.message = "CRM network access and encrypted token storage must be configured before authorization.";
      result.authorization.reason = result.message;
      return result;
    }
    result.authorization.canAuthorize = true;
    const stored = await db.integrationCredential.findUnique({
      where: { target_organizationId: { target: "CRM", organizationId: config.organizationId } },
      select: { revokedAt: true, connectionFingerprint: true },
    });
    result.connected = Boolean(stored && !stored.revokedAt && stored.connectionFingerprint === connectionFingerprint(config));
    result.status = result.connected ? "CONNECTED" : "AUTHORIZATION_REQUIRED";
    result.message = result.connected
      ? "CRM authorization is saved. Organization, company and current access are verified when looking up each job."
      : "Authorize this application's read-only CRM and Zoho Projects access to look up jobs and their existing project associations.";
    return result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    result.authorization.canAuthorize = false;
    result.message = error instanceof IntegrationError ? error.message : "CRM authorization could not be checked. Try again.";
    result.authorization.reason = result.message;
    return result;
  }
}
