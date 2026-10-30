"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Eye,
  EyeOff,
  FileCheck2,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { Brand } from "@/components/app-shell";
import { Button, Field, Input, Notice } from "@/components/ui";
import { api, errorMessage } from "@/components/api";
import type { User } from "@/components/types";
import { loginDestination } from "@/lib/auth-navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const result = await api<{ user: User }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
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
    <div className="login-page">
      <section className="login-story">
        <Brand light />
        <div className="login-story-content">
          <div className="login-eyebrow">
            <span />
            FINANCE, WITH CLARITY
          </div>
          <h1>
            Every bill.
            <br />
            Every job.
            <br />
            <span>In one place.</span>
          </h1>
          <p>
            Bring confidence to your financial operations, from the first
            invoice to the final job review.
          </p>
          <div className="login-features">
            <div>
              <span>
                <FileCheck2 size={19} />
              </span>
              <section>
                <strong>Simple bill management</strong>
                <p>Capture, review, and approve with a clear trail.</p>
              </section>
            </div>
            <div>
              <span>
                <TrendingUp size={19} />
              </span>
              <section>
                <strong>See the full job picture</strong>
                <p>Understand your costs and estimated profitability.</p>
              </section>
            </div>
            <div>
              <span>
                <ShieldCheck size={19} />
              </span>
              <section>
                <strong>The right access for every role</strong>
                <p>Secure financial records and accountable changes.</p>
              </section>
            </div>
          </div>
        </div>
        <div className="login-story-footer">
          <span>BUILT FOR VOLTRONIX</span>
          <span>United Arab Emirates</span>
        </div>
        <div className="login-orbit orbit-one" />
        <div className="login-orbit orbit-two" />
      </section>
      <section className="login-form-side">
        <div className="login-mobile-brand">
          <Brand />
        </div>
        <div className="login-form-wrap">
          <div className="login-lock">
            <LockKeyhole size={23} />
          </div>
          <div className="eyebrow">VOLTRONIX BILLS & FINANCE</div>
          <h2>Welcome back</h2>
          <p className="login-description">
            Sign in to your financial workspace.
          </p>
          {error && <Notice tone="error">{error}</Notice>}
          <form onSubmit={submit}>
            <Field label="Work email" htmlFor="email">
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                placeholder="you@voltronix.ae"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </Field>
            <Field label="Password" htmlFor="password">
              <div className="password-field">
                <Input
                  id="password"
                  name="password"
                  type={visible ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  onClick={() => setVisible(!visible)}
                  aria-label={visible ? "Hide password" : "Show password"}
                >
                  {visible ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </Field>
            <Button className="login-submit" type="submit" disabled={loading}>
              {loading ? <LoaderCircle className="spin" size={17} /> : null}
              {loading ? "Signing in…" : "Sign in to workspace"}
              {!loading && <ArrowRight size={17} />}
            </Button>
          </form>
          <div className="login-help">
            Need access or help signing in?
            <br />
            <strong>Contact your workspace administrator.</strong>
          </div>
          <div className="login-security">
            <ShieldCheck size={15} />
            Authorized personnel only · Secure session
          </div>
        </div>
        <footer className="login-footer">
          © VOLTRONIX. All rights reserved.
        </footer>
      </section>
    </div>
  );
}
