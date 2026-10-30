"use client";

import { useEffect, useRef, useState } from "react";
import { api, dateTime, errorMessage, money } from "./api";
import { Badge, Button, Notice } from "./ui";

type LivePreview = {
  mode: "production";
  challengeId: string;
  challengeToken: string;
  expiresAt: string;
  bill: {
    id: string;
    invoiceNumber: string;
    sourceVersion: number;
    currency: string;
    total: string;
    vendorName: string;
    jobNumber: string;
  };
  destination: {
    companyId: string;
    companyName: string;
    organizationId: string;
    organizationName: string;
    dataCenter: string;
    environment: "production";
  };
  documents: { id: string; fileName: string; sha256: string }[];
  payloadHash: string;
};

/** Key this component by the current bill version and destination. Challenges stay in memory only. */
export function LiveBooksSync({
  billId,
  sourceVersion,
  companyId,
  organizationId,
  dataCenter,
  writeEnabled,
  busy,
  onBusyChange,
  onStart,
  onError,
  onQueued,
}: {
  billId: string;
  sourceVersion: number;
  companyId: string;
  organizationId: string;
  dataCenter?: string;
  writeEnabled: boolean;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onStart: () => void;
  onError: (message: string) => void;
  onQueued: () => void;
}) {
  const [preview, setPreview] = useState<LivePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [expired, setExpired] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      controller.current?.abort();
      onBusyChange(false);
    };
  }, [onBusyChange]);

  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(
      () => {
        setPreview(null);
        setConfirmed(false);
        setExpired(true);
      },
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [preview]);

  async function prepare() {
    if (busy || !writeEnabled) return;
    setPreview(null);
    setConfirmed(false);
    setExpired(false);
    onStart();
    onBusyChange(true);
    const request = new AbortController();
    controller.current = request;
    try {
      const { preview: result } = await api<{ preview: LivePreview }>(
        `/api/bills/${billId}/sync/preview`,
        {
          method: "POST",
          body: JSON.stringify({ organizationId }),
          signal: request.signal,
        },
      );
      if (request.signal.aborted) return;
      if (
        result.mode !== "production" ||
        result.bill.id !== billId ||
        result.bill.sourceVersion !== sourceVersion ||
        result.destination.companyId !== companyId ||
        result.destination.organizationId !== organizationId ||
        result.destination.environment !== "production" ||
        (dataCenter && result.destination.dataCenter !== dataCenter) ||
        !Number.isFinite(Date.parse(result.expiresAt)) ||
        Date.parse(result.expiresAt) <= Date.now()
      )
        throw new Error(
          "This bill or destination changed. Refresh the bill and request a new preview.",
        );
      setPreview(result);
    } catch (error) {
      if (!request.signal.aborted) onError(errorMessage(error));
    } finally {
      if (!request.signal.aborted) onBusyChange(false);
    }
  }

  async function confirm() {
    if (busy || !writeEnabled || !preview || !confirmed) return;
    if (Date.parse(preview.expiresAt) <= Date.now()) {
      setPreview(null);
      setConfirmed(false);
      setExpired(true);
      return;
    }
    onStart();
    onBusyChange(true);
    const request = new AbortController();
    controller.current = request;
    try {
      await api(`/api/bills/${billId}/sync`, {
        method: "POST",
        body: JSON.stringify({
          target: "ZOHO",
          organizationId,
          confirmation: {
            challengeId: preview.challengeId,
            challengeToken: preview.challengeToken,
          },
        }),
        signal: request.signal,
      });
      if (!request.signal.aborted) onQueued();
    } catch (error) {
      if (!request.signal.aborted) onError(errorMessage(error));
    } finally {
      if (!request.signal.aborted) {
        setPreview(null);
        setConfirmed(false);
        onBusyChange(false);
      }
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        disabled={busy || !writeEnabled}
        onClick={prepare}
      >
        Preview live Zoho Books sync
      </Button>
      {expired && (
        <Notice>
          This preview expired. Request a new preview before confirming.
        </Notice>
      )}
      {preview && (
        <section
          aria-label="Live Books synchronization preview"
          className="form-stack"
        >
          <Badge tone="warning">Live accounting destination</Badge>
          <strong>Review live bill creation</strong>
          <p>Company: {preview.destination.companyName}</p>
          <p>
            Books organization: {preview.destination.organizationName} (
            {preview.destination.organizationId})
          </p>
          <p>Data center: {preview.destination.dataCenter} · Production</p>
          <p>
            Bill: {preview.bill.invoiceNumber} · {preview.bill.vendorName}
          </p>
          <p>Job: {preview.bill.jobNumber}</p>
          <p>Total: {money(preview.bill.total, preview.bill.currency)}</p>
          <div>
            <strong>Attachments included ({preview.documents.length})</strong>
            {preview.documents.length ? (
              <ul>
                {preview.documents.map((document) => (
                  <li key={document.id}>
                    <a
                      href={`/api/documents/${encodeURIComponent(document.id)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-link"
                    >
                      {document.fileName}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No attachments will be sent.</p>
            )}
          </div>
          <p>
            Expires {dateTime(preview.expiresAt)} Dubai. Request a new preview
            if any details need correction.
          </p>
          <p>
            Confirmation queues creation of this bill and these attachments in
            the selected live Books organization. It does not record a payment.
          </p>
          <label className="ocr-confirmation">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I checked the company, Books organization, amount and attachments
            and authorize this live bill creation.
          </label>
          <Button
            disabled={busy || !writeEnabled || !confirmed}
            onClick={confirm}
          >
            Confirm live bill creation
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setPreview(null);
              setConfirmed(false);
            }}
          >
            Cancel preview
          </Button>
        </section>
      )}
    </>
  );
}
