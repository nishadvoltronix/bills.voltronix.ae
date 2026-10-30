import type { PaymentTerm } from "@/lib/payment-terms";
import type { BooksSelection } from "@/lib/books-selection";

export type Role = "ADMIN" | "ACCOUNTS" | "DATA_ENTRY" | "MANAGEMENT";
export type User = { id: string; name: string; email: string; role: Role };
export type Company = { id: string; name: string };
export type IntegrationConnection = {
  status: string;
  connected: boolean;
  message: string;
  writeEnabled?: boolean;
  missing?: string[];
  postingMissing?: string[];
  authorization?: {
    callbackUrl: string | null;
    networkEnabled: boolean;
    encryptionKeyReady: boolean;
    missing: string[];
    canAuthorize: boolean;
    reason: string | null;
  };
};
export type BooksConnection = IntegrationConnection & {
  requiresOrganizationSelection?: boolean;
  organizations?: (IntegrationConnection & {
    organizationId: string;
    companyId?: string;
    name: string;
    dataCenter?: string;
    environment?: "sandbox" | "production";
  })[];
};
export type Money = string | number;
export type Vendor = {
  id: string;
  companyId: string;
  name: string;
  email?: string | null;
  trn?: string | null;
  currency: string;
};
export type VendorSuggestion = Omit<Vendor, "id"> & {
  id: string | null;
  booksMappingRequired?: boolean;
  externalVendorId?: string;
  organizationId?: string;
  dataCenter?: string;
  environment?: "sandbox" | "production";
};
export type VendorSearchResult = {
  companyId: string;
  organizationId: string | null;
  vendors: VendorSuggestion[];
  selectedVendor: Vendor | null;
  warning: string | null;
  hasMore: boolean;
};
export type VendorDirectoryEntry = Omit<Vendor, "id"> & {
  id: string | null;
  externalVendorId?: string;
  status: "active" | "inactive" | "local";
  organizationId?: string;
  dataCenter?: string;
  environment?: "production" | "sandbox";
};
export type VendorDirectory = {
  companyId: string;
  organizationId: string | null;
  dataCenter: string | null;
  environment: "production" | "sandbox" | null;
  source: "books" | "local";
  vendors: VendorDirectoryEntry[];
  page: number;
  perPage: 100;
  hasMore: boolean;
  warning: string | null;
};
export type BillBooksOptions = {
  companyId: string;
  organizationId: string | null;
  dataCenter: BooksSelection["dataCenter"] | null;
  environment: BooksSelection["environment"] | null;
  accounts: { id: string; name: string; type: string; selectable: boolean }[];
  taxes: { id: string; name: string; rate: string; selectable: boolean }[];
  customers: { id: string; name: string; currency: string }[];
  warning: string | null;
  hasMoreCustomers: boolean;
};
export type JobSummary = {
  adjustedValue: Money | null;
  recognizedExpenses: Money | null;
  paidExpenses: Money | null;
  outstanding: Money | null;
  remainingBudget: Money | null;
  estimatedProfit: Money | null;
  expensePercentage: Money | null;
  budgetStatus: string;
};
export type Job = {
  id: string;
  companyId: string;
  companyName?: string;
  stage?: string | null;
  sourceUpdatedAt?: string | null;
  externalCrmId?: string | null;
  jobNumber: string;
  name: string;
  customer: string;
  contractValue: Money | null;
  approvedVariations: Money | null;
  currency: string;
  summary?: JobSummary;
  bills?: Bill[];
} & Partial<JobSummary>;
export type BillLine = {
  id?: string;
  description: string;
  quantity: Money;
  unitPrice: Money;
  lineTotal?: Money;
  total?: Money;
  booksSelection?: BooksSelection | null;
};
export type AuditEvent = {
  id: string;
  action: string;
  createdAt: string;
  actor?: { name: string; email?: string } | null;
  user?: { name: string } | null;
  entityType?: string;
  entityId?: string;
  billId?: string | null;
  reason?: string | null;
  metadata?: unknown;
  details?: unknown;
};
export type Document = {
  id: string;
  fileName?: string;
  originalName?: string;
  filename?: string;
  createdAt?: string;
};
export type Payment = {
  id: string;
  amount: Money;
  reference?: string | null;
  createdAt: string;
};
export type Bill = {
  id: string;
  companyId: string;
  invoiceNumber: string;
  orderNumber?: string | null;
  paymentTerms?: PaymentTerm;
  invoiceDate: string;
  dueDate?: string | null;
  vendorId: string;
  jobId: string;
  category: string;
  currency: string;
  status: string;
  paymentStatus?: string;
  subtotal?: Money;
  subTotal?: Money;
  discount: Money;
  vatRate: Money;
  vatAmount?: Money;
  total?: Money;
  grandTotal?: Money;
  netTotal?: Money;
  paidAmount?: Money;
  outstanding?: Money;
  notes?: string | null;
  description?: string | null;
  version: number;
  createdAt: string;
  vendor?: Vendor;
  job?: Job;
  createdBy?: User;
  lines?: BillLine[];
  lineItems?: BillLine[];
  documents?: Document[];
  attachments?: Document[];
  payments?: Payment[];
  auditEvents?: AuditEvent[];
  auditLogs?: AuditEvent[];
  syncRecords?: {
    id: string;
    provider?: string;
    target?: string;
    destination?: string;
    organizationId?: string | null;
    externalId?: string | null;
    status: string;
    lastError?: string | null;
  }[];
};
export type Dashboard = {
  metrics: {
    jobValue: Money | null;
    recognizedExpenses: Money | null;
    paidExpenses: Money | null;
    outstanding: Money | null;
    estimatedProfit: Money | null;
    overBudgetCount: number;
    pendingCount: number;
    readyCount?: number;
    draftCount: number;
    missingJobValues?: number;
    invoicedTotal?: Money | null;
    recordedContractValue?: Money | null;
    creditsApplied?: Money | null;
    billCount?: number;
  };
  jobs: Job[];
  jobOptions?: Pick<Job, "id" | "companyId" | "jobNumber" | "name">[];
  recentBills: Bill[];
  recentBooksBills?: ImportedBillSummary[];
  source?: {
    booksBillCount: number;
    nativeBillCount: number;
    excludedDuplicateNativeCount: number;
    unlinkedBooksBillCount: number;
    staleBooksBillCount: number;
    unknownFinancialBillCount: number;
    booksLatestImportAt: string | null;
    booksListingComplete: boolean;
    jobFinancialsComplete: boolean;
    crmJobCount?: number;
    crmReviewJobCount?: number;
    notes: string[];
  };
  currencies?: string[];
  monthlyExpenses: {
    month: string;
    amount?: Money;
    total?: Money;
    expenses?: Money;
  }[];
  vendorExpenses: {
    name?: string;
    vendorName?: string;
    amount?: Money;
    total?: Money;
    expenses?: Money;
  }[];
  currency?: string;
};

export type ImportedBillSummary = {
  id: string;
  billNumber: string;
  companyId: string;
  companyName: string;
  vendorName: string;
  currency: string;
  total: string;
  status: string;
  billDate: string | null;
  jobId: string | null;
  jobNumber: string | null;
  href: string;
  documents?: {
    id: string | null;
    name: string | null;
    attachmentId: string | null;
    downloaded: boolean;
    status: "AVAILABLE" | "PENDING";
    fileName: string | null;
    mimeType: string | null;
    byteSize: number | null;
    downloadedAt: string | null;
  }[];
  attachmentStatus?: "COMPLETE" | "PARTIAL" | "PENDING" | "NONE";
  attachmentCount?: number;
  downloadedAttachmentCount?: number;
  hasAttachment?: boolean;
  attachmentsDownloaded?: boolean;
  relationEvidence?: string;
  allocationKnown?: boolean;
};
export type JobFinancialCompleteness = {
  complete: boolean;
  unlinkedBooksBillCount: number;
  notes: string[];
};
export type JobBooksHistory = {
  verificationPending: boolean;
  warnings: string[];
  refreshPausedUntil: string | null;
};
export type RelatedBillJob = {
  id: string;
  jobNumber: string | null;
  displayReference?: string | null;
  name: string;
  companyId: string;
  companyName: string;
  href?: string;
  canonicalJobId?: string | null;
};
export type DashboardSearchResult = {
  query: string;
  jobs: {
    id: string;
    canonicalJobId: string | null;
    jobNumber: string | null;
    name: string;
    companyId: string | null;
    companyName: string;
    customer: string;
    currency: string;
    canCreateBill: boolean;
    href: string;
    referenceKind?: "JOB" | "CRM_DEAL";
    displayReference?: string | null;
    historyCompanies?: { id: string; name: string }[];
  }[];
  bills: {
    id: string;
    billNumber: string;
    source: "BOOKS" | "NATIVE";
    companyId: string;
    companyName: string;
    vendorName: string;
    currency: string;
    total: Money | null;
    jobId: string | null;
    jobNumber: string | null;
    href: string;
    relatedJobs?: RelatedBillJob[];
  }[];
  hasMore: boolean;
};
