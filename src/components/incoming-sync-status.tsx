"use client";

import { useEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";
import type { IncomingSyncSourceStatus, IncomingSyncStatus } from "@/lib/incoming-sync-types";
import { useApi } from "./api";
import { Badge, Button, Card, Notice } from "./ui";
import styles from "./incoming-sync-status.module.css";

const sourceStates = {
  PENDING: { label: "Check pending", tone: "neutral" },
  RUNNING: { label: "Checking Zoho", tone: "info" },
  IDLE: { label: "Scheduled", tone: "neutral" },
  RETRY: { label: "Retry scheduled", tone: "warning" },
  WAITING_QUOTA: { label: "Waiting for Zoho quota", tone: "warning" },
  BLOCKED: { label: "Needs attention", tone: "danger" },
  DISABLED: { label: "Automatic checks off", tone: "neutral" },
} as const;

const statusClock = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
  timeZone: "Asia/Dubai", hour12: false,
});
function statusTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : statusClock.format(date);
}

function nextCheck(source: IncomingSyncSourceStatus) {
  if (source.status === "DISABLED") return "Automatic checks off";
  if (source.status === "BLOCKED") return "After the issue is resolved";
  if (source.status === "RUNNING") return "After the current check";
  const time = [source.backoffUntil, source.nextRunAt].filter((value): value is string => value !== null)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  if (time) return `${statusTime(time)} Dubai`;
  return "Not scheduled";
}

type IncomingSyncProps = {
  companyId?: string;
  onUpdated?: () => void;
};

function useIncomingSync({ companyId = "", onUpdated }: IncomingSyncProps) {
  const query = companyId ? `?${new URLSearchParams({ companyId })}` : "";
  const state = useApi<IncomingSyncStatus>(`/api/integrations/incoming-status${query}`, { keepPreviousData: true });
  const { reload } = state;
  const previousSuccess = useRef<{ companyId: string; fingerprint: string } | null>(null);
  const fingerprint = state.data ? JSON.stringify(state.data.sources
    .filter(source => source.lastSuccessAt !== null)
    .map(source => [source.id, source.lastSuccessAt]).sort((a, b) => a[0]!.localeCompare(b[0]!))) : null;

  useEffect(() => {
    const refreshVisible = () => { if (document.visibilityState === "visible") reload(); };
    const timer = window.setInterval(refreshVisible, 5_000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [reload]);

  useEffect(() => {
    if (fingerprint === null) {
      previousSuccess.current = null;
      return;
    }
    const previous = previousSuccess.current;
    previousSuccess.current = { companyId, fingerprint };
    if (previous?.companyId === companyId && previous.fingerprint !== fingerprint) onUpdated?.();
  }, [companyId, fingerprint, onUpdated]);

  return state;
}

export function IncomingSyncRefresh(props: IncomingSyncProps) {
  useIncomingSync(props);
  return null;
}

export function IncomingSyncStatusPanel(props: IncomingSyncProps) {
  const state = useIncomingSync(props);
  const { reload } = state;
  const data = state.data;
  const delayed = data?.sources.filter(source => ["RETRY", "WAITING_QUOTA", "BLOCKED"].includes(source.status)).length;
  const stale = data?.sources.filter(source => source.isStale).length;
  return <Card className={styles.panel} aria-label="Incoming Zoho updates">
    <div className={styles.heading}>
      <div>
        <h2>Incoming Zoho updates</h2>
        <p>Automatic checks for bills and jobs in your accessible sources.</p>
      </div>
      <Button variant="ghost" size="sm" onClick={reload} disabled={state.loading || state.refreshing}>
        <RefreshCw size={14} /> {state.refreshing ? "Refreshing status…" : "Refresh status"}
      </Button>
    </div>
    {state.error ? <Notice tone="error">Incoming update status is unavailable. {state.error}</Notice> :
      !data ? <p role="status">Loading saved synchronization status…</p> : <>
        <div className={styles.overview}>
          <Badge tone={state.refreshError ? "warning" : !data.enabled ? "neutral" : data.workerAlive ? "info" : "warning"}>
            {state.refreshError ? "Status refresh failed" : !data.enabled ? "Automatic updates off" : data.workerAlive ? "Automatic checks active" : "Worker not reporting"}
          </Badge>
          {Boolean(delayed) && <span>{delayed} {delayed === 1 ? "source needs" : "sources need"} attention</span>}
          {Boolean(stale) && <span>{stale} {stale === 1 ? "source is" : "sources are"} stale</span>}
        </div>
        {state.refreshError && <Notice tone="error">Status refresh failed. Showing the last saved status; current progress is unconfirmed.</Notice>}
        {data.enabled && !data.workerAlive && <p className={styles.warning}>
          Automatic checks are not confirmed as running. {data.lastHeartbeatAt
            ? `Last worker signal: ${statusTime(data.lastHeartbeatAt)} Dubai.` : "No worker signal has been recorded."}
        </p>}
        {data.sources.length ? <details className={styles.details}>
          <summary>Source schedules ({data.sources.length})</summary>
          <div className={styles.sources}>
            {data.sources.map(source => <section className={styles.source} key={source.id}
              aria-label={`${source.companyName} ${source.kind === "BOOKS" ? "Books bills" : "CRM jobs"}`}>
              <div className={styles.sourceHeading}>
                <div><h3>{source.companyName}</h3><p>{source.kind === "BOOKS" ? "Zoho Books bills" : "Zoho CRM jobs"}</p></div>
                <div className={styles.badges}>
                  <Badge tone={sourceStates[source.status].tone}>{sourceStates[source.status].label}</Badge>
                  {source.isStale && <Badge tone="warning">Stale</Badge>}
                </div>
              </div>
              <dl className={styles.times}>
                <div><dt>Last successful automatic check</dt><dd>{source.lastSuccessAt
                  ? `${statusTime(source.lastSuccessAt)} Dubai` : "No successful automatic check yet"}</dd></div>
                <div><dt>Earliest next check</dt><dd>{nextCheck(source)}</dd></div>
              </dl>
              {source.message && <p className={styles.message}>{source.message}</p>}
            </section>)}
          </div>
        </details> : <p>No incoming check status has been recorded for this view.</p>}
        <p className={styles.footnote}>Original-file downloads are tracked separately. A successful bill check does not mean all originals are downloaded.</p>
        <p className={styles.footnote}>Status recorded: {statusTime(data.generatedAt)} Dubai. This view refreshes every 5 seconds while visible.</p>
      </>}
  </Card>;
}
