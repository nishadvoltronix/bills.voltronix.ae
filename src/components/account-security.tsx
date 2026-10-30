"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage } from "./api";
import { Button, Card, Field, Input, Notice, PageHeader } from "./ui";

export function AccountSecurity() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function change(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (data.get("newPassword") !== data.get("confirmation")) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: data.get("currentPassword"),
          newPassword: data.get("newPassword"),
        }),
      });
      router.replace("/login?passwordChanged=1");
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="YOUR ACCOUNT"
        title="Account security"
        description="Changing your password signs out all current sessions."
      />
      {error && <Notice tone="error">{error}</Notice>}
      <Card className="form-card account-security-form">
        <h2>Change password</h2>
        <form onSubmit={change}>
          <Field label="Current password" htmlFor="current-password">
            <Input
              id="current-password"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              maxLength={128}
              required
            />
          </Field>
          <Field
            label="New password"
            htmlFor="new-password"
            hint="Use a unique password of at least 14 characters."
          >
            <Input
              id="new-password"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={14}
              maxLength={128}
              required
            />
          </Field>
          <Field label="Confirm new password" htmlFor="confirm-password">
            <Input
              id="confirm-password"
              name="confirmation"
              type="password"
              autoComplete="new-password"
              minLength={14}
              maxLength={128}
              required
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? "Updating…" : "Update password and sign out"}
          </Button>
        </form>
      </Card>
      <Notice>
        For account recovery or deactivation, contact your administrator. They
        must verify your identity before resetting access.
      </Notice>
    </>
  );
}
