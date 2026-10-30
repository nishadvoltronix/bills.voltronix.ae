"use client";

import { Download, ExternalLink } from "lucide-react";
import type { Bill, ImportedBillSummary } from "./types";
import { Button } from "./ui";
import styles from "./bill-history-documents.module.css";

type HistoryDocument = { id: string; name: string; openHref: string | null; downloadHref: string | null };

function HistoryDocuments({ invoiceNumber, documents, emptyMessage }: {
  invoiceNumber: string; documents: HistoryDocument[]; emptyMessage: string;
}) {
  return <div className={styles.files} aria-label={`Attachments for ${invoiceNumber}`}>
    {documents.length ? <ul>{documents.map(document => <li key={document.id}>
      <span className={styles.name}>{document.name}</span>
      {document.openHref && document.downloadHref ? <div className={styles.actions}>
        <Button asChild size="sm" variant="secondary"><a href={document.openHref} target="_blank" rel="noopener noreferrer"
          aria-label={`Open ${document.name} for ${invoiceNumber}`}><ExternalLink size={13} />Open</a></Button>
        <Button asChild size="sm" variant="secondary"><a href={document.downloadHref}
          aria-label={`Download ${document.name} for ${invoiceNumber}`}><Download size={13} />Download</a></Button>
      </div> : <span className={styles.pending}>Not downloaded yet</span>}
    </li>)}</ul> : <span className={styles.pending}>{emptyMessage}</span>}
  </div>;
}

export function NativeBillDocuments({ bill }: { bill: Bill }) {
  const documents = bill.documents ?? bill.attachments;
  return <HistoryDocuments invoiceNumber={bill.invoiceNumber} documents={(documents ?? []).map(document => {
    const href = `/api/documents/${encodeURIComponent(document.id)}`;
    return { id: document.id, name: document.fileName || document.originalName || document.filename || "Invoice document",
      openHref: `${href}?preview=1`, downloadHref: href };
  })} emptyMessage={documents ? "No files attached" : "Attachment details unavailable"} />;
}

export function ImportedBillDocuments({ bill }: { bill: ImportedBillSummary }) {
  const pending = bill.hasAttachment || bill.attachmentStatus === "PENDING" || bill.attachmentStatus === "PARTIAL";
  return <HistoryDocuments invoiceNumber={bill.billNumber} documents={(bill.documents ?? []).map((document, index) => {
    const href = document.downloaded && document.attachmentId
      ? `/api/bills/books/${encodeURIComponent(bill.id)}/attachments/${encodeURIComponent(document.attachmentId)}` : null;
    return { id: document.attachmentId || document.id || `pending-${index}`, name: document.fileName || document.name || "Unnamed Zoho document",
      openHref: href, downloadHref: href ? `${href}?download=1` : null };
  })} emptyMessage={pending ? "Original files pending download" : bill.documents ? "No original files reported" : "Attachment details unavailable"} />;
}
