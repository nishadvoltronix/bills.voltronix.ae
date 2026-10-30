import "server-only";

/** Runtime switch for deployments that only record bills in the local ledger. */
export function isManualEntryOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MANUAL_ENTRY_ONLY === "true";
}

/** OCR navigation is independent of typed-bill synchronization. */
export function isOcrWorkspaceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isManualEntryOnly(env) && (
    env.OCR_PROVIDER === "azure_document_intelligence" || env.SCANNER_IMPORT_ENABLED === "true"
  );
}
