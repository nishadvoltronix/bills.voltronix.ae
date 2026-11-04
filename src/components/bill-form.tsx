"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  ArrowLeft,
  LoaderCircle,
  Plus,
  ReceiptText,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { calculateBill } from "@/lib/finance";
import { matchesExactJobSearch, parseExactJobSearch } from "@/lib/job-search";
import { savedBillState } from "@/lib/bill-save-outcome";
import { BOOKS_NO_VAT, BOOKS_NO_VAT_NAME, type BooksSelection } from "@/lib/books-selection";
import { MAX_INVOICE_ATTACHMENTS, MAX_INVOICE_FILE_BYTES, MAX_INVOICE_TOTAL_BYTES } from "@/lib/invoice-attachments";
import { BOOKS_VENDOR_VAT_REVIEW_MESSAGE, hasBooksVendorTaxConflict } from "@/lib/integrations/books-vendor-tax";
import {
  PAYMENT_TERMS,
  resolveDueDate,
  type PaymentTerm,
} from "@/lib/payment-terms";
import { ApiError, api, dateInput, errorMessage, money, useApi } from "./api";
import type { Bill, BillBooksOptions, BooksConnection, Job, Vendor } from "./types";
import { useManualEntryOnly, useUser } from "./app-shell";
import {
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  LoadingPanel,
  Notice,
  Select,
  Table,
  Textarea,
} from "./ui";
import { AmountRow } from "./records";
import { CompanySelect } from "./company-select";
import { VendorAutocomplete } from "./vendor-autocomplete";
import { SavedBillOutcome, type SavedJobBill } from "./saved-bill-outcome";
import { InvoiceAttachmentPicker, type InvoiceFileSelection } from "./invoice-attachment-picker";
import { BooksLinePicker, booksLineSelection, hasBooksLineDraft, type BooksLineDraft } from "./books-line-picker";

type EditableLine = {
  key: number;
  description: string;
  quantity: string;
  unitPrice: string;
  booksSelection?: BooksSelection | null;
  booksDraft?: BooksLineDraft;
};
type OcrReviewContext = {
  documentId: string;
  version: number;
  mode?: "manual";
  sourceTotals?: {
    subtotal?: string;
    vatAmount?: string;
    total?: string;
    currency?: string;
  };
};
function booksSetupSteps(
  connection: NonNullable<BooksConnection["organizations"]>[number],
) {
  const missing = [
    ...(connection.missing ?? []),
    ...(connection.postingMissing ?? []),
  ];
  const steps: string[] = [];
  if (connection.authorization?.networkEnabled === false)
    steps.push("enable the Books connection");
  if (
    missing.some((item) => item.endsWith("_OAUTH_AUTHORIZATION")) ||
    connection.status === "CONFIGURED_UNVERIFIED"
  )
    steps.push("connect this company's Books account");
  if (missing.includes("ZOHO_BOOKS_MAPPING_JSON"))
    steps.push("complete the expense account, tax and currency mappings");
  if (missing.includes("LIVE_OPERATIONAL_ENVIRONMENT"))
    steps.push("configure this deployment for live Books synchronization");
  if (missing.includes("LIVE_COMPANY_VERIFICATION"))
    steps.push("verify this company and its Books destination for live posting");
  if (missing.includes("VERIFIED_NONPRODUCTION_TEST_AUTHORIZATION"))
    steps.push("authorize the selected test organization");
  return steps.length
    ? `Ask your administrator to ${steps.join(", and ")}.`
    : "Ask your administrator to check the Books connection, company permissions and accounting mappings.";
}
export function BillEditor({
  id,
  today,
  initialJobId,
  draft,
  review,
}: {
  id?: string;
  today?: string;
  initialJobId?: string;
  draft?: Partial<Bill>;
  review?: OcrReviewContext;
}) {
  const [continuation, setContinuation] = useState<{
    context: string; revision: number; receipt: SavedJobBill; today: string;
  } | null>(null);
  const state = useApi<{ bill: Bill }>(id ? `/api/bills/${id}` : null);
  const requestedJobId = !id && !review && !draft ? initialJobId : undefined;
  const jobState = useApi<{ job: Job }>(requestedJobId
    ? `/api/jobs/${encodeURIComponent(requestedJobId)}` : null);
  if (id && state.loading) return <LoadingPanel />;
  if (state.error)
    return <ErrorState message={state.error} retry={state.reload} />;
  if (requestedJobId && jobState.loading) return <LoadingPanel />;
  if (requestedJobId && (jobState.error || jobState.data?.job?.id !== requestedJobId || !jobState.data?.job?.companyId))
    return <>
      <ErrorState message={jobState.error ?? "The selected job could not be verified. Search for the job again."} retry={jobState.reload} />
      <Button asChild variant="secondary"><Link href="/bills/manual">Back to job search</Link></Button>
    </>;
  const context = requestedJobId && jobState.data?.job
    ? `${requestedJobId}:${jobState.data.job.companyId}` : null;
  const completed = continuation?.context === context ? continuation : null;
  return (
    <BillForm
      key={`${id ?? review?.documentId ?? requestedJobId ?? "new"}:${completed?.revision ?? 0}`}
      bill={state.data?.bill}
      draft={draft}
      review={review}
      today={completed?.today ?? today}
      initialJob={requestedJobId ? jobState.data?.job : undefined}
      previousSave={completed?.receipt}
      onSaved={context ? receipt => setContinuation(current => ({
        context, receipt, revision: current?.context === context ? current.revision + 1 : 1,
        today: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()),
      })) : undefined}
    />
  );
}
function BillForm({
  bill,
  draft,
  review,
  today,
  initialJob,
  previousSave,
  onSaved,
}: {
  bill?: Bill;
  draft?: Partial<Bill>;
  review?: OcrReviewContext;
  today?: string;
  initialJob?: Job;
  previousSave?: SavedJobBill;
  onSaved?: (receipt: SavedJobBill) => void;
}) {
  const router = useRouter();
  const user = useUser();
  const manualEntryOnly = useManualEntryOnly();
  const finalizedEdit = !!bill && ["READY", "APPROVED"].includes(bill.status);
  const saveLabel = finalizedEdit ? manualEntryOnly ? "Save changes" : "Save changes and sync" : manualEntryOnly ? "Save bill" : "Save and sync";
  const repeatJobEntry = !!initialJob && !!onSaved;
  const saveInFlight = useRef(false);
  const receiptNotice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!previousSave) return;
    receiptNotice.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [previousSave]);
  const jobs = useApi<{ jobs: Job[] }>("/api/jobs");
  const integrations = useApi<{ zoho: BooksConnection }>(manualEntryOnly ? null : "/api/integrations");
  const initial = bill ?? draft;
  const [companyId, setCompanyId] = useState(initial?.companyId ?? initialJob?.companyId ?? "");
  const availableJobs = [...(jobs.data?.jobs ?? [])];
  if (initialJob && !availableJobs.some((job) => job.id === initialJob.id)) availableJobs.push(initialJob);
  if (initial?.job && initial.companyId && !availableJobs.some(job => job.id === initial.jobId)) availableJobs.push({
    ...initial.job, id: initial.jobId!, companyId: initial.companyId, currency: initial.currency ?? initial.job.currency,
  });
  const booksOptions = useApi<BillBooksOptions>(companyId && !manualEntryOnly
    ? `/api/bills/options?${new URLSearchParams({ companyId })}` : null);
  const booksCatalog = booksOptions.data?.companyId === companyId ? booksOptions.data : null;
  const booksOptionsError = booksOptions.error || (booksOptions.data && !booksCatalog
    ? "Books options did not match this company. Reload the options." : null);
  const [confirmed, setConfirmed] = useState(false);
  const [vendorId, setVendorId] = useState(initial?.vendorId ?? "");
  const [chosenVendor, setChosenVendor] = useState<Vendor | null>(null);
  const [vendorLookupRevision, setVendorLookupRevision] = useState(0);
  const [vendorPending, setVendorPending] = useState<{ companyId: string; pending: boolean } | null>(null);
  const [jobId, setJobId] = useState(initial?.jobId ?? initialJob?.id ?? "");
  const [jobQuery, setJobQuery] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState(
    initial?.invoiceNumber ?? "",
  );
  const [orderNumber, setOrderNumber] = useState(initial?.orderNumber ?? "");
  const [paymentTerms, setPaymentTerms] = useState<PaymentTerm>(
    initial?.paymentTerms ?? "CUSTOM",
  );
  const [description, setDescription] = useState(initial?.description ?? "");
  const [invoiceDate, setInvoiceDate] = useState(
    dateInput(initial?.invoiceDate) || (review ? "" : today || ""),
  );
  const [dueDate, setDueDate] = useState(dateInput(initial?.dueDate));
  const [category, setCategory] = useState(initial?.category ?? "MATERIALS");
  const [currencyOverride, setCurrency] = useState(initial?.currency ?? "");
  const [discount, setDiscount] = useState(String(initial?.discount ?? "0"));
  const [vatRate, setVatRate] = useState(
    String(initial?.vatRate ?? (review ? "" : "5")),
  );
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [lines, setLines] = useState<EditableLine[]>(
    (initial?.lines ?? initial?.lineItems)?.map((line, key) => ({
      key,
      description: line.description,
      quantity: String(line.quantity),
      unitPrice: String(line.unitPrice),
      ...(line.booksSelection ? { booksSelection: line.booksSelection, booksDraft: { ...line.booksSelection } } : {}),
    })) ?? [
      { key: 0, description: "", quantity: review ? "" : "1", unitPrice: "" },
    ],
  );
  const [booksFieldsRevision, setBooksFieldsRevision] = useState(0);
  const usesLineBooks = lines.some((line) => hasBooksLineDraft(line.booksDraft));
  const showBooksLines = !manualEntryOnly || usesLineBooks;
  const [files, setFiles] = useState<InvoiceFileSelection[]>([]);
  const fileSelections = useRef<InvoiceFileSelection[]>([]);
  const [checkingFiles, setCheckingFiles] = useState(false);
  const selectionInFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const [recovery, setRecovery] = useState<"attachment" | "finalize" | null>(null);
  const [savedForSync, setSavedForSync] = useState(false);
  const existingDocuments = bill?.documents ?? bill?.attachments ?? [];
  const uncertainUpload = files.some(file => file.status === "uncertain");
  const calculated = useMemo(() => {
    try {
      const unfinished = lines.findIndex((line) => hasBooksLineDraft(line.booksDraft) && !line.booksSelection);
      if (unfinished >= 0) throw new Error(`Line ${unfinished + 1}: select an account and tax, and choose or clear the optional customer.`);
      return { totals: calculateBill(lines, discount, usesLineBooks ? "0" : vatRate), error: "" };
    } catch (e) {
      return { totals: null, error: errorMessage(e) };
    }
  }, [lines, discount, vatRate, usesLineBooks]);
  const selectedJob = availableJobs.find((job) => job.id === jobId && job.companyId === companyId);
  const selectedVendor = chosenVendor?.id === vendorId && chosenVendor.companyId === companyId
    ? chosenVendor
    : null;
  const vendorResolving = vendorPending?.companyId === companyId && vendorPending.pending;
  const vendorVat = selectedVendor?.booksVat;
  const vendorTaxConflict = !manualEntryOnly && vendorVat?.status === "verified" && hasBooksVendorTaxConflict(vendorVat.taxTreatment,
    usesLineBooks ? lines.map(line => ({ tax_id: line.booksDraft?.taxId && line.booksDraft.taxId !== BOOKS_NO_VAT ? line.booksDraft.taxId : null }))
      : [{ tax_id: Number(vatRate) > 0 ? "configured-vat" : null }]);
  const handleVendorChange = useCallback((vendor: Vendor | null, source: "selection" | "hydration" | "clear") => {
    if (vendor && vendor.companyId !== companyId) return;
    setVendorId(vendor?.id ?? "");
    setChosenVendor(vendor);
    if (source === "selection" && vendor && !jobId) setCurrency(vendor.currency);
  }, [companyId, jobId]);
  const handleVendorPending = useCallback((pending: boolean) => {
    setVendorPending((current) => {
      if (!pending && current?.companyId !== companyId) return current;
      return { companyId, pending };
    });
  }, [companyId]);
  function refreshVendor() {
    if (!vendorId || busy) return;
    setChosenVendor(null);
    setVendorPending({ companyId, pending: true });
    setVendorLookupRevision(current => current + 1);
  }
  const currency = review
    ? currencyOverride
    : currencyOverride ||
      selectedJob?.currency ||
      selectedVendor?.currency ||
      "AED";
  const booksDestinations = (integrations.data?.zoho.organizations ?? []).filter(
    (destination) => destination.companyId === companyId,
  );
  const booksDestination =
    booksDestinations.length === 1 ? booksDestinations[0] : undefined;
  const vendorCurrencyMismatch =
    selectedVendor && selectedVendor.currency !== currency;
  let effectiveDueDate = dueDate;
  let termsError = "";
  if (invoiceDate) {
    try {
      effectiveDueDate = resolveDueDate(invoiceDate, paymentTerms, dueDate);
    } catch (e) {
      termsError = errorMessage(e);
    }
  }
  const exactJobSearch = parseExactJobSearch(jobQuery);
  const matchingJobs =
    availableJobs.filter(
      (job) =>
        job.companyId === companyId &&
        (exactJobSearch ? matchesExactJobSearch(exactJobSearch, job) : job.id === jobId ||
          `${job.id} ${job.externalCrmId ?? ""} ${job.jobNumber} ${job.name} ${job.customer}`
            .toLowerCase()
            .includes(jobQuery.toLowerCase())),
    ) ?? [];
  const hiddenSelectedJob = availableJobs.find(job => job.id === jobId && job.companyId === companyId &&
    !matchingJobs.some(match => match.id === job.id));
  function updateLine(
    key: number,
    field: "description" | "quantity" | "unitPrice",
    value: string,
  ) {
    setLines((current) =>
      current.map((line) =>
        line.key === key ? { ...line, [field]: value } : line,
      ),
    );
  }
  function updateBooksLine(key: number, draft: BooksLineDraft) {
    setLines((current) => current.map((line) => line.key === key
      ? { ...line, booksDraft: draft, booksSelection: booksLineSelection(draft) } : line));
  }
  function clearBooksLines() {
    setLines((current) => current.map((line) => ({ ...line, booksDraft: undefined, booksSelection: null })));
    setBooksFieldsRevision((current) => current + 1);
  }
  function replaceFiles(next: InvoiceFileSelection[]) {
    fileSelections.current = next;
    setFiles(next);
  }
  function updateFile(id: string, patch: Partial<InvoiceFileSelection>) {
    replaceFiles(fileSelections.current.map(file => file.id === id ? { ...file, ...patch } : file));
  }
  async function selectAttachments(selected: File[]) {
    if (busy || selectionInFlight.current || uncertainUpload || finalizedEdit) return;
    if (selected.length > MAX_INVOICE_ATTACHMENTS || selected.some(file => file.size < 8 || file.size > MAX_INVOICE_FILE_BYTES ||
      !["application/pdf", "image/jpeg", "image/png"].includes(file.type))) {
      setError(`Choose PDF, JPEG or PNG originals, up to ${MAX_INVOICE_ATTACHMENTS} files and ${MAX_INVOICE_TOTAL_BYTES / 1_000_000} MB total.`);
      return;
    }
    selectionInFlight.current = true;
    setCheckingFiles(true);
    try {
      const additions = await Promise.all(selected.map(async file => {
        const bytes = await file.arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return { id: Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join(""), file, status: "pending" as const };
      }));
      const merged = [...fileSelections.current];
      for (const file of additions) if (!merged.some(current => current.id === file.id)) merged.push(file);
      const bytes = merged.reduce((sum, file) => sum + file.file.size, 0) + existingDocuments.reduce((sum, document) => sum + (document.byteSize ?? 0), 0);
      if (merged.length + existingDocuments.length > MAX_INVOICE_ATTACHMENTS || bytes > MAX_INVOICE_TOTAL_BYTES)
        throw new Error(`Keep up to ${MAX_INVOICE_ATTACHMENTS} originals and ${MAX_INVOICE_TOTAL_BYTES / 1_000_000} MB total, including files already saved to this bill.`);
      replaceFiles(merged);
      setError("");
    } catch (failure) { setError(errorMessage(failure)); }
    finally { selectionInFlight.current = false; setCheckingFiles(false); }
  }
  function removeAttachment(id: string) {
    if (busy || checkingFiles || uncertainUpload) return;
    replaceFiles(fileSelections.current.filter(file => file.id !== id || file.status === "stored"));
  }
  async function attach(id: string, startingVersion: number) {
    let expectedVersion = startingVersion;
    for (const file of fileSelections.current.filter(file => file.status !== "stored")) {
      updateFile(file.id, { status: "uploading", message: undefined });
      try {
        const data = new FormData();
        data.set("file", file.file);
        const result = await api<{ document: { id: string; billVersion: number; alreadyAttached: boolean } }>(`/api/bills/${id}/attachment`, {
          method: "POST", headers: { "x-bill-version": String(expectedVersion) }, body: data,
        });
        const document = result?.document;
        if (!document?.id || (document.billVersion !== expectedVersion + 1 && !(document.alreadyAttached && document.billVersion === expectedVersion)))
          throw new Error("The original upload result could not be verified. Keep this file and retry the saved bill before changing attachments.");
        expectedVersion = document.billVersion;
        setSavedVersion(expectedVersion);
        updateFile(file.id, { status: "stored", documentId: document.id, message: undefined });
      } catch (failure) {
        const rejected = failure instanceof ApiError && [413, 415, 422].includes(failure.status);
        updateFile(file.id, { status: rejected ? "rejected" : "uncertain", message: errorMessage(failure) });
        throw failure;
      }
    }
    return expectedVersion;
  }
  async function finalize(id: string, expectedVersion: number) {
    const { bill: current } = await api<{ bill: Bill }>(`/api/bills/${id}`);
    if (current.version !== expectedVersion || !["DRAFT", "REJECTED", "PENDING_APPROVAL"].includes(current.status))
      throw new Error("This saved bill changed. Open it and review its current details before continuing.");
    const result = await api<{ bill?: Bill } | null>(`/api/bills/${id}/actions`, {
      method: "POST",
      body: JSON.stringify({ action: "submit", version: expectedVersion }),
    });
    return result?.bill ?? null;
  }
  function openSavedBill(id: string, isDraft: boolean, completedBill?: Bill | null) {
    if (!isDraft && !bill && !review && ["ADMIN", "ACCOUNTS"].includes(user.role)) {
      router.push(`/bills/${encodeURIComponent(id)}/payment?entry=1&saved=1`);
      router.refresh();
      return;
    }
    if (repeatJobEntry && onSaved) {
      onSaved({ id, invoiceNumber, isDraft, outcome: savedBillState(completedBill, { id, companyId, jobId }) });
      return;
    }
    router.push(`/bills/${id}?saved=1`);
    router.refresh();
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || checkingFiles || selectionInFlight.current || saveInFlight.current || savedId) return;
    const submitter = (event.nativeEvent as SubmitEvent)
      .submitter as HTMLButtonElement | null;
    const submit = submitter?.value !== "draft";
    setError("");
    if (submit && vendorTaxConflict) {
      setError(BOOKS_VENDOR_VAT_REVIEW_MESSAGE);
      return;
    }
    if (submit && !review && !finalizedEdit && !existingDocuments.length && !fileSelections.current.length) {
      setError("Attach the original invoice before final save. You can save an unfinished draft without an attachment.");
      return;
    }
    if (manualEntryOnly && usesLineBooks) {
      setError("Clear the Books line selections before saving in manual entry mode. Review the invoice VAT rate after clearing them.");
      return;
    }
    if (!companyId) {
      setError("Select a company before saving.");
      return;
    }
    if (repeatJobEntry && (companyId !== initialJob?.companyId || jobId !== initialJob.id)) {
      setError("The selected job changed. Return to job search before adding a bill.");
      return;
    }
    if (vendorResolving) {
      setError("Wait for the vendor selection to finish before saving.");
      return;
    }
    if (!vendorId || !selectedVendor) {
      setError("Select a vendor from the suggestions before saving.");
      return;
    }
    if (review && !confirmed) {
      setError(
        "Review the original invoice and confirm all fields before saving.",
      );
      return;
    }
    if (review && (!currency || (!usesLineBooks && !vatRate.trim()))) {
      setError(
        "Confirm the currency and VAT rate from the original invoice before saving.",
      );
      return;
    }
    if (termsError) {
      setError(termsError);
      return;
    }
    if (finalizedEdit && paymentTerms === "CUSTOM" && !effectiveDueDate) {
      setError("Choose a due date or select a known payment term before updating this finalized bill.");
      return;
    }
    if (!calculated.totals) {
      setError(calculated.error);
      return;
    }
    if (selectedJob && selectedJob.currency !== currency) {
      setError("The bill currency must match the selected job currency.");
      return;
    }
    if (vendorCurrencyMismatch) {
      setError("Bill, vendor and job currencies must match. Currency conversion is not configured.");
      return;
    }
    saveInFlight.current = true;
    setBusy(true);
    try {
      const payload = {
        companyId,
        vendorId,
        jobId,
        invoiceNumber,
        orderNumber,
        paymentTerms,
        description,
        invoiceDate,
        dueDate: effectiveDueDate,
        category,
        currency,
        discount,
        vatRate: usesLineBooks ? calculated.totals.vatRate : vatRate,
        notes,
        lines: lines.map(({ description, quantity, unitPrice, booksSelection }) => ({
          description,
          quantity,
          unitPrice,
          ...(booksSelection !== undefined ? { booksSelection } : {}),
        })),
        // Manual originals upload after persistence. Finalize only after that upload succeeds.
        // OCR review attaches its retained original and finalizes atomically on the server.
        submit: review ? submit : false,
        ...(bill ? { version: bill.version } : {}),
      };
      const result = await api<{ bill: Bill }>(
        review
          ? `/api/ocr/documents/${review.documentId}/review`
          : bill
            ? `/api/bills/${bill.id}`
            : "/api/bills",
        {
          method: bill ? "PATCH" : "POST",
          body: JSON.stringify(
            review
              ? {
                  version: review.version,
                  bill: payload,
                  confirmed,
                  ...(review.mode ? { mode: review.mode } : {}),
                }
              : payload,
          ),
        },
      );
      setSavedId(result.bill.id);
      setSavedVersion(result.bill.version);
      if (finalizedEdit) {
        openSavedBill(result.bill.id, false, result.bill);
        return;
      }
      setSavedForSync(submit && !review);
      let attachmentVersion: number;
      try {
        attachmentVersion = await attach(result.bill.id, result.bill.version);
      } catch (e) {
        setRecovery("attachment");
        setError(
          `Your draft was saved and has not been queued. The remaining original files could not be uploaded: ${errorMessage(e)}`,
        );
        setBusy(false);
        return;
      }
      const expectedVersion = attachmentVersion;
      setSavedVersion(expectedVersion);
      let completedBill: Bill | null = result.bill;
      if (submit && !review) {
        try {
          completedBill = await finalize(result.bill.id, expectedVersion);
        } catch (e) {
          setRecovery("finalize");
          setError(`Your bill and attachment are saved. ${saveLabel} could not finish: ${errorMessage(e)}`);
          setBusy(false);
          return;
        }
      }
      openSavedBill(result.bill.id, !submit, completedBill);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    } finally {
      saveInFlight.current = false;
    }
  }
  async function resumeSavedBill() {
    if (!savedId || savedVersion === null || busy || saveInFlight.current) return;
    saveInFlight.current = true;
    setBusy(true);
    setError("");
    let nextStep = recovery;
    let expectedVersion = savedVersion;
    try {
      if (recovery === "attachment") {
        const attachmentVersion = await attach(savedId, expectedVersion);
        expectedVersion = attachmentVersion;
        setSavedVersion(expectedVersion);
        nextStep = savedForSync ? "finalize" : null;
        setRecovery(nextStep);
      }
      const completedBill = savedForSync ? await finalize(savedId, expectedVersion) : null;
      openSavedBill(savedId, !savedForSync, completedBill);
    } catch (e) {
      setRecovery(nextStep ?? "finalize");
      setError(`Your bill remains saved. ${errorMessage(e)}`);
      setBusy(false);
    } finally {
      saveInFlight.current = false;
    }
  }
  if (user.role === "MANAGEMENT")
    return (
      <Notice>
        Bill entry is available to authorized finance and data entry staff.
      </Notice>
    );
  if (bill && !(bill.editEligibility?.allowed ?? ["DRAFT", "REJECTED"].includes(bill.status)))
    return (
      <Notice>
        {bill.editEligibility?.reason ?? "This bill is no longer editable."}{" "}
        <Link className="text-link" href={`/bills/${bill.id}`}>
          Return to bill
        </Link>
      </Notice>
    );
  return (
    <section className={`books-bill-page${repeatJobEntry ? " books-job-entry" : ""}`}>
      <header className="books-bill-header">
        <div>
          <ReceiptText size={25} strokeWidth={1.6} />
          <h1>
            {review?.mode === "manual"
              ? "Enter bill from original"
              : review
                ? "Verify extracted bill"
                : bill
                  ? "Edit Bill"
                  : "New Bill"}
          </h1>
        </div>
        {repeatJobEntry ? <Button type="button" variant="secondary" size="sm" disabled={busy || checkingFiles}
          onClick={() => router.push("/bills/manual")}>
          <ArrowLeft size={15} />Back to job search
        </Button> : <Link
          href={bill ? `/bills/${bill.id}` : "/bills"}
          className="icon-button"
          aria-label="Close bill form"
        >
          <X size={21} />
        </Link>}
      </header>
      {previousSave && initialJob && <div className="books-form-notice" ref={receiptNotice}
        tabIndex={-1} role="group" aria-label="Saved bill confirmation">
        <SavedBillOutcome key={previousSave.id} receipt={previousSave} job={initialJob} manualEntryOnly={manualEntryOnly} />
      </div>}
      {error && (
        <div className="books-form-notice">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {recovery && savedId ? (
        <Card className="saved-recovery">
          <CheckCircle2 size={28} />
          <h2>Your financial data is safely saved</h2>
          <p>
            {recovery === "attachment"
              ? "The bill remains a draft until its originals are stored. Completed uploads stay saved. Retry the remaining files, or open the saved draft."
              : `Retry ${saveLabel} for this saved bill, or open it to inspect its current status.`}
            {" "}Do not create the bill again.
          </p>
          {recovery === "attachment" && <InvoiceAttachmentPicker id="recovery-invoice-files" files={files} existing={existingDocuments}
            busy={busy} checking={checkingFiles} locked={uncertainUpload} onFiles={selectAttachments} onRemove={removeAttachment} />}
          <div className="button-row">
            <Button onClick={resumeSavedBill} disabled={busy || checkingFiles || (recovery === "attachment" && !files.length && !existingDocuments.length)}>
              {busy && <LoaderCircle className="spin" size={16} />}
              {recovery === "attachment" ? files.filter(file => file.status !== "stored").length > 1 ? "Retry attachments"
                : files.some(file => file.status !== "stored") ? "Retry attachment" : "Finish saved bill" : `Retry ${saveLabel}`}
            </Button>
            {busy ? <Button variant="secondary" disabled>Open saved bill</Button> : <Button variant="secondary" asChild>
              <Link href={`/bills/${savedId}`}>Open saved bill</Link>
            </Button>}
          </div>
        </Card>
      ) : (
        <form onSubmit={save} className="books-bill-form">
          <fieldset disabled={busy} className="books-form-fields">
            <legend className="sr-only">Bill details</legend>
            <div className="books-company-section books-form-row">
              <CompanySelect
                id="bill-company"
                value={companyId}
                disabled={!!bill || !!review || repeatJobEntry}
                onChange={(value) => {
                  setCompanyId(value);
                  setVendorId("");
                  setChosenVendor(null);
                  setVendorPending(null);
                  setJobId("");
                  clearBooksLines();
                }}
              />
            </div>
            {finalizedEdit && <div className="books-form-notice"><Notice>
              Changes keep this bill&apos;s company, job, currency, recorded payments and original files.
              {manualEntryOnly ? "" : " A synchronized bill is updated against its existing Zoho Books bill ID."}
            </Notice></div>}
            {companyId && !manualEntryOnly && (
              <div className="books-form-notice" aria-label="Books synchronization readiness">
                <Notice>
                  <strong>Zoho Books connection and posting</strong>
                  <p>Vendor, account, tax and customer lookups use read access. Loading these options does not enable bill posting.</p>
                  {integrations.loading ? (
                    <p>Checking this company&apos;s Books setup…</p>
                  ) : integrations.error ? (
                    <>
                      <p>Books setup could not be checked. You can still save this bill locally.</p>
                      <Button type="button" variant="secondary" onClick={integrations.reload}>
                        Retry Books setup check
                      </Button>
                    </>
                  ) : booksDestinations.length === 0 ? (
                    <p>Books sync is unavailable for this company. Ask your administrator to assign its Books destination. You can still save the bill locally.</p>
                  ) : booksDestinations.length > 1 ? (
                    <p>This company has more than one Books destination. Save the bill, then select the intended Books organization on the saved bill before queuing synchronization.</p>
                  ) : booksDestination?.writeEnabled ? (
                    <p>Posting is enabled for {booksDestination.name}. Save and sync will attempt to queue the completed bill; account, tax and supplier checks still apply. The bill is synchronized only after Zoho Books confirms it.</p>
                  ) : booksDestination ? (
                    <p>Books sync is unavailable for {booksDestination.name}. {booksSetupSteps(booksDestination)} You can still save the bill locally.</p>
                  ) : null}
                </Notice>
              </div>
            )}
            <section
              className="books-vendor-section"
              aria-label="Vendor details"
            >
              <div className="books-vendor-row">
                <div className="books-form-row">
                  <Field label="Vendor Name" htmlFor="bill-vendor" required>
                    <div className="books-vendor-control">
                      <VendorAutocomplete
                        key={`${companyId}:${vendorLookupRevision}`}
                        id="bill-vendor"
                        companyId={companyId}
                        value={vendorId}
                        onChange={handleVendorChange}
                        onPendingChange={handleVendorPending}
                        disabled={busy}
                      />
                      {selectedVendor && (
                        <p className="books-vendor-info">
                          {selectedVendor.trn
                            ? `TRN: ${selectedVendor.trn}`
                            : "No tax registration number recorded"}
                          {selectedVendor.email && <span className="books-vendor-email">{selectedVendor.email}</span>}
                          {vendorVat && <span className="books-vendor-email">Zoho VAT status: {vendorVat.status === "verified"
                            ? vendorVat.taxTreatment === "vat_registered" ? "VAT registered" : vendorVat.taxTreatment === "vat_not_registered" ? "VAT not registered" : "Not confirmed"
                            : "Not confirmed"}</span>}
                        </p>
                      )}
                    </div>
                  </Field>
                </div>
                <Field
                  label="Currency"
                  htmlFor="bill-currency"
                  hint={
                    review && !currency
                      ? "Select the currency on the original invoice."
                      : undefined
                  }
                >
                  <Select
                    id="bill-currency"
                    disabled={finalizedEdit}
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    required
                  >
                    {review && <option value="">Select currency</option>}
                    {["AED", "USD", "EUR", "GBP", "SAR"].map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </Select>
                </Field>
              </div>
              {vendorCurrencyMismatch && (
                <Notice tone="error">
                  The selected vendor uses {selectedVendor.currency}. Bill, vendor and job currencies must match; currency conversion is not configured.
                </Notice>
              )}
              {vendorTaxConflict && <Notice tone="error">
                <p>{BOOKS_VENDOR_VAT_REVIEW_MESSAGE}</p>
                <p>{finalizedEdit ? "The existing bill remains saved. Review the supplier and original invoice before applying these changes."
                  : "You can save an unfinished draft while the supplier or invoice is reviewed."}</p>
                <Button type="button" variant="secondary" disabled={busy || vendorResolving} onClick={refreshVendor}>Retry supplier check</Button>
              </Notice>}
              {!manualEntryOnly && vendorVat?.status === "unavailable" && <Notice>
                <p>{vendorVat.warning ?? "The supplier VAT status could not be checked. Final save will verify it again; save a draft if verification remains unavailable."}</p>
                <Button type="button" variant="secondary" disabled={busy || vendorResolving} onClick={refreshVendor}>Retry supplier check</Button>
              </Notice>}
            </section>

            <section
              className="books-meta-section"
              aria-label="Invoice information"
            >
              <div className="books-form-row">
                <Field label="Bill#" htmlFor="invoice-number" required>
                  <Input
                    id="invoice-number"
                    value={invoiceNumber}
                    onChange={(e) => setInvoiceNumber(e.target.value)}
                    placeholder="Vendor's bill number"
                    maxLength={120}
                    required
                  />
                </Field>
              </div>
              <div className="books-form-row">
                <Field label="Order Number" htmlFor="bill-order">
                  <Input
                    id="bill-order"
                    value={orderNumber}
                    onChange={(e) => setOrderNumber(e.target.value)}
                    maxLength={120}
                    placeholder="Purchase order reference"
                  />
                </Field>
              </div>
              <div className="books-form-row">
                <Field label="Bill Date" htmlFor="invoice-date" required>
                  <Input
                    id="invoice-date"
                    type="date"
                    value={invoiceDate}
                    onChange={(e) => setInvoiceDate(e.target.value)}
                    min="1900-01-01"
                    max="2199-12-31"
                    required
                  />
                </Field>
              </div>
              <div className="books-date-payment-row">
                <div className="books-form-row">
                  <Field label="Due Date" htmlFor="due-date" hint={finalizedEdit && paymentTerms === "CUSTOM"
                    ? "A finalized bill needs an explicit due date or a known payment term before its Books details can be updated." : undefined}>
                    <Input
                      id="due-date"
                      type="date"
                      value={effectiveDueDate}
                      min={invoiceDate}
                      max="2199-12-31"
                      onChange={(e) => {
                        setDueDate(e.target.value);
                        setPaymentTerms("CUSTOM");
                      }}
                    />
                  </Field>
                </div>
                <Field label="Payment Terms" htmlFor="bill-payment-terms">
                  <Select
                    id="bill-payment-terms"
                    value={paymentTerms}
                    onChange={(e) => {
                      setDueDate(effectiveDueDate);
                      setPaymentTerms(e.target.value as PaymentTerm);
                    }}
                  >
                    {PAYMENT_TERMS.map((term) => (
                      <option key={term.value} value={term.value}>
                        {term.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              {termsError && (
                <p className="books-field-error" role="alert">
                  {termsError}
                </p>
              )}
              <div className="books-form-row">
                <Field label="Description" htmlFor="bill-description">
                  <Input
                    id="bill-description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={1000}
                    placeholder="What is this bill for? (optional)"
                  />
                </Field>
              </div>
            </section>

            <section
              className="books-allocation-section"
              aria-label="Job allocation"
            >
              {jobs.error && (
                <ErrorState message={jobs.error} retry={jobs.reload} />
              )}
              <div className="books-form-row">
                <Field label="Job / project" htmlFor="bill-job" required>
                  <div className="books-job-control">
                    {!repeatJobEntry && !finalizedEdit && <Input
                      id="job-search"
                      aria-label="Search job ID or name"
                      value={jobQuery}
                      onChange={(e) => setJobQuery(e.target.value)}
                      placeholder="Full job ID or part of its name"
                    />}
                    <Select
                      id="bill-job"
                      required
                      value={jobId}
                      onChange={(e) => {
                        setJobId(e.target.value);
                        const selected = availableJobs.find(
                          (job) => job.id === e.target.value,
                        );
                        if (selected) setCurrency(selected.currency);
                      }}
                      disabled={jobs.loading || repeatJobEntry || finalizedEdit}
                    >
                      <option value="">
                        {jobs.loading ? "Loading jobs…" : "Select a job"}
                      </option>
                      {hiddenSelectedJob && <option value={hiddenSelectedJob.id} hidden>
                        {hiddenSelectedJob.jobNumber} · {hiddenSelectedJob.name}
                      </option>}
                      {matchingJobs.map((job) => (
                        <option key={job.id} value={job.id}>
                          {job.jobNumber} · {job.name}
                        </option>
                      ))}
                    </Select>
                    {selectedJob && (
                      <p className="books-job-customer">
                        Customer: {selectedJob.customer}
                      </p>
                    )}
                  </div>
                </Field>
              </div>
              <div className="books-form-row">
                <Field
                  label="Expense Category"
                  htmlFor="bill-category"
                  required
                >
                  <Select
                    id="bill-category"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    required
                  >
                    {[
                      "MATERIALS",
                      "LABOUR",
                      "EQUIPMENT",
                      "TRANSPORT",
                      "OTHER",
                    ].map((c) => (
                      <option key={c} value={c}>
                        {c.charAt(0) + c.slice(1).toLowerCase()}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </section>

            <section
              className="books-items-section"
              aria-label="Bill line items"
            >
              <div className="books-item-toolbar">
                <span>
                  Item Rates Are <strong>Tax Exclusive</strong>
                </span>
                <span>Currency: {currency}</span>
              </div>
              {showBooksLines && <div className="books-options-status" aria-label="Books line options">
                {manualEntryOnly ? <p>Clear these previous Books selections and confirm the invoice VAT rate to save manually.</p> : <>
                {!companyId ? <p>Select a company to load its Books accounts, taxes and customers.</p>
                  : booksOptions.loading ? <p role="status">Loading Books accounts, taxes and customers…</p>
                    : booksOptionsError || booksCatalog?.warning ? <div role={booksOptionsError ? "alert" : "status"}>
                      <p>{booksOptionsError || booksCatalog?.warning}</p>
                    </div> : null}
                {companyId && <Button type="button" variant="secondary" disabled={booksOptions.loading} onClick={booksOptions.reload}>
                  {booksOptionsError || booksCatalog?.warning ? "Retry Books options" : "Reload Books options"}
                </Button>}
                <p>For Books line selections, choose an account and either a tax or {BOOKS_NO_VAT_NAME} on every line. Customer attribution is optional; the local job remains required.</p>
                </>}
                {usesLineBooks && <Button type="button" variant="ghost" onClick={clearBooksLines}>Clear all Books selections</Button>}
              </div>}
              <Table>
                <thead>
                  <tr>
                    <th className="books-item-description">Item Details</th>
                    {showBooksLines && <th>Account</th>}
                    <th className="align-right">Quantity</th>
                    <th className="align-right">Rate</th>
                    {showBooksLines && <th>Tax</th>}
                    <th className="align-right">Amount</th>
                    {showBooksLines && <th>Customer Name</th>}
                    <th>
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => (
                    <tr key={line.key}>
                      <td>
                        <Textarea
                          aria-label={`Line ${index + 1} description`}
                          placeholder="Enter an item or service description"
                          value={line.description}
                          onChange={(e) =>
                            updateLine(line.key, "description", e.target.value)
                          }
                          required
                          maxLength={500}
                          rows={2}
                        />
                      </td>
                      {showBooksLines && <td className="books-line-account">
                        <BooksLinePicker key={`account:${companyId}:${booksFieldsRevision}`} kind="account" lineNumber={index + 1}
                          companyId={companyId} draft={line.booksDraft} catalog={booksCatalog} loading={booksOptions.loading}
                          error={booksOptionsError} retry={booksOptions.reload} disabled={busy || manualEntryOnly}
                          onChange={(draft) => updateBooksLine(line.key, draft)} />
                      </td>}
                      <td>
                        <Input
                          aria-label={`Line ${index + 1} quantity`}
                          type="number"
                          inputMode="decimal"
                          min="0.001"
                          step="0.001"
                          value={line.quantity}
                          onChange={(e) =>
                            updateLine(line.key, "quantity", e.target.value)
                          }
                          required
                          className="quantity-input"
                        />
                      </td>
                      <td>
                        <Input
                          aria-label={`Line ${index + 1} unit price`}
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="0.01"
                          value={line.unitPrice}
                          onChange={(e) =>
                            updateLine(line.key, "unitPrice", e.target.value)
                          }
                          required
                          className="price-input"
                        />
                      </td>
                      {showBooksLines && <td className="books-line-tax">
                        <BooksLinePicker key={`tax:${companyId}:${booksFieldsRevision}`} kind="tax" lineNumber={index + 1}
                          companyId={companyId} draft={line.booksDraft} catalog={booksCatalog} loading={booksOptions.loading}
                          error={booksOptionsError} retry={booksOptions.reload} disabled={busy || manualEntryOnly}
                          onChange={(draft) => updateBooksLine(line.key, draft)} />
                      </td>}
                      <td className="align-right table-money">
                        {calculated.totals
                          ? money(
                              calculated.totals.lines[index].lineTotal,
                              currency,
                            )
                          : "—"}
                      </td>
                      {showBooksLines && <td className="books-line-customer">
                        <BooksLinePicker key={`customer:${companyId}:${booksFieldsRevision}`} kind="customer" lineNumber={index + 1}
                          companyId={companyId} draft={line.booksDraft} catalog={booksCatalog} loading={booksOptions.loading}
                          error={booksOptionsError} retry={booksOptions.reload} disabled={busy || manualEntryOnly}
                          onChange={(draft) => updateBooksLine(line.key, draft)} />
                      </td>}
                      <td>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove line ${index + 1}`}
                          disabled={lines.length <= 1}
                          onClick={() =>
                            setLines((current) =>
                              current.filter((item) => item.key !== line.key),
                            )
                          }
                        >
                          <Trash2 size={16} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Button
                type="button"
                variant="ghost"
                className="books-add-line"
                disabled={lines.length >= 100}
                onClick={() =>
                  setLines((current) => [
                    ...current,
                    {
                      key: Math.max(...current.map((line) => line.key)) + 1,
                      description: "",
                      quantity: "1",
                      unitPrice: "",
                    },
                  ])
                }
              >
                <Plus size={16} />
                Add another line
              </Button>
            </section>

            <section
              className="books-bottom-section"
              aria-label="Notes and totals"
            >
              <div className="books-notes-documents">
                <Field label="Notes" htmlFor="bill-notes">
                  <Textarea
                    id="bill-notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={4}
                    maxLength={4000}
                    placeholder="Add a note for the accounts team…"
                  />
                </Field>
                {!review && <InvoiceAttachmentPicker files={files} existing={existingDocuments} busy={busy}
                  checking={checkingFiles} readOnly={finalizedEdit} onFiles={selectAttachments} onRemove={removeAttachment} />}
                {review && (
                  <Notice>
                    The stored original invoice will be attached automatically.
                    {manualEntryOnly ? " Saving records the verified bill in this workspace." : " Save and sync sends the verified bill to the configured Books workflow."} Saving never records a payment.
                  </Notice>
                )}
              </div>
              <div
                className="books-totals"
                aria-live="polite"
                aria-atomic="true"
              >
                <AmountRow
                  label="Sub Total"
                  value={calculated.totals?.subtotal}
                  currency={currency}
                />
                <div className="books-total-control">
                  <Field label="Discount" htmlFor="bill-discount">
                    <div className="books-money-input">
                      <Input
                        id="bill-discount"
                        aria-label="Discount amount"
                        type="number"
                        min="0"
                        step="0.01"
                        value={discount}
                        onChange={(e) => setDiscount(e.target.value)}
                        required
                      />
                      <span>{currency}</span>
                    </div>
                  </Field>
                </div>
                <AmountRow
                  label="Taxable Amount"
                  value={calculated.totals?.netAmount}
                  currency={currency}
                />
                {!usesLineBooks && <div className="books-total-control">
                  <Field
                    label="VAT Rate"
                    htmlFor="bill-vat"
                    hint={
                      review && !vatRate
                        ? "Enter the verified VAT rate, including 0 for a verified zero-tax invoice."
                        : undefined
                    }
                  >
                    <div className="books-money-input">
                      <Input
                        id="bill-vat"
                        aria-label="VAT rate (%)"
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        value={vatRate}
                        onChange={(e) => setVatRate(e.target.value)}
                        required
                      />
                      <span>%</span>
                    </div>
                  </Field>
                </div>}
                <AmountRow
                  label={usesLineBooks ? "VAT (line taxes)" : `VAT (${vatRate || "0"}%)`}
                  value={calculated.totals?.vatAmount}
                  currency={currency}
                />
                <AmountRow
                  label={`Total (${currency})`}
                  value={calculated.totals?.total}
                  currency={currency}
                  strong
                />
                {calculated.error && (usesLineBooks || lines.some((line) => line.unitPrice)) && (
                  <p className="books-field-error" role="status">
                    {calculated.error}
                  </p>
                )}
                <p className="books-tax-note">
                  {usesLineBooks ? `VAT follows each line's tax or ${BOOKS_NO_VAT_NAME} choice. Books line selections require a zero discount.` : "Discount is applied before VAT."}
                </p>
                {Number(discount) > 0 && !usesLineBooks && !manualEntryOnly && (
                  <Notice>
                    Discounted bills can be saved locally, but cannot sync to Zoho Books yet. Keep the original invoice amounts and contact your administrator before synchronization.
                  </Notice>
                )}
                {review?.sourceTotals && (
                  <div
                    className="ocr-totals-comparison"
                    aria-label="Source and verified totals"
                  >
                    <h3>Original extraction vs. your bill</h3>
                    <Table>
                      <thead>
                        <tr>
                          <th>Amount</th>
                          <th>Extracted</th>
                          <th>Calculated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(
                          [
                            ["subtotal", "Subtotal"],
                            ["vatAmount", "VAT"],
                            ["total", "Total"],
                          ] as const
                        ).map(([key, label]) => (
                          <tr key={key}>
                            <td>{label}</td>
                            <td>
                              {review.sourceTotals?.[key] === undefined
                                ? "Not extracted"
                                : money(
                                    review.sourceTotals[key],
                                    review.sourceTotals.currency || currency,
                                  )}
                            </td>
                            <td>
                              {calculated.totals
                                ? money(calculated.totals[key], currency)
                                : "Incomplete"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                    {calculated.totals &&
                      (["subtotal", "vatAmount", "total"] as const).some(
                        (key) =>
                          review.sourceTotals?.[key] &&
                          review.sourceTotals[key] !== calculated.totals?.[key],
                      ) && (
                        <Notice>
                          These totals differ from the original extraction.
                          Check the original invoice and correct any extraction
                          errors before confirming.
                        </Notice>
                      )}
                  </div>
                )}
              </div>
            </section>
            {review && (
              <label className="ocr-confirmation">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  required
                />
                I checked the original invoice, vendor, job, dates, line items
                and totals. These values are verified.
              </label>
            )}
          </fieldset>
          <footer className="books-form-footer">
            <div className="books-footer-actions">
              <Button
                name="intent"
                value="submit"
                type="submit"
                disabled={busy || checkingFiles || vendorResolving || jobs.loading || vendorTaxConflict}
              >
                {busy ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}
                {saveLabel}
              </Button>
              {!finalizedEdit && <Button
                name="intent"
                value="draft"
                type="submit"
                variant="secondary"
                disabled={busy || checkingFiles || vendorResolving || jobs.loading}
              >
                <Save size={15} />
                {review
                  ? review.mode === "manual"
                    ? "Save manual draft"
                    : "Save verified draft"
                  : bill
                    ? "Save changes"
                    : "Save as draft"}
              </Button>}
              <Button
                type="button"
                variant="ghost"
                disabled={busy || checkingFiles}
                onClick={() =>
                  router.push(repeatJobEntry ? "/bills/manual" : bill ? `/bills/${bill.id}` : "/bills")
                }
              >
                {repeatJobEntry ? "Back to job search" : "Cancel"}
              </Button>
            </div>
            <span className="books-entered-by">
              <ShieldCheck size={14} />
              Entered by {user.name}
            </span>
          </footer>
        </form>
      )}
    </section>
  );
}
