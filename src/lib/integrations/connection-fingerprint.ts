import { createHash } from "node:crypto";
import type { ZohoConfig } from "./config";

/** Connection identity only; never return credentials or authorize a request. */
export function connectionFingerprint(config: ZohoConfig) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        config.target,
        config.dataCenter,
        config.organizationId,
        config.environment,
        config.clientId,
        config.clientSecret,
      ]),
    )
    .digest("hex");
}
