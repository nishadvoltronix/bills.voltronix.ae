"use client";

import Link from "next/link";
import { useState } from "react";
import { useUser } from "./app-shell";
import { api, errorMessage, useApi } from "./api";
import { Badge, Button, Card, ErrorState, Field, Input, LoadingPanel, Notice, PageHeader, Table, Textarea } from "./ui";

type ManagedUser = { id: string; name: string; email: string; role: string; active: boolean };

export function AdminUserPasswords() {
  const actor = useUser();
  const state = useApi<{ users: ManagedUser[] }>(actor.role === "ADMIN" ? "/api/account/users" : null);
  const [selected, setSelected] = useState<ManagedUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  if (actor.role !== "ADMIN") return <Notice>Your password is managed by an administrator.</Notice>;
  if (state.loading) return <LoadingPanel />;
  if (state.error || !state.data) return <ErrorState message={state.error ?? "Users could not be loaded."} retry={state.reload} />;

  async function reset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || busy) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    if (values.get("newPassword") !== values.get("confirmation")) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy(true); setError(""); setSuccess("");
    try {
      await api(`/api/account/users/${encodeURIComponent(selected.id)}/password`, { method: "POST", body: JSON.stringify({
        adminCurrentPassword: values.get("adminCurrentPassword"), newPassword: values.get("newPassword"),
        confirmation: values.get("confirmation"), reason: values.get("reason"),
      }) });
      form.reset(); setSelected(null);
      setSuccess(`Password updated for ${selected.name}. Their existing sessions were signed out.`);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  return <>
    <PageHeader eyebrow="ADMINISTRATION" title="User passwords" description="Manage passwords for users assigned to your authorized companies.">
      <Button asChild variant="secondary"><Link href="/account">Your account security</Link></Button>
    </PageHeader>
    {error && <Notice tone="error">{error}</Notice>}
    {success && <Notice tone="success">{success}</Notice>}
    <Card><Table>
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Password</th></tr></thead>
      <tbody>{state.data.users.map(user => <tr key={user.id}>
        <td>{user.name}</td><td>{user.email}</td><td>{user.role.replaceAll("_", " ")}</td>
        <td><Badge>{user.active ? "Active" : "Inactive"}</Badge></td>
        <td>{user.id === actor.id ? <Link href="/account" className="text-link">Change your own password</Link>
          : <Button type="button" variant="secondary" size="sm" disabled={busy || !user.active}
            onClick={() => { setSelected(user); setError(""); setSuccess(""); }}>Reset password</Button>}</td>
      </tr>)}</tbody>
    </Table></Card>
    {selected && <Card className="form-card account-security-form">
      <h2>Reset password for {selected.name}</h2>
      <p className="muted small">{selected.email}. This signs out all of this user’s sessions. Share the replacement privately.</p>
      <form key={selected.id} onSubmit={reset}>
        <Field label="Your current Admin password" htmlFor="admin-reset-current"><Input id="admin-reset-current" name="adminCurrentPassword"
          type="password" autoComplete="current-password" required maxLength={128} disabled={busy} /></Field>
        <Field label="New user password" htmlFor="admin-reset-new" hint="Use a unique password of at least 14 characters."><Input id="admin-reset-new" name="newPassword"
          type="password" autoComplete="new-password" required minLength={14} maxLength={128} disabled={busy} /></Field>
        <Field label="Confirm new user password" htmlFor="admin-reset-confirm"><Input id="admin-reset-confirm" name="confirmation"
          type="password" autoComplete="new-password" required minLength={14} maxLength={128} disabled={busy} /></Field>
        <Field label="Audit reason" htmlFor="admin-reset-reason" hint="Record the reason for the change. Do not include passwords."><Textarea id="admin-reset-reason" name="reason"
          required minLength={10} maxLength={500} rows={3} disabled={busy} /></Field>
        <Button type="submit" disabled={busy}>{busy ? "Updating…" : "Reset password and sign out user"}</Button>{" "}
        <Button type="button" variant="secondary" disabled={busy} onClick={() => setSelected(null)}>Cancel</Button>
      </form>
    </Card>}
  </>;
}
