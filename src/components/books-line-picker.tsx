"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { BooksSelection } from "@/lib/books-selection";
import { useApi } from "./api";
import type { BillBooksOptions } from "./types";
import { Button, Input } from "./ui";

type Kind = "account" | "tax" | "customer";
export type BooksLineDraft = Partial<BooksSelection> & { unfinished?: Partial<Record<Kind, boolean>> };

export function hasBooksLineDraft(draft?: BooksLineDraft) {
  return !!draft && !!(draft.accountId || draft.taxId || draft.customerId || Object.values(draft.unfinished ?? {}).some(Boolean));
}

export function booksLineSelection(draft?: BooksLineDraft): BooksSelection | null {
  if (!draft || Object.values(draft.unfinished ?? {}).some(Boolean) ||
    !draft.organizationId || !draft.dataCenter || !draft.environment ||
    !draft.accountId || !draft.accountName || !draft.taxId || !draft.taxName || draft.taxRate === undefined ||
    (!!draft.customerId !== !!draft.customerName)) return null;
  return {
    organizationId: draft.organizationId, dataCenter: draft.dataCenter, environment: draft.environment,
    accountId: draft.accountId, accountName: draft.accountName,
    taxId: draft.taxId, taxName: draft.taxName, taxRate: draft.taxRate,
    customerId: draft.customerId ?? null, customerName: draft.customerName ?? null,
  };
}

function sameDestination(a: Pick<BillBooksOptions, "organizationId" | "dataCenter" | "environment">, b: Partial<Pick<BillBooksOptions, "organizationId" | "dataCenter" | "environment">>) {
  return a.organizationId === b.organizationId && a.dataCenter === b.dataCenter && a.environment === b.environment;
}

type Option = { id: string; label: string; description?: string; group?: string; disabled?: boolean };
type PickerProps = {
  label: string;
  kind: Kind;
  selected: Option | null;
  options: Option[];
  disabled: boolean;
  loading: boolean;
  error?: string | null;
  warning?: string | null;
  hasMore?: boolean;
  retry: () => void;
  onType: (text: string) => void;
  onChoose: (id: string) => void;
};

function SearchPicker({ label, kind, selected, options, disabled, loading, error, warning, hasMore, retry, onType, onChoose }: PickerProps) {
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<CSSProperties>({});
  const id = label.toLowerCase().replaceAll(" ", "-");
  const listId = `${id}-options`;
  const statusId = `${id}-status`;
  const plural = kind === "tax" ? "taxes" : `${kind}s`;
  const searchText = editing ? query.trim().toLowerCase() : "";
  const combined = selected && !options.some((option) => option.id === selected.id) ? [selected, ...options] : options;
  const matches = combined.filter((option) => `${option.label} ${option.group ?? ""} ${option.description ?? ""}`.toLowerCase().includes(searchText));
  const value = editing ? query : selected?.label ?? "";

  function position() {
    const rect = input.current?.getBoundingClientRect();
    if (!rect) return {};
    const width = Math.min(Math.max(rect.width, 270), window.innerWidth - 24);
    const above = Math.max(0, rect.top - 16);
    const below = Math.max(0, window.innerHeight - rect.bottom - 16);
    const placeAbove = below < 220 && above > below;
    return {
      width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      maxHeight: Math.min(290, placeAbove ? above : below),
      ...(placeAbove
        ? { bottom: window.innerHeight - rect.top + 4 }
        : { top: rect.bottom + 4 }),
    };
  }

  function show() {
    setPlacement(position());
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const update = () => setPlacement(position());
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  function choose(option: Option) {
    if (option.disabled || disabled) return;
    onChoose(option.id);
    setEditing(false);
    setOpen(false);
    setActive(-1);
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (open && matches[active]) choose(matches[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setActive(-1);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      show();
      const available = matches.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
      if (!available.length) return;
      const current = available.indexOf(active);
      const next = available[event.key === "ArrowDown"
        ? (current + 1) % available.length
        : (current <= 0 ? available.length : current) - 1];
      setActive(next);
      document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: "nearest" });
    }
  }

  return <div className="books-line-picker">
    <div className="books-picker-input">
      <Input ref={input} id={id} aria-label={label} role="combobox" aria-autocomplete="list"
        aria-expanded={open} aria-controls={listId} aria-describedby={statusId}
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        autoComplete="off" disabled={disabled} value={value} maxLength={100}
        placeholder={kind === "customer" ? "Optional customer" : `Search ${plural}`}
        onFocus={show} onClick={show} onBlur={() => { setOpen(false); setActive(-1); }} onKeyDown={keyDown}
        onChange={(event) => {
          setEditing(true);
          setQuery(event.target.value);
          setActive(-1);
          onType(event.target.value);
          show();
        }} />
      {value && <button className="books-picker-clear" type="button" disabled={disabled}
        aria-label={`Clear ${label.toLowerCase()}`} onClick={() => {
          setQuery(""); setEditing(false); setOpen(false); setActive(-1); onType("");
        }}>×</button>}
    </div>
    <span id={statusId} className="books-picker-hint">
      {loading ? `Loading ${plural}…` : error ? `${kind[0].toUpperCase() + kind.slice(1)} options unavailable.`
        : kind === "tax" && selected?.description ? selected.description : kind === "customer" ? "Optional Books attribution" : ""}
    </span>
    {(error || warning) && <Button type="button" variant="ghost" className="books-picker-retry" onClick={retry}>Retry {kind} options</Button>}
    {open && createPortal(<div className="books-picker-panel" style={placement}
      onMouseDown={(event) => event.preventDefault()}>
      {loading && <p role="status" className="books-picker-message">Loading {plural}…</p>}
      {error && <div role="alert" className="books-picker-message"><p>{error}</p></div>}
      {warning && <div role="status" className="books-picker-message"><p>{warning}</p></div>}
      {!loading && !error && !warning && !matches.length && <p role="status" className="books-picker-message">No matching {plural}.</p>}
      <ul role="listbox" id={listId} aria-label={`${label} options`} className="books-picker-options">
        {matches.map((option, index) => <li role="presentation" key={option.id}>
          {option.group && option.group !== matches[index - 1]?.group && <div className="books-picker-group">{option.group.replaceAll("_", " ")}</div>}
          <div role="option" id={`${listId}-${index}`} aria-selected={active === index} aria-disabled={option.disabled || undefined}
            className="books-picker-option" onMouseMove={() => setActive(index)} onClick={() => choose(option)}>
            <span>{option.label}</span>{option.description && <small>{option.description}</small>}
            {option.disabled && <small>Unavailable for bill entry</small>}
          </div>
        </li>)}
      </ul>
      {hasMore && <p className="books-picker-message">Type more of the customer name to narrow the results.</p>}
    </div>, document.body)}
  </div>;
}

type LinePickerProps = {
  kind: Kind;
  lineNumber: number;
  companyId: string;
  draft?: BooksLineDraft;
  catalog: BillBooksOptions | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
  disabled: boolean;
  onChange: (draft: BooksLineDraft) => void;
};

export function BooksLinePicker(props: LinePickerProps) {
  return <ScopedBooksLinePicker key={JSON.stringify([props.companyId, props.draft?.organizationId, props.draft?.dataCenter, props.draft?.environment])} {...props} />;
}

function ScopedBooksLinePicker({ kind, lineNumber, companyId, draft, catalog, loading, error, retry, disabled, onChange }: LinePickerProps) {
  const [customerQuery, setCustomerQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(customerQuery), 300);
    return () => clearTimeout(timer);
  }, [customerQuery]);
  const queryPending = customerQuery !== debouncedQuery;
  const missingCustomer = kind === "customer" && !!draft?.customerId && !!catalog &&
    !catalog.customers.some((customer) => customer.id === draft.customerId);
  const customerParams = new URLSearchParams({ companyId,
    ...(customerQuery ? { customerQuery: customerQuery.trim().slice(0, 100) } : missingCustomer ? { customerId: draft!.customerId! } : {}),
  });
  const customerLookup = useApi<BillBooksOptions>(kind === "customer" && !!companyId && !queryPending &&
    (customerQuery.length > 0 || missingCustomer) ? `/api/bills/options?${customerParams}` : null);
  const remoteCustomers = customerLookup.data?.companyId === companyId && catalog &&
    sameDestination(customerLookup.data, catalog) ? customerLookup.data : null;
  const lookingUpCustomer = kind === "customer" && (customerQuery.length > 0 || missingCustomer);
  const customerMismatch = lookingUpCustomer && customerLookup.data && !remoteCustomers
    ? "The Books destination changed. Reload the options before choosing a customer." : null;
  const customerRows = lookingUpCustomer ? remoteCustomers?.customers ?? [] : catalog?.customers ?? [];

  const selectedId = draft?.[`${kind}Id`];
  const selectedName = draft?.[`${kind}Name`];
  const selected: Option | null = selectedId && selectedName ? {
    id: selectedId, label: selectedName,
    ...(kind === "tax" ? { description: `${draft?.taxRate ?? ""}% VAT` } : {}),
  } : null;
  const options: Option[] = kind === "account" ? (catalog?.accounts ?? []).map((account) => ({
    id: account.id, label: account.name, group: account.type, disabled: !account.selectable,
  })).sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label))
    : kind === "tax" ? (catalog?.taxes ?? []).map((tax) => ({ id: tax.id, label: tax.name, description: `${tax.rate}% VAT`, disabled: !tax.selectable }))
      : customerRows.map((customer) => ({ id: customer.id, label: customer.name, description: customer.currency }));

  function changeText(text: string) {
    if (kind === "customer") setCustomerQuery(text);
    onChange({ ...draft, [`${kind}Id`]: kind === "customer" ? null : "", [`${kind}Name`]: kind === "customer" ? null : "",
      ...(kind === "tax" ? { taxRate: undefined } : {}),
      unfinished: { ...draft?.unfinished, [kind]: !!text.trim() },
    });
  }

  function choose(id: string) {
    if (catalog?.companyId !== companyId || !catalog.organizationId || !catalog.dataCenter || !catalog.environment) return;
    // An explicit selection can accept refreshed labels or a changed tax rate.
    // Reloading the catalog alone must preserve the invoice's reviewed values.
    const next: BooksLineDraft = {
      ...(draft?.organizationId && !sameDestination(catalog, draft) ? {} : draft),
      organizationId: catalog.organizationId, dataCenter: catalog.dataCenter, environment: catalog.environment,
    };
    if (kind === "account") {
      const account = catalog.accounts.find((item) => item.id === id && item.selectable);
      if (!account) return;
      next.accountId = account.id; next.accountName = account.name;
    } else if (kind === "tax") {
      const tax = catalog.taxes.find((item) => item.id === id && item.selectable);
      if (!tax) return;
      next.taxId = tax.id; next.taxName = tax.name; next.taxRate = String(tax.rate);
    } else {
      const customer = customerRows.find((item) => item.id === id);
      if (!customer) return;
      next.customerId = customer.id; next.customerName = customer.name;
      setCustomerQuery("");
    }
    next.unfinished = { ...next.unfinished, [kind]: false };
    onChange(next);
  }

  return <SearchPicker label={`Line ${lineNumber} ${kind}`} kind={kind} selected={selected} options={options}
    disabled={disabled || !companyId} loading={loading || (kind === "customer" && (queryPending || customerLookup.loading))}
    error={error || (kind === "customer" ? customerLookup.error || customerMismatch : null)}
    warning={catalog?.warning || (kind === "customer" ? remoteCustomers?.warning : null)}
    hasMore={kind === "customer" && (lookingUpCustomer ? remoteCustomers?.hasMoreCustomers : catalog?.hasMoreCustomers)}
    retry={() => { retry(); customerLookup.reload(); }} onType={changeText} onChoose={choose} />;
}
