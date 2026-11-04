"use client";

import { FileCheck2, Paperclip, Trash2 } from "lucide-react";
import { MAX_INVOICE_ATTACHMENTS, MAX_INVOICE_FILE_BYTES, MAX_INVOICE_TOTAL_BYTES } from "@/lib/invoice-attachments";
import type { Document } from "./types";
import { Button, Field, Input } from "./ui";
import styles from "./invoice-attachment-picker.module.css";

export type InvoiceFileSelection = {
  id: string;
  file: File;
  status: "pending" | "uploading" | "stored" | "rejected" | "uncertain";
  // Client-only intake choice. Uploading an original does not send this field.
  readingMode?: "ai" | "manual";
  documentId?: string;
  message?: string;
};
const size = (bytes: number) => bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1000))} KB`;
const status = (file: InvoiceFileSelection) => file.status === "stored" ? "Saved to this bill"
  : file.status === "uploading" ? "Uploading…" : file.status === "rejected" ? "Upload rejected"
    : file.status === "uncertain" ? "Upload needs verification; retry this original" : "Ready to upload";

export function InvoiceAttachmentPicker({ files, existing = [], busy, checking = false, locked = false, readOnly = false, onFiles, onRemove, id = "invoice-file",
  label = "Attach files", inputLabel = "Invoice attachment", selectedLabel = "Selected invoice attachments", helpText, sharedLimits = false }: {
  files: InvoiceFileSelection[];
  existing?: Document[];
  busy: boolean;
  checking?: boolean;
  locked?: boolean;
  readOnly?: boolean;
  onFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
  id?: string;
  label?: string;
  inputLabel?: string;
  selectedLabel?: string;
  helpText?: string;
  sharedLimits?: boolean;
}) {
  return <div className={`books-attachment ${styles.picker}`}>
    {!readOnly && <Field label={label} htmlFor={id}
      hint={`PDF, JPEG or PNG · Up to ${MAX_INVOICE_ATTACHMENTS} originals · ${size(MAX_INVOICE_TOTAL_BYTES)} total${sharedLimits ? " across both attachment boxes" : ""}, ${size(MAX_INVOICE_FILE_BYTES)} per file`}>
      <Input id={id} aria-label={inputLabel} type="file" multiple accept="application/pdf,image/jpeg,image/png"
        disabled={busy || checking || locked} onChange={event => {
          const selected = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (selected.length) onFiles(selected);
        }} />
    </Field>}
    <p className={styles.hint}><Paperclip size={14} />{readOnly ? "Existing originals are retained when this bill is edited."
      : checking ? "Checking selected originals…" : helpText ?? "Select several files together, or add more files before saving."}</p>
    {existing.length > 0 && <ul className={styles.files} aria-label="Stored invoice attachments">
      {existing.map(document => <li key={document.id}>
        <FileCheck2 size={18} /><div className={styles.description}>
          <a href={`/api/documents/${encodeURIComponent(document.id)}`} target="_blank" rel="noopener noreferrer">{document.fileName ?? document.originalName ?? "Stored original"}</a>
          <span>Already saved{document.byteSize ? ` · ${size(document.byteSize)}` : ""}</span>
        </div>
      </li>)}
    </ul>}
    {files.length > 0 && <ul className={styles.files} aria-label={selectedLabel} aria-live="polite">
      {files.map(file => <li key={file.id} role="group" aria-label={`Attachment ${file.file.name}`}>
        <Paperclip size={18} /><div className={styles.description}>
          <strong>{file.file.name}</strong><span>{size(file.file.size)} · {status(file)}</span>
          {file.message && <span className="text-danger">{file.message}</span>}
        </div>
        {file.status !== "stored" && <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${file.file.name}`}
          disabled={busy || checking || locked || file.status === "uncertain" || file.status === "uploading"} onClick={() => onRemove(file.id)}><Trash2 size={16} /></Button>}
      </li>)}
    </ul>}
    {locked && <p className={styles.hint}>The previous upload response was uncertain. Keep these original files and retry the saved bill to verify them before changing the selection.</p>}
    {!readOnly && files.length + existing.length > 1 && <p className={styles.hint}>Each original stays in this workspace. Zoho Books receives one combined PDF when several originals are attached.</p>}
  </div>;
}
