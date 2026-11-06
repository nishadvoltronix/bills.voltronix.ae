"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { BillItemSuggestions } from "@/lib/services/bill-item-suggestions";
import { api } from "./api";
import { Button, Textarea } from "./ui";
import styles from "./job-item-autocomplete.module.css";

type Props = {
  id: string;
  actorKey: string;
  companyId: string;
  jobId: string;
  lineNumber: number;
  value: string;
  disabled?: boolean;
  onChange: (description: string) => void;
};

export function JobItemAutocomplete({ id, actorKey, companyId, jobId, lineNumber, value, disabled = false, onChange }: Props) {
  const input = useRef<HTMLTextAreaElement>(null), panel = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [revision, setRevision] = useState(0);
  const [placement, setPlacement] = useState<CSSProperties>({});
  const [search, setSearch] = useState<{ key: string; suggestions?: BillItemSuggestions["suggestions"]; failed?: boolean } | null>(null);
  const query = value.trim();
  const enabled = open && !disabled && !!companyId && !!jobId && query.length > 0 && query.length <= 500;
  const key = JSON.stringify([actorKey, companyId, jobId, query, revision, enabled]);
  const currentKey = useRef(key);
  const current = enabled && search?.key === key ? search : null;
  const suggestions = current?.suggestions ?? [];
  const loading = enabled && !current;
  const listId = `${id}-suggestions`, statusId = `${id}-status`;

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useLayoutEffect(() => { currentKey.current = key; }, [key]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ companyId, jobId, q: query });
      api<BillItemSuggestions>(`/api/bills/item-suggestions?${params}`, { signal: controller.signal })
        .then(data => {
          if (!mounted.current || controller.signal.aborted || currentKey.current !== key) return;
          if (data.companyId !== companyId || data.jobId !== jobId || !Array.isArray(data.suggestions) ||
            data.suggestions.length > 10 || data.suggestions.some(item => typeof item.description !== "string" ||
              !item.description.trim() || item.description.length > 500)) throw new Error("Invalid item suggestions.");
          setSearch({ key, suggestions: data.suggestions });
        })
        .catch(() => {
          if (mounted.current && !controller.signal.aborted && currentKey.current === key) setSearch({ key, failed: true });
        });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [enabled, key, companyId, jobId, query]);

  useEffect(() => {
    if (!enabled) return;
    function position() {
      const rect = input.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(Math.max(rect.width, 260), window.innerWidth - 24);
      const above = Math.max(0, rect.top - 16), below = Math.max(0, window.innerHeight - rect.bottom - 16);
      const placeAbove = below < 220 && above > below;
      setPlacement({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        maxHeight: Math.min(280, placeAbove ? above : below),
        ...(placeAbove ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }) });
    }
    position();
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => { window.removeEventListener("scroll", position, true); window.removeEventListener("resize", position); };
  }, [enabled]);

  function choose(description: string) {
    if (!mounted.current || !enabled || currentKey.current !== key || !suggestions.some(item => item.description === description)) return;
    onChange(description);
    input.current?.focus({ preventScroll: true });
    setOpen(false);
    setActive(-1);
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && open) {
      event.preventDefault(); setOpen(false); setActive(-1);
    } else if (event.key === "Enter" && !event.shiftKey && enabled && suggestions[active]) {
      event.preventDefault(); choose(suggestions[active].description);
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && enabled && suggestions.length) {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? (active + 1) % suggestions.length : (active <= 0 ? suggestions.length : active) - 1;
      setActive(next);
      document.getElementById(`${listId}-${next}`)?.scrollIntoView({ block: "nearest" });
    }
  }

  return <div className={styles.root} onBlur={event => {
    const target = event.relatedTarget as Node | null;
    if (!event.currentTarget.contains(target) && !panel.current?.contains(target)) { setOpen(false); setActive(-1); }
  }}>
    <Textarea ref={input} id={id} role="combobox" aria-label={`Line ${lineNumber} description`}
      aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={enabled} aria-controls={enabled ? listId : undefined}
      aria-describedby={enabled ? statusId : undefined} aria-busy={loading}
      aria-activedescendant={enabled && suggestions[active] ? `${listId}-${active}` : undefined}
      placeholder="Enter an item or service description" value={value} disabled={disabled}
      required maxLength={500} rows={2} autoComplete="off"
      onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onKeyDown={keyDown}
      onChange={event => { onChange(event.target.value); setActive(-1); setOpen(true); }} />
    {enabled && createPortal(<div ref={panel} className={styles.panel} style={placement}
      onPointerDown={event => event.preventDefault()}>
      <p id={statusId} className={styles.message} role="status">
        {loading ? "Finding previous items…" : current?.failed ? "Previous items are unavailable. You can keep typing."
          : suggestions.length ? "Previously entered for this job" : "No saved items match. You can keep typing."}
      </p>
      {current?.failed && <Button type="button" variant="ghost" size="sm" className={styles.retry}
        onClick={() => { setActive(-1); setRevision(value => value + 1); }}>Retry item suggestions</Button>}
      <ul id={listId} role="listbox" aria-label={`Line ${lineNumber} previous item descriptions`} className={styles.options}>
        {suggestions.map((item, index) => <li key={item.description} id={`${listId}-${index}`} role="option"
          aria-selected={active === index} className={styles.option}
          onPointerMove={event => { if (event.pointerType === "mouse") setActive(index); }} onClick={() => choose(item.description)}>
          {item.description}
        </li>)}
      </ul>
    </div>, document.body)}
  </div>;
}
