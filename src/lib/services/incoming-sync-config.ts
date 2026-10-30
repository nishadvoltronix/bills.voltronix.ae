import "server-only";

function seconds(value: string | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max)
    throw new Error("Incoming sync interval is outside its supported bounds.");
  return Number(value);
}
export function incomingSyncSettings(env: NodeJS.ProcessEnv = process.env) {
  if (env.INCOMING_SYNC_ENABLED && !["true", "false"].includes(env.INCOMING_SYNC_ENABLED))
    throw new Error("INCOMING_SYNC_ENABLED must be true or false.");
  return {
    enabled: env.INCOMING_SYNC_ENABLED === "true",
    intervalSeconds: seconds(env.INCOMING_SYNC_INTERVAL_SECONDS, 60, 5, 86_400),
    reconcileSeconds: seconds(env.INCOMING_SYNC_RECONCILE_SECONDS, 86_400, 3600, 604_800),
    maxRequests: seconds(env.INCOMING_SYNC_MAX_REQUESTS, 40, 5, 200),
    requestIntervalMs: 1100,
    leaseSeconds: 180,
    attachmentsEnabled: env.INCOMING_SYNC_ATTACHMENTS_ENABLED === "true",
  };
}
