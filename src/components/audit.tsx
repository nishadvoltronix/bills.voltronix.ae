"use client";
import Link from "next/link";
import { useState } from "react";
import { Search, ShieldCheck } from "lucide-react";
import { dateTime, useApi } from "./api";
import type { AuditEvent } from "./types";
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Input,
  LoadingPanel,
  PageHeader,
  Table,
} from "./ui";
export function AuditPage() {
  const [q, setQ] = useState("");
  const state = useApi<{ events: AuditEvent[] }>("/api/audit");
  const events = (state.data?.events ?? []).filter((e) =>
    `${e.action} ${e.actor?.name ?? ""} ${e.entityId ?? ""} ${e.billId ?? ""}`
      .toLowerCase()
      .includes(q.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        eyebrow="ACCOUNTABILITY & CONTROL"
        title="Audit trail"
        description="An attributable history of important financial and access changes."
      >
        <Badge tone="success">Read only</Badge>
      </PageHeader>
      <Card>
        <div className="list-toolbar">
          <div className="search-input">
            <Search size={17} />
            <Input
              aria-label="Search loaded audit events"
              placeholder="Search loaded events, actions, or staff…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <ShieldCheck className="muted" size={20} />
        </div>
        {state.error ? (
          <ErrorState message={state.error} retry={state.reload} />
        ) : state.loading ? (
          <LoadingPanel />
        ) : events.length ? (
          <Table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Actor</th>
                <th>Date ? Dubai time</th>
                <th>Record</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Badge>{e.action.toLowerCase().replaceAll("_", " ")}</Badge>
                  </td>
                  <td>{e.actor?.name ?? e.user?.name ?? "System"}</td>
                  <td className="muted">{dateTime(e.createdAt)}</td>
                  <td>
                    {e.billId ? (
                      <Link className="text-link" href={`/bills/${e.billId}`}>
                        View bill →
                      </Link>
                    ) : (
                      <span className="muted">
                        {e.entityType ?? "Workspace"}
                      </span>
                    )}
                  </td>
                  <td>
                    <details className="audit-details">
                      <summary>View details</summary>
                      <pre>
                        {JSON.stringify(
                          e.details ??
                            e.metadata ?? {
                              reason: e.reason ?? "No additional details",
                            },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            title="No matching events"
            description="Recorded changes will appear here with their actor and time."
          />
        )}
      </Card>
      <p className="page-footnote">
        Search applies to the recent events returned by the server. Audit
        entries cannot be edited here.
      </p>
    </>
  );
}
