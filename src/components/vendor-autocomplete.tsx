"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, errorMessage } from "./api";
import type { Vendor, VendorSearchResult, VendorSuggestion } from "./types";
import { Button, Input } from "./ui";

type Props = {
  id: string;
  companyId: string;
  value: string;
  disabled?: boolean;
  onChange: (vendor: Vendor | null, source: "selection" | "hydration" | "clear") => void;
  onPendingChange: (pending: boolean) => void;
};

// The parent keys this field by company so changing company also discards its text,
// results and requests, without resetting any other bill fields.
export function VendorAutocomplete({ id, companyId, value, disabled, onChange, onPendingChange }: Props) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [selected, setSelected] = useState<(Vendor & { booksMappingRequired?: boolean }) | null>(null);
  const [revision, setRevision] = useState(0);
  const [hydrationRevision, setHydrationRevision] = useState(0);
  const [hydrationError, setHydrationError] = useState<{ vendorId: string; message: string } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolutionError, setResolutionError] = useState<{ suggestion: VendorSuggestion; message: string } | null>(null);
  const [search, setSearch] = useState<{ key: string; data?: VendorSearchResult; error?: string } | null>(null);
  const selectionRequest = useRef<AbortController | null>(null);
  const selectionVersion = useRef(0);
  const mounted = useRef(false);
  const callbacks = useRef({ onChange, onPendingChange });
  const selectedMatches = selected?.id === value && selected?.companyId === companyId;
  const currentHydrationError = hydrationError?.vendorId === value ? hydrationError.message : null;
  const hydrating = !!companyId && !!value && !selectedMatches && !currentHydrationError;
  const query = text.trim().slice(0, 100);
  const searchKey = JSON.stringify([companyId, query, revision]);
  const searchEnabled = !!companyId && open && !hydrating && !resolving;
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
    };
  }, []);

  useLayoutEffect(() => {
    callbacks.current = { onChange, onPendingChange };
  }, [onChange, onPendingChange]);

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
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ companyId, q: query });
      api<VendorSearchResult>(`/api/vendors/search?${params}`, { signal: controller.signal })
        .then((data) => {
          if (controller.signal.aborted) return;
          if (data.companyId !== companyId) throw new Error("Vendor results did not match this company. Retry the search.");
          setSearch({ key: searchKey, data });
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

  function cancelSelection() {
    selectionVersion.current += 1;
    selectionRequest.current?.abort();
    setResolving(false);
    setResolutionError(null);
    setHydrationError(null);
    setSelected(null);
    onPendingChange(false);
    onChange(null, "clear");
  }

  async function choose(suggestion: VendorSuggestion) {
    if (disabled || suggestion.companyId !== companyId) return;
    cancelSelection();
    setText(suggestion.name);
    setOpen(false);
    setActiveIndex(-1);
    if (!suggestion.externalVendorId) {
      if (!suggestion.id) return;
      const vendor: Vendor = { ...suggestion, id: suggestion.id };
      setSelected({ ...vendor, booksMappingRequired: suggestion.booksMappingRequired });
      onChange(vendor, "selection");
      return;
    }
    if (!suggestion.organizationId || !suggestion.dataCenter || !suggestion.environment) {
      setResolutionError({ suggestion, message: "This vendor's Books destination is incomplete. Search again to refresh the vendor list." });
      return;
    }
    const controller = new AbortController();
    const version = ++selectionVersion.current;
    selectionRequest.current = controller;
    setResolving(true);
    onPendingChange(true);
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
        }),
      });
      if (!mounted.current || controller.signal.aborted || version !== selectionVersion.current) return;
      if (!vendor?.id || vendor.companyId !== companyId) throw new Error("The selected vendor did not match this company. Search again to continue.");
      setResolving(false);
      callbacks.current.onPendingChange(false);
      setSelected(vendor);
      setText(vendor.name);
      callbacks.current.onChange(vendor, "selection");
    } catch (error: unknown) {
      if (!mounted.current || controller.signal.aborted || version !== selectionVersion.current) return;
      setResolving(false);
      callbacks.current.onPendingChange(false);
      setResolutionError({ suggestion, message: errorMessage(error) });
    }
  }

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
                className="vendor-suggestion"
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => void choose(vendor)}
              >
                <span className="vendor-suggestion-name">{vendor.name}</span>
                <span className="vendor-suggestion-meta">{vendor.currency}{vendor.externalVendorId ? " · Zoho Books" : vendor.booksMappingRequired ? " · Local · Books mapping required" : " · Local"}</span>
              </li>
            ))}
          </ul>
          {result?.hasMore && <p className="vendor-search-message">Type more of the name to narrow the results.</p>}
        </div>
      )}
      <div id={statusId} className="vendor-selection-status" aria-live="polite">
        {selectedMatches && selected?.booksMappingRequired && <p>Local supplier selected. Save a draft; a verified Books mapping is required before sync.</p>}
        {hydrating && <p>Loading selected vendor…</p>}
        {resolving && <p>Selecting vendor…</p>}
        {currentHydrationError && <div role="alert">
          <p>{currentHydrationError}</p>
          <Button type="button" variant="secondary" onClick={() => {
            setHydrationError(null);
            setHydrationRevision((current) => current + 1);
          }}>Retry vendor search</Button>
        </div>}
        {resolutionError && <div role="alert">
          <p>{resolutionError.message}</p>
          <Button type="button" variant="secondary" onClick={() => void choose(resolutionError.suggestion)}>Retry vendor selection</Button>
        </div>}
      </div>
    </div>
  );
}
