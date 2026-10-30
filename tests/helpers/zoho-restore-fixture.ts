import { getConfig } from "@/lib/integrations/config";
import { connectionFingerprint } from "@/lib/integrations/connection-fingerprint";
import { zohoDataTransferFixture, transferFixtureMapping } from "./zoho-data-transfer-fixture";

export const restoreFixtureEnvironment = {
  INTEGRATION_NETWORK_ENABLED: "false", ZOHO_BOOKS_NETWORK_ENABLED: "false", ZOHO_CRM_NETWORK_ENABLED: "false",
  ZOHO_BOOKS_WRITE_ENABLED: "false", ZOHO_BOOKS_LIVE_ENABLED: "false", ALLOW_PRODUCTION_ACCOUNTING_WRITES: "false",
  INCOMING_SYNC_ENABLED: "false", INCOMING_SYNC_NOT_BEFORE_JSON: "", INTEGRATION_TEST_MODE: "false", MANUAL_ENTRY_ONLY: "false",
  ZOHO_BOOKS_DC: "US", ZOHO_BOOKS_ENVIRONMENT: "production", ZOHO_BOOKS_CLIENT_ID: "fictional-restore-books",
  ZOHO_BOOKS_CLIENT_SECRET: "fictional-restore-books-secret", ZOHO_BOOKS_ORGANIZATIONS_JSON: JSON.stringify([
    { organizationId: "11", name: "Operating Company One" }, { organizationId: "12", name: "Operating Company Two" }]),
  ZOHO_CRM_DC: "US", ZOHO_CRM_ENVIRONMENT: "production", ZOHO_CRM_ORGANIZATION_ID: "31",
  ZOHO_CRM_CLIENT_ID: "fictional-restore-crm", ZOHO_CRM_CLIENT_SECRET: "fictional-restore-crm-secret",
  ZOHO_CRM_MAPPING_JSON: JSON.stringify(transferFixtureMapping),
};
export function restoreFixture() {
  const manifest = zohoDataTransferFixture();
  manifest.cooldowns[0].notBefore = new Date(Date.now() + 86_400_000).toISOString();
  for (const credential of manifest.sourceCredentials) credential.connectionFingerprint = connectionFingerprint(
    getConfig(credential.target, process.env, credential.organizationId));
  return manifest;
}
