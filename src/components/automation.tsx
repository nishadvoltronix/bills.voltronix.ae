import Link from "next/link";
import {
  ArrowRight,
  ClipboardCheck,
  FileScan,
  Layers3,
  LockKeyhole,
  ScanLine,
  ShieldCheck,
} from "lucide-react";
import { Badge, Button, Card, PageHeader } from "./ui";

export function IntegrationsPage() {
  return (
    <>
      <PageHeader
        eyebrow="CONNECTED OPERATIONS"
        title="Integrations"
        description="External services must be configured and verified before any bill is synchronized."
      />
      <div className="integration-cards">
        {[
          {
            name: "Zoho",
            mark: "Z",
            description:
              "Connect the approved Zoho product and organization to synchronize financial records.",
            requirements: [
              "Confirm the accounting product and bill module",
              "Authorize server-side credentials and required scopes",
              "Verify vendor, job, and account mappings",
              "Test duplicate protection and reconciliation",
            ],
          },
          {
            name: "CRM",
            mark: "C",
            description:
              "Keep job references and expense visibility connected to your existing CRM.",
            requirements: [
              "Confirm the authoritative job and vendor endpoints",
              "Map existing IDs without creating duplicate jobs",
              "Configure scoped server-side API access",
              "Verify acknowledgments and retry behavior",
            ],
          },
        ].map((item) => (
          <Card className="integration-card" key={item.name}>
            <div className="integration-card-top">
              <span
                className={`integration-logo integration-logo-${item.name.toLowerCase()}`}
              >
                {item.mark}
              </span>
              <Badge>Not configured</Badge>
            </div>
            <h2>{item.name}</h2>
            <p>{item.description}</p>
            <div className="integration-requirements">
              <strong>Required before activation</strong>
              {item.requirements.map((r) => (
                <div key={r}>
                  <span className="requirement-circle" />
                  {r}
                </div>
              ))}
            </div>
            <div className="integration-card-bottom">
              <LockKeyhole size={15} />
              <span>Configuration is managed securely on the server.</span>
            </div>
          </Card>
        ))}
      </div>
      <Card className="integration-principles">
        <span className="feature-icon">
          <ShieldCheck size={24} />
        </span>
        <div>
          <h2>Your local records remain the source of truth</h2>
          <p>
            Bills are saved independently of external services. This release
            does not create or update Zoho or CRM records. Future
            synchronization must confirm a remote record ID before showing
            success, and preserve saved bills when an external request fails.
          </p>
        </div>
      </Card>
    </>
  );
}
export function OcrPage({ batch = false }: { batch?: boolean }) {
  const Icon = batch ? Layers3 : ScanLine;
  return (
    <>
      <PageHeader
        eyebrow="DOCUMENT AUTOMATION"
        title={batch ? "Batch bill processing" : "Single bill OCR"}
        description={
          batch
            ? "A review workflow for invoices from multiple vendors."
            : "Turn invoice documents into reviewed bill entries."
        }
      />
      <Card className="automation-hero">
        <span className="automation-icon">
          <Icon size={33} />
        </span>
        <Badge tone="warning">Provider not configured</Badge>
        <h2>
          {batch
            ? "Multiple invoices. One review workflow."
            : "Less typing. The same financial control."}
        </h2>
        <p>
          {batch
            ? "Batch extraction will become available after an OCR provider, background processing, and reviewed vendor mappings are configured."
            : "OCR and AI extraction are not active in this release. You can enter an invoice manually and securely attach its original document."}
        </p>
        <Button asChild>
          <Link href="/bills/new">
            Create a bill manually
            <ArrowRight size={16} />
          </Link>
        </Button>
        <span className="automation-caption">
          No documents are sent to an external provider.
        </span>
      </Card>
      <div className="workflow-grid">
        {[
          {
            icon: FileScan,
            title: batch ? "1. Collect documents" : "1. Add your invoice",
            description: batch
              ? "Images and PDFs enter a tracked batch. Scanner ingestion depends on verified hardware and infrastructure."
              : "An image or PDF will be securely stored and prepared for document extraction.",
          },
          {
            icon: ClipboardCheck,
            title: "2. Review every field",
            description:
              "Check vendor and job matches, invoice totals, and low-confidence fields against the original before saving.",
          },
          {
            icon: ShieldCheck,
            title: "3. Save and sync",
            description:
              "Only reviewed financial data is eligible for posting. Duplicates and inconsistent totals must be resolved first.",
          },
        ].map((step) => (
          <Card className="workflow-card" key={step.title}>
            <step.icon size={24} />
            <h3>{step.title}</h3>
            <p>{step.description}</p>
          </Card>
        ))}
      </div>
      {batch && (
        <Card className="scanner-note">
          <h2>Scanner & network folder ingestion</h2>
          <p>
            Not configured. The scanner model, supported scan destination,
            folder permissions, ingestion service, and failure recovery must be
            verified before automatic imports are enabled. Verified vendor
            templates will require an authorized reviewer.
          </p>
        </Card>
      )}
    </>
  );
}
