"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage } from "./api";
import { Badge, Button, Card, Notice, PageHeader } from "./ui";

type Organization = {
  id: string;
  name: string;
  authorized: boolean;
  canAuthorize: boolean;
  callbackUrl: string | null;
  reason: string | null;
  accountsOrigin: string | null;
};

/** Direct operator link only. Credential values never enter the browser. */
export function BooksAuthorization({
  organizations,
}: {
  organizations: Organization[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function authorize(organization: Organization) {
    if (pending || !organization.canAuthorize) return;
    setPending(organization.id);
    setError("");
    try {
      const result = await api<{ authorizationUrl: string }>(
        "/api/integrations/oauth/zoho/authorize",
        {
          method: "POST",
          body: JSON.stringify({ organizationId: organization.id }),
        },
      );
      const destination = new URL(result.authorizationUrl);
      if (
        destination.protocol !== "https:" ||
        destination.username ||
        destination.password ||
        destination.origin !== organization.accountsOrigin ||
        destination.pathname !== "/oauth/v2/auth"
      )
        throw new Error(
          "The authorization destination is invalid. Contact your administrator.",
        );
      window.location.assign(destination.toString());
    } catch (cause) {
      setError(errorMessage(cause));
      setPending(null);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="ADMINISTRATOR"
        title="Connect Zoho Books"
        description="Authorize each company separately. Refresh tokens are encrypted and kept on this server."
      />
      <Notice>
        Sign in and accept access on Zoho&apos;s website. You will return here
        to see the updated status and connect the next company. Authorization
        alone does not send a bill or enable live accounting.
      </Notice>
      {error && (
        <Notice tone="error" onClose={() => setError("")}>
          {error}
        </Notice>
      )}
      <div className="form-stack">
        {organizations.length === 0 && (
          <Notice>
            No Books company is assigned to your account. Ask the server
            operator to prepare the intended company assignment.
          </Notice>
        )}
        {organizations.map((organization) => (
          <Card key={organization.id} className="form-card">
            <h2>{organization.name}</h2>
            <p>Books organization: {organization.id}</p>
            <Badge tone={organization.authorized ? "success" : "warning"}>
              {organization.authorized
                ? "Authorization configured"
                : "Authorization required"}
            </Badge>
            {organization.authorized && (
              <p>
                The server has authorization configured. Provider access and
                accounting mappings still need verification before live posting.
              </p>
            )}
            {organization.callbackUrl && (
              <p style={{ overflowWrap: "anywhere" }}>
                Registered redirect URI must match:{" "}
                <code>{organization.callbackUrl}</code>
              </p>
            )}
            {organization.reason && <p>{organization.reason}</p>}
            <Button
              disabled={pending !== null || !organization.canAuthorize}
              onClick={() => void authorize(organization)}
            >
              {pending === organization.id
                ? "Opening Zoho…"
                : `${organization.authorized ? "Reconnect" : "Connect"} ${organization.name}`}
            </Button>
          </Card>
        ))}
        <Button
          variant="secondary"
          disabled={pending !== null}
          onClick={() => router.refresh()}
        >
          Refresh authorization status
        </Button>
      </div>
    </>
  );
}
