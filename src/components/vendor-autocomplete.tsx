"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, errorMessage } from "./api";
import type { Vendor, VendorSearchResult, VendorSuggestion } from "./types";
import type { InvoiceAutofillVendorSelection } from "@/lib/manual-bill-autofill-types";
import { Button, Input } from "./ui";

type ExpectedIdentity = { vendorName: string | null; vendorTrn: string | null; currency: string };
type SelectionOrigin = "selection" | "automatic";
export type AutomaticVendorSelection = {
  key: string;
  candidate: InvoiceAutofillVendorSelection;
  expectedIdentity: ExpectedIdentity;
};
type Props = {
  id: string;
  companyId: string;
  value: string;
  initialQuery?: string;
  automaticSelection?: AutomaticVendorSelection | null;
  disabled?: boolean;
  onChange: (vendor: Vendor | null, source: "selection" | "hydration" | "clear" | "automatic", automaticKey?: string) => void;
  onPendingChange: (pending: boolean, automaticKey?: string) => void;
};
function mergePages(previous: VendorSuggestion[], next: VendorSuggestion[]) {
  const rows = [...previous];
  for (const row of next) {
    const index = rows.findIndex(other => row.id && other.id === row.id && other.companyId === row.companyId ||
      row.externalVendorId && row.externalVendorId === other.externalVendorId && row.organizationId === other.organizationId && row.dataCenter === other.dataCenter && row.environment === other.environment);
    if (index < 0) rows.push(row);
    else if (row.externalVendorId || !rows[index].externalVendorId) rows[index] = row;
  }
  return rows;
}

// The parent keys this field by company so changing company also discards its text,
// results and requests, without resetting any other bill fields.
export function VendorAutocomplete({ id, companyId, value, initialQuery = "", automaticSelection = null, disabled, onChange, onPendingChange }: Props) {
  const [text, setText] = useState(initialQuery.slice(0, 100));
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [selected, setSelected] = useState<(Vendor & { booksMappingRequired?: boolean }) | null>(null);
  const [revision, setRevision] = useState(0);
  const [hydrationRevision, setHydrationRevision] = useState(0);
  const [hydrationError, setHydrationError] = useState<{ vendorId: string; message: string } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolutionError, setResolutionError] = useState<{ suggestion: VendorSuggestion; message: string; origin: SelectionOrigin;
    expectedIdentity?: ExpectedIdentity; automaticKey?: string } | null>(null);
  const [search, setSearch] = useState<{ key: string; data?: VendorSearchResult; error?: string } | null>(null);
  const [more, setMore] = useState<{ key: string; busy: boolean; error?: string } | null>(null);
  const moreRequest = useRef<AbortController | null>(null);
  const selectionRequest = useRef<AbortController | null>(null);
  const selectionVersion = useRef(0);
  const selectionOrigin = useRef<{ origin: SelectionOrigin; key?: string } | null>(null);
  const automaticKey = useRef(automaticSelection?.key ?? null);
  const startAutomatic = useRef<(request: AutomaticVendorSelection) => void>(() => {});
  const mounted = useRef(false);
  const callbacks = useRef({ onChange, onPendingChange });
  const selectedMatches = selected?.id === value && selected?.companyId === companyId;
  const currentHydrationError = hydrationError?.vendorId === value ? hydrationError.message : null;
  const hydrating = !!companyId && !!value && !selectedMatches && !currentHydrationError;
  const query = text.trim().slice(0, 100);
  const searchKey = JSON.stringify([companyId, query, revision]);
  const searchEnabled = !!companyId && open && !disabled && !hydrating && !resolving;
  const currentSearch = search?.key === searchKey ? search : null;
  const result = currentSearch?.data?.companyId === companyId ? currentSearch.data : null;
  const suggestions = (result?.vendors ?? []).filter((vendor) =>
    vendor.companyId === companyId &&
    (vendor.externalVendorId
      ? !!result?.organizationId && vendor.organizationId === result.organizationId
      : !!vendor.id),
  );
  const searchLoading = searchEnabled && !currentSearch;
  const listId = `${id}-suggestions`;
  const statusId = `${id}-status`;
  const listVisible = open && searchEnabled;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      selectionVersion.current += 1;
      selectionRequest.current?.abort();
      moreRequest.current?.abort();
    };
  }, []);

  useLayoutEffect(() => {
    callbacks.current = { onChange, onPendingChange };
  }, [onChange, onPendingChange]);
  useLayoutEffect(() => { automaticKey.current = automaticSelection?.key ?? null; }, [automaticSelection?.key]);

  useEffect(() => {
    if (!companyId || !value || selectedMatches) return;
    const controller = new AbortController();
    const version = ++selectionVersion.current;
    selectionRequest.current?.abort();
    selectionRequest.current = controller;
    callbacks.current.onPendingChange(true);
    const params = new URLSearchParams({ companyId, q: "", vendorId: value });
    api<VendorSearchResult>(`/api/vendors/search?${params}`, { signal: controller.signal })
      .then((data) => {
        if (!mounted.current || controller.signal.aborted || version !== selectionVersion.current) return;
        const vendor = data.selectedVendor;
        if (data.companyId !== companyId || vendor?.companyId !== companyId || vendor.id !== value) {
          throw new Error("The saved vendor is unavailable for this company. Search for a vendor to continue.");
        }
        callbacks.current.onPendingChange(false);
        setSelected(vendor);
        setText(vendor.name);
        setHydrationError(null);
        callbacks.current.onChange(vendor, "hydration");
      })
      .catch((error: unknown) => {
        if (!mounted.current || controller.signal.aborted || version !== selectionVersion.current) return;
        callbacks.current.onPendingChange(false);
        setHydrationError({ vendorId: value, message: errorMessage(error) });
      });
    return () => {
      controller.abort();
      if (version === selectionVersion.current) callbacks.current.onPendingChange(false);
    };
  }, [companyId, value, selectedMatches, hydrationRevision]);

  useEffect(() => {
    if (!searchEnabled) return;
    function refreshOnReturn() {
      if (document.visibilityState !== "visible") return;
      // The existing search debounce coalesces paired visibility/focus events.
      moreRequest.current?.abort();
      setActiveIndex(-1);
      setRevision(current => current + 1);
    }
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [searchEnabled]);

  useEffect(() => {
    if (!searchEnabled) return;
    moreRequest.current?.abort();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      const params = new URLSearchParams({ companyId, q: query });
      api<VendorSearchResult>(`/api/vendors/search?${params}`, { signal: controller.signal })
        .then((data) => {
          if (controller.signal.aborted) return;
          if (data.companyId !== companyId) throw new Error("Vendor results did not match this company. Retry the search.");
          setSearch({ key: searchKey, data });
          setMore(null);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setSearch({ key: searchKey, error: errorMessage(error) });
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [companyId, query, searchKey, searchEnabled]);

  async function loadMore() {
    if (!searchEnabled || document.visibilityState !== "visible" || !result?.hasMore || more?.key === searchKey && more.busy) return;
    const key = searchKey, previous = result, page = (result.page ?? 1) + 1;
    const controller = new AbortController(); moreRequest.current?.abort(); moreRequest.current = controller;
    setMore({ key, busy: true });
    try {
      const data = await api<VendorSearchResult>(`/api/vendors/search?${new URLSearchParams({ companyId, q: query, page: String(page) })}`, { signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return;
      if (data.companyId !== companyId || data.organizationId !== previous.organizationId || data.dataCenter !== previous.dataCenter || data.environment !== previous.environment || data.page !== page || data.perPage !== 25)
        throw new Error("The next vendor page did not match this search. Retry loading vendors.");
      setSearch(current => current?.key === key ? { key, data: { ...data, vendors: mergePages(current.data?.vendors ?? [], data.vendors) } } : current);
      setMore({ key, busy: false });
    } catch (error) {
      if (!controller.signal.aborted && mounted.current) setMore({ key, busy: false, error: errorMessage(error) });
    }
  }

  function cancelSelection(source: "clear" | "automatic" = "clear", key?: string) {
    selectionVersion.current += 1;
    selectionRequest.current?.abort();
    selectionOrigin.current = null;
    setResolving(false);
    setResolutionError(null);
    setHydrationError(null);
    setSelected(null);
    callbacks.current.onPendingChange(false, key);
    callbacks.current.onChange(null, source, key);
  }

  async function choose(suggestion: VendorSuggestion, origin: SelectionOrigin = "selection", expectedIdentity?: ExpectedIdentity, key?: string) {
    if (disabled || suggestion.selectable === false || suggestion.companyId !== companyId) return;
    if (origin === "automatic" && (!key || automaticKey.current !== key || !expectedIdentity)) return;
    cancelSelection(origin === "automatic" ? "automatic" : "clear", key);
    setText(suggestion.name);
    setOpen(false);
    setActiveIndex(-1);
    if (!suggestion.externalVendorId) {
      if (!suggestion.id) return;
      const vendor: Vendor = { ...suggestion, id: suggestion.id };
      setSelected({ ...vendor, booksMappingRequired: suggestion.booksMappingRequired });
      callbacks.current.onChange(vendor, origin, key);
      return;
    }
    if (!suggestion.organizationId || !suggestion.dataCenter || !suggestion.environment) {
      setResolutionError({ suggestion, origin, expectedIdentity, automaticKey: key,
        message: "This vendor's Books destination is incomplete. Search again to refresh the vendor list." });
      return;
    }
    const controller = new AbortController();
    const version = ++selectionVersion.current;
    selectionRequest.current = controller;
    selectionOrigin.current = { origin, key };
    setResolving(true);
    callbacks.current.onPendingChange(true, key);
    try {
      const { vendor } = await api<{ vendor: Vendor }>("/api/vendors/resolve", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          companyId,
          organizationId: suggestion.organizationId,
          dataCenter: suggestion.dataCenter,
          environment: suggestion.environment,
          externalVendorId: suggestion.externalVendorId,
          ...(origin === "automatic" ? { expectedIdentity } : {}),
        }),
      });
      if (!mounted.current || controller.signal.aborted || version !== selectionVersion.current ||
        origin === "automatic" && automaticKey.current !== key) return;
      if (!vendor?.id || vendor.companyId !== companyId) throw new Error("The selected vendor did not match this company. Search again to continue.");
      if (origin === "automatic" && (vendor.currency !== expectedIdentity?.currency || suggestion.id && vendor.id !== suggestion.id))
        throw new Error("The matched vendor changed. Search and select the correct vendor before saving.");
      selectionOrigin.current = null;
      setResolving(false);
      callbacks.current.onPendingChange(false, key);
      setSelected(vendor);
      setText(vendor.name);
      callbacks.current.onChange(vendor, origin, key);
    } catch (error: unknown) {
      if (!mounted.current || controller.signal.aborted || version !== selectionVersion.current ||
        origin === "automatic" && automaticKey.current !== key) return;
      setResolving(false);
      callbacks.current.onPendingChange(false, key);
      setResolutionError({ suggestion, message: errorMessage(error), origin, expectedIdentity, automaticKey: key });
    }
  }

  useLayoutEffect(() => {
    startAutomatic.current = request => { void choose(request.candidate, "automatic", request.expectedIdentity, request.key); };
  });
  useEffect(() => {
    if (!automaticSelection || disabled) return;
    startAutomatic.current(automaticSelection);
    return () => {
      if (selectionOrigin.current?.origin !== "automatic" || selectionOrigin.current.key !== automaticSelection.key) return;
      selectionVersion.current += 1;
      selectionRequest.current?.abort();
      selectionOrigin.current = null;
      setResolving(false);
      setResolutionError(current => current?.automaticKey === automaticSelection.key ? null : current);
      callbacks.current.onPendingChange(false, automaticSelection.key);
    };
  }, [automaticSelection, disabled]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (listVisible && suggestions[activeIndex]) void choose(suggestions[activeIndex]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (!suggestions.length) return;
      const next = event.key === "ArrowDown"
        ? (activeIndex + 1) % suggestions.length
        : (activeIndex <= 0 ? suggestions.length : activeIndex) - 1;
      setActiveIndex(next);
      document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: "nearest" });
    }
  }

  return (
    <div className="vendor-autocomplete" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setOpen(false);
        setActiveIndex(-1);
      }
    }}>
      <Input
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={listVisible}
        aria-controls={listId}
        aria-activedescendant={listVisible && suggestions[activeIndex] ? `${listId}-${activeIndex}` : undefined}
        aria-describedby={statusId}
        autoComplete="off"
        required
        disabled={disabled || !companyId}
        maxLength={100}
        value={text}
        placeholder={!companyId ? "Select a company first" : hydrating ? "Loading selected vendor…" : "Search vendors"}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        onChange={(event) => {
          cancelSelection();
          setText(event.target.value);
          setActiveIndex(-1);
          setOpen(true);
        }}
      />
      {listVisible && (
        <div className="vendor-suggestions-panel">
          {searchLoading && <p className="vendor-search-message" role="status">Searching vendors…</p>}
          {currentSearch?.error && <div className="vendor-search-message" role="alert">
            <p>{currentSearch.error}</p>
            <Button type="button" variant="secondary" onClick={() => setRevision((current) => current + 1)}>Retry vendor search</Button>
          </div>}
          {result?.warning && <div className="vendor-search-message vendor-search-warning" role="status">
            <p>{result.warning}</p>
            <Button type="button" variant="secondary" onClick={() => setRevision((current) => current + 1)}>Retry vendor search</Button>
          </div>}
          {result && !result.warning && !suggestions.length && <p className="vendor-search-message" role="status">No matching vendors. Try another name.</p>}
          <ul id={listId} role="listbox" aria-label="Vendor suggestions" className="vendor-suggestions">
            {suggestions.map((vendor, index) => (
              <li
                id={`${listId}-${index}`}
                key={vendor.externalVendorId ? `${vendor.dataCenter}:${vendor.environment}:${vendor.organizationId}:${vendor.externalVendorId}` : vendor.id}
                role="option"
                aria-selected={index === activeIndex}
                aria-disabled={vendor.selectable === false}
                className="vendor-suggestion"
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => void choose(vendor)}
              >
                <span className="vendor-suggestion-name">{vendor.name}</span>
                <span className="vendor-suggestion-meta">{vendor.currency}{vendor.externalVendorId ? " · Zoho Books" : vendor.booksMappingRequired ? " · Local · Books mapping required" : " · Local"}</span>
                {vendor.unavailableReason && <span className="vendor-suggestion-meta">{vendor.unavailableReason} · Cannot select for a bill</span>}
              </li>
            ))}
          </ul>
          {more?.key === searchKey && more.error && <p className="vendor-search-message" role="alert">{more.error}</p>}
          {result?.hasMore && <div className="vendor-search-message">
            <Button type="button" variant="secondary" size="sm" disabled={more?.key === searchKey && more.busy}
              onMouseDown={event => event.preventDefault()} onClick={() => void loadMore()}>
              {more?.key === searchKey && more.busy ? "Loading vendors…" : "Load more vendors"}
            </Button><p>Search by name or load more matching vendors.</p>
          </div>}
          {result && !result.warning && <div className="vendor-search-message">
            <Button type="button" variant="secondary" size="sm"
              onMouseDown={event => event.preventDefault()} onClick={() => {
                if (!searchEnabled || document.visibilityState !== "visible") return;
                moreRequest.current?.abort();
                setActiveIndex(-1);
                setRevision(current => current + 1);
              }}>Refresh vendors</Button>
          </div>}
        </div>
      )}
      <div id={statusId} className="vendor-selection-status" aria-live="polite">
        {selectedMatches && selected?.booksMappingRequired && <p>Local supplier selected. Save a draft; a verified Books mapping is required before sync.</p>}
        {hydrating && <p>Loading selected vendor…</p>}
        {(resolving || automaticSelection && !selectedMatches && !resolutionError) && <p>{automaticSelection ? "Selecting matched vendor…" : "Selecting vendor…"}</p>}
        {currentHydrationError && <div role="alert">
          <p>{currentHydrationError}</p>
          <Button type="button" variant="secondary" onClick={() => {
            setHydrationError(null);
            setHydrationRevision((current) => current + 1);
          }}>Retry vendor search</Button>
        </div>}
        {resolutionError && <div role="alert">
          <p>{resolutionError.message}</p>
          <Button type="button" variant="secondary" onClick={() => void choose(resolutionError.suggestion, resolutionError.origin,
            resolutionError.expectedIdentity, resolutionError.automaticKey)}>Retry vendor selection</Button>
        </div>}
      </div>
    </div>
  );
}
