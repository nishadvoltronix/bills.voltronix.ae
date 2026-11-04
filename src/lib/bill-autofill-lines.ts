export type AutofillLineFields = { description: string; quantity: string; unitPrice: string };
export type AutofillLineEdit = keyof AutofillLineFields | "books";
export type AutofillLineOrigin = { key: number; fields: AutofillLineFields };
type Line = AutofillLineFields & { key: number; booksDraft?: unknown; booksSelection?: unknown };

const description = (line: AutofillLineFields) => line.description.trim().replace(/\s+/g, " ").toLocaleLowerCase();
const number = (value: string) => value.trim() && Number.isFinite(Number(value)) ? String(Number(value)) : value.trim();
const identity = (line: AutofillLineFields) => JSON.stringify([description(line), number(line.quantity), number(line.unitPrice)]);
const fields = (line: AutofillLineFields): AutofillLineFields => ({ description: line.description, quantity: line.quantity, unitPrice: line.unitPrice });
function groups<T>(rows: T[], key: (row: T) => string) {
  const result = new Map<string, T[]>();
  for (const row of rows) { const value = key(row); result.set(value, [...result.get(value) ?? [], row]); }
  return result;
}

/** Merge a complete reading, never infer accounting selections or overwrite human edits. */
export function mergeAutofillLines<T extends Line>(current: T[], origins: AutofillLineOrigin[], incoming: AutofillLineFields[] | undefined,
  edits: ReadonlyMap<number, ReadonlySet<AutofillLineEdit>>, create: (value: AutofillLineFields, key: number) => T) {
  const unchanged = (review = false) => ({ lines: current, origins, kept: review, review });
  if (!incoming?.length || incoming.length > 100 || incoming.some(line => !line ||
    typeof line.description !== "string" || typeof line.quantity !== "string" || typeof line.unitPrice !== "string")) return unchanged(origins.length > 0 || edits.size > 0);
  // A readable description/amount must not disappear because another cell is
  // unknown. Empty cells stay empty until the user supplies valid bill values.
  incoming = incoming.map(line => ({ description: line.description,
    quantity: line.quantity.trim() && Number.isFinite(Number(line.quantity)) && Number(line.quantity) > 0 ? line.quantity : "",
    unitPrice: line.unitPrice.trim() && Number.isFinite(Number(line.unitPrice)) && Number(line.unitPrice) >= 0 ? line.unitPrice : "" }));
  const hasHumanLine = current.some(line => edits.has(line.key) || line.booksDraft || line.booksSelection || line.description.trim() || line.unitPrice.trim());
  if (!origins.length) {
    if (hasHumanLine) {
      const byDescription = groups(incoming.map((line, index) => ({ line, index })), value => description(value.line));
      const currentDescriptions = groups(current, description), matches = new Map<number, T>(), used = new Set<number>();
      for (const existing of current) {
        const candidates = byDescription.get(description(existing)) ?? [];
        const index = current.length === 1 && !description(existing) ? 0
          : description(existing) && candidates.length === 1 && currentDescriptions.get(description(existing))?.length === 1 ? candidates[0].index : -1;
        if (index < 0 || used.has(index)) return unchanged(true);
        matches.set(index, existing); used.add(index);
      }
      let nextKey = Math.max(-1, ...current.map(line => line.key)) + 1;
      const next = incoming.map((line, index) => {
        const existing = matches.get(index);
        if (!existing) return create(fields(line), nextKey++);
        const value = { ...existing };
        for (const field of ["description", "quantity", "unitPrice"] as const) if (!edits.get(existing.key)?.has(field)) value[field] = line[field];
        return value;
      });
      return { lines: next, origins: incoming.map((line, index) => ({ key: next[index].key, fields: fields(line) })), kept: true, review: false };
    }
    const next = incoming.map((line, key) => create(fields(line), key));
    return { lines: next, origins: next.map(line => ({ key: line.key, fields: fields(line) })), kept: false, review: false };
  }
  const rows = new Map(current.map(line => [line.key, line]));
  const changed = (origin: AutofillLineOrigin) => {
    const row = rows.get(origin.key);
    return !!row && (!!edits.get(origin.key)?.size || !!row.booksDraft || !!row.booksSelection || identity(row) !== identity(origin.fields));
  };
  const oldGroups = groups(origins, origin => identity(origin.fields)), newGroups = groups(incoming.map((line, index) => ({ line, index })), value => identity(value.line));
  const matched = new Map<number, AutofillLineOrigin>(), used = new Set<number>(), heldOld = new Set<number>(), heldNew = new Set<number>();
  let review = false, kept = false;
  for (const [key, next] of newGroups) {
    const previous = oldGroups.get(key) ?? [];
    if (!previous.length) continue;
    if (previous.length === next.length) next.forEach((value, index) => { matched.set(value.index, previous[index]); used.add(previous[index].key); });
    else if (previous.length > 1 || next.length > 1) {
      if (previous.every(value => rows.has(value.key) && !changed(value))) {
        next.slice(0, previous.length).forEach((value, index) => { matched.set(value.index, previous[index]); used.add(previous[index].key); });
      } else {
        previous.forEach(value => heldOld.add(value.key)); next.forEach(value => heldNew.add(value.index)); review = true;
      }
    }
  }
  const unmatchedOld = groups(origins.filter(origin => !used.has(origin.key) && !heldOld.has(origin.key)), origin => description(origin.fields));
  const unmatchedNew = groups(incoming.map((line, index) => ({ line, index })).filter(value => !matched.has(value.index) && !heldNew.has(value.index)), value => description(value.line));
  for (const [key, next] of unmatchedNew) {
    const previous = unmatchedOld.get(key) ?? [];
    if (previous.length === 1 && next.length === 1) { matched.set(next[0].index, previous[0]); used.add(previous[0].key); }
    else if (previous.length) {
      previous.forEach(value => heldOld.add(value.key)); next.forEach(value => heldNew.add(value.index)); review = true;
    }
  }
  const orphanedEdited = origins.some(origin => !used.has(origin.key) && !heldOld.has(origin.key) && changed(origin));
  const manual = current.filter(line => !origins.some(origin => origin.key === line.key));
  kept ||= manual.length > 0;
  const nextRows = new Map<number, T>(), nextOrigins: AutofillLineOrigin[] = [];
  let nextKey = Math.max(-1, ...current.map(line => line.key), ...origins.map(origin => origin.key)) + 1;
  incoming.forEach((line, index) => {
    const origin = matched.get(index);
    if (origin) {
      // A missing row is an intentional user deletion: retain its tombstone.
      nextOrigins.push({ key: origin.key, fields: fields(line) });
      const row = rows.get(origin.key);
      if (!row) { kept = true; return; }
      const next = { ...row };
      for (const field of ["description", "quantity", "unitPrice"] as const) {
        if (edits.get(row.key)?.has(field) || row[field] !== origin.fields[field]) kept = true;
        else next[field] = line[field];
      }
      if (edits.get(row.key)?.has("books")) kept = true;
      nextRows.set(row.key, next);
    } else if (heldNew.has(index) || orphanedEdited || manual.some(row => description(row) === description(line))) review = true;
    else {
      const next = create(fields(line), nextKey++); nextRows.set(next.key, next);
      nextOrigins.push({ key: next.key, fields: fields(line) });
    }
  });
  for (const origin of origins) {
    if (used.has(origin.key)) continue;
    const row = rows.get(origin.key);
    if (!row || changed(origin) || heldOld.has(origin.key)) {
      nextOrigins.push(origin);
      if (row) nextRows.set(row.key, row);
      if (row) { kept = true; review = true; }
    }
  }
  for (const row of manual) nextRows.set(row.key, row);
  const ordered = [...current.filter(row => nextRows.has(row.key)).map(row => nextRows.get(row.key)!),
    ...Array.from(nextRows.values()).filter(row => !rows.has(row.key))];
  if (ordered.length > 100) return unchanged(true);
  return { lines: ordered.length ? ordered : [create({ description: "", quantity: "1", unitPrice: "" }, nextKey)], origins: nextOrigins, kept, review };
}
