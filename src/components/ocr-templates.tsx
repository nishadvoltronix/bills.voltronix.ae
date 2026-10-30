"use client";
import { useState } from "react";
import { api, errorMessage, useApi } from "./api";
import type { Vendor } from "./types";
import { useUser } from "./app-shell";
import { Badge, Button, Card, Field, Input, Notice, Select } from "./ui";

type VendorTemplate = {
  id: string;
  name: string;
  version: number;
  active: boolean;
  vendorId: string;
};
export function OcrTemplates() {
  const user = useUser();
  const allowed = ["ADMIN", "ACCOUNTS"].includes(user.role);
  const state = useApi<{ templates: VendorTemplate[] }>(
    allowed ? "/api/ocr/templates" : null,
  );
  const vendors = useApi<{ vendors: Vendor[] }>(
    allowed ? "/api/vendors" : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  if (!allowed) return null;
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const mappings = Object.fromEntries(
      ["invoiceNumber", "orderNumber", "jobNumber", "category"]
        .map((key) => [key, data.get(key)])
        .filter(([, value]) => value),
    );
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api("/api/ocr/templates", {
        method: "POST",
        body: JSON.stringify({
          vendorId: data.get("vendorId"),
          name: data.get("name"),
          mappings,
        }),
      });
      form.reset();
      state.reload();
      setSuccess(
        "A new template version was saved. Existing extractions retain their original evidence.",
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="form-card ocr-template-panel">
      <details>
        <summary>Verified vendor templates</summary>
        <p>
          Use a template only after checking the vendor’s invoice format. Each
          update creates a version; every future extraction still requires
          review.
        </p>
        {(error || state.error || vendors.error) && (
          <Notice tone="error">{error || state.error || vendors.error}</Notice>
        )}
        {success && <Notice tone="success">{success}</Notice>}
        <div className="ocr-confidence">
          {state.data?.templates
            .filter((t) => t.active)
            .map((t) => (
              <Badge key={t.id}>
                {vendors.data?.vendors.find((v) => v.id === t.vendorId)?.name ??
                  "Vendor"}
                : {t.name} · v{t.version}
              </Badge>
            ))}
        </div>
        <form onSubmit={save}>
          <div className="report-filter-grid">
            <Field label="Template vendor" htmlFor="template-vendor">
              <Select id="template-vendor" name="vendorId" required>
                <option value="">Select vendor</option>
                {vendors.data?.vendors.map((v) => (
                  <option value={v.id} key={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Template name" htmlFor="template-name">
              <Input
                id="template-name"
                name="name"
                maxLength={120}
                required
                placeholder="Verified invoice format"
              />
            </Field>
            <Field label="Invoice number comes from" htmlFor="template-invoice">
              <Select id="template-invoice" name="invoiceNumber">
                <option value="">Provider default</option>
                <option value="InvoiceId">Invoice number</option>
                <option value="PurchaseOrder">Purchase order reference</option>
              </Select>
            </Field>
            <Field label="Order number comes from" htmlFor="template-order">
              <Select id="template-order" name="orderNumber">
                <option value="">Provider default</option>
                <option value="PurchaseOrder">Purchase order reference</option>
                <option value="CustomerId">Customer reference</option>
              </Select>
            </Field>
            <Field label="Job reference comes from" htmlFor="template-job">
              <Select id="template-job" name="jobNumber">
                <option value="">Provider default</option>
                <option value="PurchaseOrder">Purchase order reference</option>
                <option value="CustomerId">Customer reference</option>
                <option value="ServiceAddressRecipient">
                  Service recipient
                </option>
              </Select>
            </Field>
            <Field
              label="Suggested expense category"
              htmlFor="template-category"
            >
              <Select id="template-category" name="category">
                <option value="">No template default</option>
                {["MATERIALS", "LABOUR", "EQUIPMENT", "TRANSPORT", "OTHER"].map(
                  (v) => (
                    <option key={v}>{v}</option>
                  ),
                )}
              </Select>
            </Field>
          </div>
          <Button
            disabled={busy || vendors.loading || !!vendors.error}
            type="submit"
          >
            {busy ? "Saving…" : "Save verified template version"}
          </Button>
        </form>
      </details>
    </Card>
  );
}
