"use client";
import { useEffect, useState } from "react";
import { Building2, LoaderCircle, Plus, Search } from "lucide-react";
import { api, errorMessage, useApi } from "./api";
import type { VendorDirectory } from "./types";
import { useManualEntryOnly, useUser } from "./app-shell";
import { CompanySelect } from "./company-select";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  LoadingPanel,
  Notice,
  PageHeader,
  Select,
  Table,
} from "./ui";
export function VendorsPage() {
  const user = useUser();
  const manualEntryOnly = useManualEntryOnly();
  const [companyId, setCompanyId] = useState("");
  const [q, setQ] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [syncWarning, setSyncWarning] = useState("");
  const [syncingVendor, setSyncingVendor] = useState<string | null>(null);
  const working = busy || syncingVendor !== null;
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(q), 300);
    return () => clearTimeout(timer);
  }, [q]);
  const searchPending = q !== debouncedQuery;
  const state = useApi<VendorDirectory>(companyId && !searchPending
    ? `/api/vendors/directory?${new URLSearchParams({ companyId, q: debouncedQuery.trim(), page: String(page) })}`
    : null);
  const loading = !!companyId && (searchPending || state.loading);
  const response = state.data;
  const wrongScope = response && (
    response.companyId !== companyId || response.page !== page || response.perPage !== 100 ||
    !["books", "local"].includes(response.source) ||
    (response.source === "local" && (response.organizationId !== null || response.dataCenter !== null || response.environment !== null)) ||
    response.vendors.some((vendor) => vendor.companyId !== companyId || (vendor.externalVendorId
      ? response.source !== "books" || vendor.source === "local" || !response.organizationId || !response.dataCenter || !response.environment ||
        vendor.organizationId !== response.organizationId || vendor.dataCenter !== response.dataCenter || vendor.environment !== response.environment ||
        !["active", "inactive"].includes(vendor.status)
      : vendor.source === "books" || !vendor.id || vendor.status !== "local"))
  );
  const directory = !wrongScope ? response : null;
  const directoryError = state.error || (wrongScope
    ? "Vendor results did not match the selected company or Books destination. Retry the directory." : null);
  const canCreate = user.role === "ADMIN" || user.role === "ACCOUNTS";
  function changeCompany(value: string) {
    setCompanyId(value);
    setPage(1);
    setQ("");
    setDebouncedQuery("");
    setError("");
    setSuccess("");
    setSyncWarning("");
  }
  function showSyncResult(sync: { status: string; message: string } | undefined, fallback: string) {
    if (!sync || ["SYNCED", "LOCAL_ONLY"].includes(sync.status)) {
      setSuccess(sync?.status === "SYNCED" ? "Vendor saved and confirmed in Zoho Books." : sync?.message || fallback);
      setSyncWarning("");
    } else {
      setSuccess(""); setSyncWarning(`Vendor saved locally. ${sync.message}`);
    }
  }
  async function syncVendor(vendorId: string) {
    setSyncingVendor(vendorId); setError(""); setSuccess(""); setSyncWarning("");
    try {
      const result = await api<{ sync: { status: string; message: string } }>(`/api/vendors/${encodeURIComponent(vendorId)}/sync`, { method: "POST", body: "{}" });
      if (!result.sync || !["SYNCED", "QUEUED", "PROCESSING", "UNKNOWN", "BLOCKED", "FAILED", "LOCAL_ONLY"].includes(result.sync.status) || !result.sync.message)
        throw new Error("The vendor sync status could not be confirmed. Check its status before retrying.");
      showSyncResult(result.sync, "Vendor sync status checked."); state.reload();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setSyncingVendor(null); }
  }
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await api<{ sync?: { status: string; message: string } }>("/api/vendors", {
        method: "POST",
        body: JSON.stringify({
          companyId: form.get("companyId"),
          name: form.get("name"),
          email: form.get("email") || "",
          trn: form.get("trn") || "",
          currency: form.get("currency"),
        }),
      });
      setAdding(false);
      showSyncResult(result.sync, "Vendor created in this workspace.");
      state.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="SUPPLIER DIRECTORY"
        title="Vendors"
        description="Choose a company to browse its vendor directory."
      >
        {canCreate && (
          <Button type="button" disabled={working} onClick={() => setAdding(!adding)}>
            <Plus size={17} />
            {adding ? "Close form" : "Add vendor"}
          </Button>
        )}
      </PageHeader>
      {success && (
        <Notice tone="success" onClose={() => setSuccess("")}>
          {success}
        </Notice>
      )}
      {error && (
        <Notice tone="error" onClose={() => setError("")}>
          {error}
        </Notice>
      )}
      {syncWarning && <Notice onClose={() => setSyncWarning("")}>{syncWarning}</Notice>}
      {adding && canCreate && (
        <Card className="form-card inline-create">
          <div className="panel-heading compact">
            <h2>Add a workspace vendor</h2>
          </div>
          <form onSubmit={create}>
            <fieldset disabled={working} className="vendor-create-fields">
            <div className="form-grid">
              <CompanySelect id="new-vendor-company" value={companyId} onChange={changeCompany} />
              <Field label="Vendor name" htmlFor="vendor-name" required>
                <Input
                  id="vendor-name"
                  name="name"
                  required
                  maxLength={200}
                  placeholder="Supplier company name"
                />
              </Field>
              <Field label="Email address" htmlFor="vendor-email">
                <Input
                  id="vendor-email"
                  name="email"
                  type="email"
                  maxLength={254}
                  placeholder="accounts@supplier.com"
                />
              </Field>
              <Field label="Tax registration number" htmlFor="vendor-trn" hint="Enter TRN for VAT-registered suppliers">
                <Input
                  id="vendor-trn"
                  name="trn"
                  maxLength={40}
                  placeholder="Optional TRN"
                />
              </Field>
              <Field label="Default currency" htmlFor="vendor-currency">
                <Select id="vendor-currency" name="currency" defaultValue="AED">
                  {["AED", "USD", "EUR", "GBP", "SAR"].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="form-footer">
              <p>{manualEntryOnly ? "Save a supplier for this company's manual bills." : "Saving creates a supplier in this workspace and attempts to link it to Zoho Books. Its confirmed status appears after saving."}</p>
              <Button type="submit" disabled={busy}>
                {busy && <LoaderCircle className="spin" size={16} />}Create
                vendor
              </Button>
            </div>
            </fieldset>
          </form>
        </Card>
      )}
      <Card className="vendor-directory-card">
        <div className="vendor-directory-filters" role="group" aria-label="Vendor directory filters">
          <CompanySelect id="vendor-directory-company" value={companyId} onChange={changeCompany} disabled={working} />
          <div className="search-input">
            <Search size={17} />
            <Input
              aria-label="Search vendors"
              placeholder="Search suppliers…"
              value={q}
              disabled={!companyId || working}
              maxLength={100}
              onChange={(e) => { setQ(e.target.value); setPage(1); }}
            />
          </div>
          {directory && <Badge>{directory.vendors.length} on this page</Badge>}
        </div>
        {directory && <p className="vendor-directory-source">
          {directory.source === "books"
            ? "Source: Zoho Books. Active and inactive vendors are included."
            : manualEntryOnly ? "Source: this workspace." : "Source: this workspace. This company has no configured Books vendor directory."}
          {" "}Up to {directory.perPage} {directory.source === "books" ? "Books vendors, plus local suppliers awaiting a Books link" : "vendors"} per page.
        </p>}
        {!companyId ? (
          <EmptyState title="Select a company to view its vendors" description="Each company has its own vendor directory." />
        ) : loading ? (
          <LoadingPanel />
        ) : directoryError ? (
          <div className="vendor-directory-notice"><Notice tone="error">
            <p>{directoryError}</p>
            <Button type="button" variant="secondary" onClick={state.reload}>Retry vendor directory</Button>
          </Notice></div>
        ) : <>
          {directory?.warning && <div className="vendor-directory-notice"><Notice>
            <p>{directory.warning}</p>
            <Button type="button" variant="secondary" onClick={state.reload}>Retry vendor directory</Button>
          </Notice></div>}
          {directory?.vendors.length ? (
          <Table>
            <caption className="sr-only">Vendor directory</caption>
            <thead>
              <tr>
                <th>Vendor name</th>
                <th>Status</th>
                <th>Source</th>
                <th>Email</th>
                <th>Tax registration number</th>
                <th>Currency</th>
                {canCreate && directory.source === "books" && <th>Books link</th>}
              </tr>
            </thead>
            <tbody>
              {directory.vendors.map((v) => (
                <tr key={v.externalVendorId ? `${v.dataCenter}:${v.environment}:${v.organizationId}:${v.externalVendorId}` : v.id}>
                  <td>
                    <div className="table-primary">
                      <span className="vendor-icon">
                        <Building2 size={18} />
                      </span>
                      {v.name}
                    </div>
                  </td>
                  <td><Badge tone={v.status === "active" ? "success" : v.status === "inactive" ? "warning" : "neutral"}>
                    {v.status === "active" ? "Active" : v.status === "inactive" ? "Inactive" : "Local"}
                  </Badge></td>
                  <td className="muted">{v.externalVendorId ? "Zoho Books" : v.booksMappingRequired ? "Workspace · Books link pending" : "Workspace"}</td>
                  <td className="muted">{v.email || "—"}</td>
                  <td className="muted">{v.trn || "—"}</td>
                  <td>
                    <Badge>{v.currency}</Badge>
                  </td>
                  {canCreate && directory.source === "books" && <td>{v.id && !v.externalVendorId && <Button type="button" variant="secondary" size="sm"
                    disabled={busy || syncingVendor !== null} onClick={() => void syncVendor(v.id!)}>
                    {syncingVendor === v.id ? "Checking sync…" : "Sync vendor / check status"}
                  </Button>}</td>}
                </tr>
              ))}
            </tbody>
          </Table>
        ) : !directory?.warning ? (
          <EmptyState
            title="No vendors found"
            description={
              q
                ? "Try a different supplier name."
                : directory?.source === "books"
                  ? "Zoho Books returned no vendors on this page."
                  : "No local vendors are saved for this company."
            }
          />
        ) : null}
        </>}
        {companyId && <nav className="pagination" aria-label="Vendor directory pages">
          <span>Page {page}</span>
          <div>
            <Button type="button" variant="secondary" size="sm" disabled={working || loading || page <= 1}
              onClick={() => setPage((current) => current - 1)}>Previous page</Button>
            <Button type="button" variant="secondary" size="sm" disabled={working || loading || !directory?.hasMore}
              onClick={() => setPage((current) => current + 1)}>Next page</Button>
          </div>
        </nav>}
      </Card>
    </>
  );
}
