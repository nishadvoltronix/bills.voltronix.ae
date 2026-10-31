"use client";

import Link from "next/link";
import { useLayoutEffect, useRef, useState } from "react";
import { api, errorMessage, useApi } from "./api";
import { Badge, Button, Card, ErrorState, LoadingPanel, Notice, PageHeader } from "./ui";

type CrmAuthorizationStatus = {
  connected: boolean;
  status: "CONNECTED" | "AUTHORIZATION_REQUIRED" | "NOT_CONFIGURED" | "BLOCKED";
  message: string;
  organizationId?: string;
  companies: { id: string; name: string }[];
  authorization: {
    canAuthorize: boolean;
    reason: string | null;
    callbackUrl: string | null;
    networkEnabled: boolean;
    accountsOrigin: string | null;
  };
};

export function CrmAuthorization() {
  const state = useApi<CrmAuthorizationStatus>("/api/integrations/crm/authorization");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); };
  }, []);
  async function authorize() {
    const authorization = state.data?.authorization;
    if (pending || !authorization?.canAuthorize || !authorization.accountsOrigin) return;
    setPending(true);
    setError("");
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await api<{ authorizationUrl: string }>("/api/integrations/oauth/crm/authorize", {
        method: "POST", body: JSON.stringify({}), signal: controller.signal,
      });
      if (!mounted.current || controller.signal.aborted) return;
      const destination = new URL(result.authorizationUrl);
      if (destination.protocol !== "https:" || destination.username || destination.password ||
        destination.origin !== authorization.accountsOrigin || destination.pathname !== "/oauth/v2/auth")
        throw new Error("The authorization destination is invalid. Contact your administrator.");
      window.location.assign(destination.toString());
    } catch (cause) {
      if (!mounted.current || controller.signal.aborted) return;
      setError(errorMessage(cause));
      setPending(false);
    }
  }
  return <>
    <PageHeader eyebrow="ADMINISTRATOR" title="Connect Zoho CRM"
      description="Authorize job lookup and read existing CRM and Zoho Projects relationships for the assigned companies." />
    <Notice>Sign in and approve access on Zoho&apos;s website. Refresh tokens are encrypted and kept on this server. These permissions allow reading existing records and project associations. Authorizing does not create or change jobs, projects or bills in Zoho.</Notice>
    <Card className="form-card">
      <h2>Read permissions requested</h2>
      <ul>
        <li>Zoho CRM: deals, suppliers, search results and organization details.</li>
        <li>CRM custom modules, including Jobs: read existing records and their related records.</li>
        <li>CRM metadata: read field, module and related-list definitions to identify the available record relationships.</li>
        <li>Zoho Projects: portal details and client/customer records, including existing links between projects and CRM jobs.</li>
      </ul>
      <p>Reconnect an existing authorization to approve the added CRM custom-module and related-list metadata read permissions, along with the Zoho Projects read permissions. Existing grants do not gain new permissions automatically.</p>
      <p>Reconnecting allows these source checks. A job&apos;s bill links still need to be verified against the source records before its bill history can appear.</p>
    </Card>
    {error && <Notice tone="error" onClose={() => setError("")}>{error}</Notice>}
    {state.loading ? <LoadingPanel /> : state.error || !state.data ? <ErrorState message={state.error ?? "CRM authorization status is unavailable."} retry={state.reload} />
      : <Card className="form-card crm-authorization-card">
        <h2>Shared CRM authorization</h2>
        <Badge tone={state.data.connected ? "success" : "warning"}>{state.data.connected ? "Authorization saved"
          : state.data.status === "NOT_CONFIGURED" ? "Not configured" : state.data.status === "BLOCKED" ? "Connection unavailable" : "Authorization required"}</Badge>
        <p>{state.data.message}</p>
        {state.data.connected && <p>A saved grant is available. Provider access and source identity are verified when you search for a job.</p>}
        {state.data.organizationId && <p>CRM organization: {state.data.organizationId}</p>}
        {state.data.companies.length ? <>
          <p>Assigned companies:</p>
          <ul>{state.data.companies.map((company) => <li key={company.id}>{company.name.replace(/^\s*\[CONNECTION CHECK\]\s*/i, "")}</li>)}</ul>
        </> : <p>No company is assigned to this CRM source.</p>}
        {state.data.authorization.callbackUrl && <p className="crm-authorization-redirect">Registered redirect URI must match: <code>{state.data.authorization.callbackUrl}</code></p>}
        {state.data.authorization.reason && <p>{state.data.authorization.reason}</p>}
        <Button type="button" disabled={pending || !state.data.authorization.canAuthorize || !state.data.authorization.accountsOrigin} onClick={() => void authorize()}>
          {pending ? "Opening Zoho…" : state.data.connected ? "Reconnect Zoho CRM" : "Connect Zoho CRM"}
        </Button>
      </Card>}
    <div className="button-row">
      <Button type="button" variant="secondary" disabled={pending || state.loading} onClick={state.reload}>Refresh authorization status</Button>
      <Button asChild variant="ghost"><Link href="/bills/manual">Back to manual entry</Link></Button>
    </div>
  </>;
}
