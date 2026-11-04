import { describe, expect, it } from "vitest";
import { mergeAutofillLines, type AutofillLineEdit, type AutofillLineFields, type AutofillLineOrigin } from "../src/lib/bill-autofill-lines";

type Row = AutofillLineFields & { key: number; booksSelection?: { accountId: string } };
const item = (description: string, quantity = "1", unitPrice = "10.00"): AutofillLineFields => ({ description, quantity, unitPrice });
const row = (value: AutofillLineFields, key: number): Row => ({ ...value, key });
const blank = [row(item("", "1", ""), 0)];
const noEdits = new Map<number, Set<AutofillLineEdit>>();
const origins = (rows: Row[]): AutofillLineOrigin[] => rows.map(({ key, ...fields }) => ({ key, fields }));

describe("invoice reading row provenance", () => {
  it("fills an untouched table without adding any accounting IDs", () => {
    const result = mergeAutofillLines(blank, [], [item("Front"), item("Back")], noEdits, row);
    expect(result.lines).toEqual([row(item("Front"), 0), row(item("Back"), 1)]);
    expect(result.review).toBe(false);
    expect(result.lines.every(line => !line.booksSelection)).toBe(true);
  });

  it("keeps late manual entries instead of guessing their source association", () => {
    const current = [row(item("Typed while reading", "2", "7"), 0)];
    expect(mergeAutofillLines(current, [], [item("Front")], new Map([[0, new Set<AutofillLineEdit>(["description", "unitPrice"])] ]), row))
      .toMatchObject({ lines: current, origins: [], kept: true, review: true });
  });

  it("appends the back page while retaining edited quantity, price and Books selection", () => {
    const source = [row(item("Front", "2", "100"), 0)];
    const current = [{ ...source[0], quantity: "3", unitPrice: "101", booksSelection: { accountId: "human-account" } }];
    const result = mergeAutofillLines(current, origins(source), [item("Front", "2", "100"), item("Back", "1", "50")],
      new Map([[0, new Set<AutofillLineEdit>(["quantity", "unitPrice", "books"])] ]), row);
    expect(result.lines).toEqual([current[0], row(item("Back", "1", "50"), 1)]);
    expect(result.kept).toBe(true); expect(result.review).toBe(false);
    expect(result.origins[0].fields).toEqual(item("Front", "2", "100"));
  });

  it("matches original source identity after the human changes its visible description", () => {
    const source = [row(item("Printed item", "1", "10"), 8)];
    const current = [{ ...source[0], description: "Human wording" }];
    const result = mergeAutofillLines(current, origins(source), [item("Printed item", "1.00", "10.00"), item("New page item")],
      new Map([[8, new Set<AutofillLineEdit>(["description"])] ]), row);
    expect(result.lines.map(line => line.description)).toEqual(["Human wording", "New page item"]);
    expect(result.lines[0].key).toBe(8);
  });

  it("matches a unique description and updates only untouched fields", () => {
    const source = [row(item("Front", "1", "10"), 0)];
    const current = [{ ...source[0], unitPrice: "11" }];
    const result = mergeAutofillLines(current, origins(source), [item("Front", "2", "10"), item("Back")],
      new Map([[0, new Set<AutofillLineEdit>(["unitPrice"])] ]), row);
    expect(result.lines[0]).toEqual(row(item("Front", "2", "11"), 0));
    expect(result.lines).toHaveLength(2);
  });

  it("keeps deletion tombstones so later pages do not resurrect removed items", () => {
    const source = [row(item("Front"), 0), row(item("Removed"), 1)];
    const result = mergeAutofillLines([source[0]], origins(source), [item("Front"), item("Removed"), item("Back")], noEdits, row);
    expect(result.lines.map(line => line.description)).toEqual(["Front", "Back"]);
    expect(result.origins.some(origin => origin.key === 1)).toBe(true);
    const repeated = mergeAutofillLines(result.lines, result.origins, [item("Front"), item("Removed"), item("Back")], noEdits, row);
    expect(repeated.lines).toEqual(result.lines);
  });

  it("preserves legitimate identical rows and each row's own human changes", () => {
    const first = mergeAutofillLines(blank, [], [item("Repeated"), item("Repeated")], noEdits, row);
    const current = [first.lines[0], { ...first.lines[1], quantity: "4" }];
    const result = mergeAutofillLines(current, first.origins, [item("Repeated"), item("Repeated"), item("Back")],
      new Map([[1, new Set<AutofillLineEdit>(["quantity"])] ]), row);
    expect(result.lines.map(line => line.quantity)).toEqual(["1", "4", "1"]);
    expect(result.review).toBe(false);
  });

  it("holds changed duplicate counts rather than fabricating or dropping repeated items", () => {
    const source = [row(item("Repeated"), 0)];
    const result = mergeAutofillLines(source, origins(source), [item("Repeated"), item("Repeated"), item("Back")], new Map([[0, new Set<AutofillLineEdit>(["unitPrice"])] ]), row);
    expect(result.lines.map(line => line.description)).toEqual(["Repeated", "Back"]);
    expect(result.review).toBe(true);
  });

  it("accepts added and removed identical rows when all previous rows are untouched", () => {
    const source = [row(item("Repeated"), 0)];
    const added = mergeAutofillLines(source, origins(source), [item("Repeated"), item("Repeated")], noEdits, row);
    expect(added.lines).toHaveLength(2); expect(added.review).toBe(false);
    const removed = mergeAutofillLines(added.lines, added.origins, [item("Repeated")], noEdits, row);
    expect(removed.lines).toHaveLength(1); expect(removed.review).toBe(false);
  });

  it("holds an unmatched edited revision and warns instead of appending a likely duplicate", () => {
    const source = [row(item("Original wording"), 0)], current = [{ ...source[0], quantity: "5" }];
    const result = mergeAutofillLines(current, origins(source), [item("Uncertain changed wording")],
      new Map([[0, new Set<AutofillLineEdit>(["quantity"])] ]), row);
    expect(result.lines).toEqual(current); expect(result.review).toBe(true); expect(result.kept).toBe(true);
  });

  it("removes absent untouched extracted rows when the latest complete reading changes", () => {
    const source = [row(item("Front"), 0), row(item("Removed page"), 1)];
    const result = mergeAutofillLines(source, origins(source), [item("Front")], noEdits, row);
    expect(result.lines).toEqual([source[0]]);
  });

  it("holds a merge that would exceed the bill's 100-line limit", () => {
    const source = [row(item("Front"), 0)], current = [...source, row(item("Manual extra"), 1)];
    const incoming = [item("Front"), ...Array.from({ length: 99 }, (_, index) => item(`New ${index}`))];
    const result = mergeAutofillLines(current, origins(source), incoming, new Map([[1, new Set<AutofillLineEdit>(["description"])] ]), row);
    expect(result.lines).toEqual(current); expect(result.review).toBe(true);
  });

  it.each([undefined, []])(
    "does not clear human rows when financial lines are missing: %j", incoming => {
      const current = [row(item("Human", "2", "7"), 0)];
      const result = mergeAutofillLines(current, origins(current), incoming, noEdits, row);
      expect(result.lines).toEqual(current); expect(result.origins).toEqual(origins(current));
    });

  it("fills independent complete and partial rows without inventing unreadable cells", () => {
    const incoming = [item("Complete", "2", "10"), item("Description only", "", ""), item("Missing rate", "3", ""), item("", "4", "5")];
    const result = mergeAutofillLines(blank, [], incoming, noEdits, row);
    expect(result.lines.map(line => ({ description: line.description, quantity: line.quantity, unitPrice: line.unitPrice }))).toEqual(incoming);
    expect(result.lines[1].quantity).toBe("");
    expect(result.lines).toHaveLength(4);
  });

  it("keeps readable cells beside an invalid number rather than dropping its siblings", () => {
    const result = mergeAutofillLines(blank, [], [item("Unreadable quantity", "NaN", "10"), item("Unreadable price", "2", "NaN"), item("Complete", "1", "5")], noEdits, row);
    expect(result.lines).toEqual([row(item("Unreadable quantity", "", "10"), 0), row(item("Unreadable price", "2", ""), 1), row(item("Complete", "1", "5"), 2)]);
  });

  it("retains an empty item placeholder when its printed amount is available only in the invoice notes", () => {
    const result = mergeAutofillLines(blank, [], [item("", "", ""), item("Readable next item", "1", "5")], noEdits, row);
    expect(result.lines).toEqual([row(item("", "", ""), 0), row(item("Readable next item", "1", "5"), 1)]);
  });

  it("fills untouched cells of the initial row while preserving a typed amount and Books choice", () => {
    const current = [{ ...blank[0], unitPrice: "7.50", booksSelection: { accountId: "human-account" } }];
    const result = mergeAutofillLines(current, [], [item("Printed first", "2", "10"), item("Printed second", "", "20")],
      new Map([[0, new Set<AutofillLineEdit>(["unitPrice", "books"])] ]), row);
    expect(result.lines).toEqual([{ ...row(item("Printed first", "2", "7.50"), 0), booksSelection: { accountId: "human-account" } }, row(item("Printed second", "", "20"), 1)]);
    expect(result.kept).toBe(true); expect(result.review).toBe(false);
  });

  it("uses a unique human description match to fill untouched cells and append remaining items", () => {
    const current = [row(item("Printed first", "3", ""), 0)];
    const result = mergeAutofillLines(current, [], [item("Printed first", "2", "10"), item("Printed second", "1", "20")],
      new Map([[0, new Set<AutofillLineEdit>(["description", "quantity"])] ]), row);
    expect(result.lines).toEqual([row(item("Printed first", "3", "10"), 0), row(item("Printed second", "1", "20"), 1)]);
  });

  it("completes an unreadable cell on a later reading without overwriting the human correction", () => {
    const first = mergeAutofillLines(blank, [], [item("Partial", "", "10")], noEdits, row);
    const current = [{ ...first.lines[0], unitPrice: "11" }];
    const result = mergeAutofillLines(current, first.origins, [item("Partial", "2", "10"), item("Back", "1", "5")],
      new Map([[0, new Set<AutofillLineEdit>(["unitPrice"])] ]), row);
    expect(result.lines).toEqual([row(item("Partial", "2", "11"), 0), row(item("Back", "1", "5"), 1)]);
  });
});
