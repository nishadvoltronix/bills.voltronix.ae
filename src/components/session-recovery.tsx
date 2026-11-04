"use client";

import { useEffect, useId, useRef, useState } from "react";
import { LoaderCircle, LockKeyhole } from "lucide-react";
import { loginDestination, loginUrl } from "@/lib/auth-navigation";
import { isSessionExpired, restoreSession, SESSION_EXPIRED_EVENT, SESSION_RESTORED_EVENT } from "@/lib/session-recovery";
import { api, errorMessage } from "./api";
import type { User } from "./types";
import { Button, Field, Input, Notice } from "./ui";
import styles from "./session-recovery.module.css";

/** Keep the current page and its unsaved File objects mounted during sign-in. */
export function SessionRecovery({ user }: { user: User }) {
  const titleId = useId(), descriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null), passwordInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const [expired, setExpired] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [changedUser, setChangedUser] = useState<User | null>(null);

  useEffect(() => {
    const expire = () => setExpired(true);
    const restore = () => { setExpired(false); setPassword(""); setError(""); setChangedUser(null); };
    window.addEventListener(SESSION_EXPIRED_EVENT, expire);
    window.addEventListener(SESSION_RESTORED_EVENT, restore);
    // Child requests may fail before AppShell's effects have subscribed.
    if (isSessionExpired()) expire();
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, expire);
      window.removeEventListener(SESSION_RESTORED_EVENT, restore);
    };
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (expired && !element.open) { element.showModal(); passwordInput.current?.focus(); }
    else if (!expired && element.open) element.close();
  }, [expired]);

  function leave(destination: string) {
    window.location.assign(destination);
  }

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || changedUser) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      const result = await api<{ user: User }>("/api/auth/login", {
        method: "POST", body: JSON.stringify({ email: user.email, password }),
      });
      // Credentials stay only in this input and are cleared on every success.
      setPassword("");
      const signedIn = result?.user;
      if (!signedIn || typeof signedIn.id !== "string" || typeof signedIn.email !== "string" ||
        !["ADMIN", "ACCOUNTS", "DATA_ENTRY", "MANAGEMENT"].includes(signedIn.role))
        throw new Error("The sign-in result could not be verified. Use the login page to continue.");
      if (signedIn.id !== user.id || signedIn.role !== user.role || signedIn.email !== user.email) {
        setChangedUser(signedIn);
        setError("Your account or access has changed. Reload the workspace to continue with the signed-in account.");
        return;
      }
      restoreSession();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { submitting.current = false; setBusy(false); }
  }

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => event.preventDefault()} onClose={() => {
      if (isSessionExpired() && dialog.current?.isConnected && !dialog.current.open) dialog.current.showModal();
    }}>
    <div className={styles.heading}><LockKeyhole size={22} /><h2 id={titleId}>Sign in to continue</h2></div>
    <p id={descriptionId}>Your session has expired. Your current entry stays in this tab while you sign in again.</p>
    {error && <Notice tone="error">{error}</Notice>}
    {changedUser ? <>
      <p>Reloading leaves the current unsaved entry and opens the workspace for the signed-in account.</p>
      <Button type="button" onClick={() => leave(loginDestination(changedUser.role, window.location.pathname))}>Reload workspace</Button>
    </> : <form onSubmit={signIn} className={styles.form} aria-busy={busy}>
      <Field label="Work email" htmlFor={`${titleId}-email`}><Input id={`${titleId}-email`} type="email" autoComplete="username" value={user.email} readOnly /></Field>
      <Field label="Password" htmlFor={`${titleId}-password`}><Input ref={passwordInput} id={`${titleId}-password`} type="password"
        autoComplete="current-password" required value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></Field>
      <Button type="submit" disabled={busy}>{busy && <LoaderCircle size={16} className="spin" />}{busy ? "Signing in…" : "Sign in again"}</Button>
    </form>}
    <div className={styles.leave}>
      <p>Opening the login page leaves this unsaved entry.</p>
      <Button type="button" variant="ghost" disabled={busy} onClick={() => leave(loginUrl(window.location.pathname))}>Go to login</Button>
    </div>
  </dialog>;
}
