export type IncomingSyncSourceStatus = {
  id: string;
  kind: "BOOKS" | "CRM";
  companyId: string | null;
  companyName: string;
  status: "PENDING" | "RUNNING" | "IDLE" | "RETRY" | "WAITING_QUOTA" | "BLOCKED" | "DISABLED";
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  backoffUntil: string | null;
  isStale: boolean;
  message: string;
  processedCount: number | null;
};

export type IncomingSyncStatus = {
  generatedAt: string;
  enabled: boolean;
  workerAlive: boolean;
  lastHeartbeatAt: string | null;
  pollIntervalSeconds: number;
  sources: IncomingSyncSourceStatus[];
};
