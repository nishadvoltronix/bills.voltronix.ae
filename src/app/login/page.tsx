"use client";

import Image from "next/image";
import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import { Button, Input, Notice } from "@/components/ui";
import { api, errorMessage } from "@/components/api";
import type { User } from "@/components/types";
import { loginDestination } from "@/lib/auth-navigation";
import loginLogo from "@/assets/login-logo.png";
import styles from "./login.module.css";

const rememberedEmailKey = "voltronix-bills:login-email";

function readRememberedEmail() {
  try {
    return window.localStorage.getItem(rememberedEmailKey)?.slice(0, 254) ?? "";
  } catch {
    return "";
  }
}

function subscribeToRememberedEmail(update: () => void) {
  window.addEventListener("storage", update);
  return () => window.removeEventListener("storage", update);
}

const emptyEmail = () => "";

export default function LoginPage() {
  const router = useRouter();
  const rememberedEmail = useSyncExternalStore(
    subscribeToRememberedEmail,
    readRememberedEmail,
    emptyEmail,
  );
  const [editedEmail, setEmail] = useState<string | null>(null);
  const email = editedEmail ?? rememberedEmail;
  const [password, setPassword] = useState("");
  const [rememberEmail, setRememberEmail] = useState(true);
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setEmail(email);
    setLoading(true);
    setError("");
    try {
      const result = await api<{ user: User }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      try {
        if (rememberEmail) {
          window.localStorage.setItem(rememberedEmailKey, email.trim());
        } else {
          window.localStorage.removeItem(rememberedEmailKey);
        }
      } catch {
        // Browser storage preferences must never prevent a successful sign-in.
      }
      router.replace(
        loginDestination(
          result.user.role,
          new URLSearchParams(window.location.search).get("next"),
        ),
      );
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      setLoading(false);
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="login-heading">
        <Image
          src={loginLogo}
          alt="VOLTRONIX"
          className={styles.logo}
          loading="eager"
          unoptimized
        />
        <h1 id="login-heading" className={styles.heading}>
          Login to your Workspace
        </h1>
        {error && (
          <div className={styles.error}>
            <Notice tone="error">{error}</Notice>
          </div>
        )}
        <form onSubmit={submit} className={styles.form} aria-busy={loading}>
          <div className={styles.field}>
            <label className="sr-only" htmlFor="email">
              Work email
            </label>
            <Input
              className={styles.input}
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              placeholder="Email Address"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={254}
              disabled={loading}
              required
            />
          </div>
          <div className={[styles.field, styles.password].join(" ")}>
            <label className="sr-only" htmlFor="password">
              Password
            </label>
            <Input
              className={styles.input}
              id="password"
              name="password"
              type={visible ? "text" : "password"}
              autoComplete="current-password"
              placeholder="Password"
              value={password}
              onChange={(event) => {
                setEmail(email);
                setPassword(event.target.value);
              }}
              disabled={loading}
              required
            />
            <button
              className={styles.visibility}
              type="button"
              onClick={() => setVisible(!visible)}
              aria-label={visible ? "Hide password" : "Show password"}
              aria-pressed={visible}
              disabled={loading}
            >
              {visible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <label
            className={styles.remember}
            title="Remember my email on this device"
          >
            <input
              type="checkbox"
              name="rememberEmail"
              checked={rememberEmail}
              aria-describedby="remember-email-help"
              disabled={loading}
              onChange={(event) => {
                setRememberEmail(event.target.checked);
                if (!event.target.checked) {
                  setEmail(email);
                  try {
                    window.localStorage.removeItem(rememberedEmailKey);
                  } catch {
                    // Sign-in also works when browser storage is unavailable.
                  }
                }
              }}
            />
            <span>Remember me?</span>
          </label>
          <span className="sr-only" id="remember-email-help">
            Remember your email address on this device. Your password is never
            saved.
          </span>
          <div className={styles.actions}>
            <Button
              className={styles.submit}
              type="submit"
              disabled={loading}
              aria-label={
                loading ? "Signing in…" : "Login — Sign in to workspace"
              }
            >
              {loading && <LoaderCircle className="spin" size={15} />}
              {loading ? "Signing in…" : "Login"}
            </Button>
          </div>
        </form>
      </section>
    </main>
  );
}
