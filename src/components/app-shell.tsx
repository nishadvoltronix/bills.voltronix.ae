"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  LayoutDashboard,
  ReceiptText,
  BookOpen,
  BriefcaseBusiness,
  Building2,
  ChartNoAxesCombined,
  ShieldCheck,
  History,
  ScanLine,
  Layers3,
  LogOut,
  Menu,
  X,
  ChevronRight,
  LockKeyhole,
} from "lucide-react";
import type { User, Role } from "./types";
import { api, errorMessage } from "./api";
import { Notice } from "./ui";
import { ManualEntryContext, OcrWorkspaceContext } from "./application-mode";
import { accountDisplayName } from "./account-display-name";
import voltronixLogo from "@/assets/voltronix-logo.png";
export { useManualEntryOnly, useOcrWorkspaceEnabled } from "./application-mode";

const UserContext = createContext<User | null>(null);
export function useUser() {
  const user = useContext(UserContext);
  if (!user) throw new Error("Authentication required");
  return user;
}
const all: Role[] = ["ADMIN", "ACCOUNTS", "DATA_ENTRY", "MANAGEMENT"];
const navigation = [
  {
    label: "Overview",
    href: "/dashboard",
    icon: LayoutDashboard,
    roles: all,
    section: "WORKSPACE",
  },
  { label: "Bills & expenses", href: "/bills", icon: ReceiptText, roles: all },
  {
    label: "Zoho Books bills",
    href: "/bills/books",
    icon: BookOpen,
    roles: ["ADMIN", "ACCOUNTS", "MANAGEMENT"],
  },
  {
    label: "Jobs & projects",
    href: "/jobs",
    icon: BriefcaseBusiness,
    roles: all,
  },
  { label: "Vendors", href: "/vendors", icon: Building2, roles: all },
  {
    label: "Management",
    href: "/management",
    icon: ChartNoAxesCombined,
    roles: ["ADMIN", "ACCOUNTS", "MANAGEMENT"],
    section: "INSIGHTS",
  },
  {
    label: "Audit trail",
    href: "/audit",
    icon: History,
    roles: ["ADMIN", "ACCOUNTS"],
  },
  {
    label: "Single bill OCR",
    href: "/ocr",
    icon: ScanLine,
    roles: ["ADMIN", "ACCOUNTS", "DATA_ENTRY"],
    section: "AUTOMATION",
  },
  {
    label: "Batch processing",
    href: "/ocr/batch",
    icon: Layers3,
    roles: ["ADMIN", "ACCOUNTS", "DATA_ENTRY"],
  },
  {
    label: "Account security",
    href: "/account",
    icon: LockKeyhole,
    roles: all,
  },
];
export function Brand({ light = false }: { light?: boolean }) {
  return (
    <div className={`brand ${light ? "brand-light" : ""}`}>
      <Image
        src={voltronixLogo}
        alt="VOLTRONIX"
        className="brand-logo"
        loading="eager"
        unoptimized
      />
    </div>
  );
}
export function AppShell({
  user,
  children,
  manualEntryOnly = false,
  ocrWorkspaceEnabled = false,
}: {
  user: User;
  children: React.ReactNode;
  manualEntryOnly?: boolean;
  ocrWorkspaceEnabled?: boolean;
}) {
  const path = usePathname();
  const router = useRouter();
  const displayName = accountDisplayName(user.name) || user.email;
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    sidebarRef.current
      ?.querySelector<HTMLButtonElement>(".mobile-close")
      ?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
      if (event.key !== "Tab") return;
      const items = Array.from(
        sidebarRef.current?.querySelectorAll<HTMLElement>(
          "a[href],button:not([disabled])",
        ) ?? [],
      ).filter((el) => el.getClientRects().length > 0);
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previous?.focus();
    };
  }, [open]);
  const showOcr = ocrWorkspaceEnabled && !manualEntryOnly;
  const nav = navigation.filter((item) => item.roles.includes(user.role) &&
    (showOcr || !item.href.startsWith("/ocr")));
  const active = [...nav]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => path === item.href || path.startsWith(`${item.href}/`));
  async function logout() {
    setBusy(true);
    try {
      await api("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <UserContext.Provider value={user}>
      <ManualEntryContext.Provider value={manualEntryOnly}>
      <OcrWorkspaceContext.Provider value={showOcr}>
      <div className="app-frame">
        {open && (
          <button
            className="sidebar-backdrop"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
          />
        )}
        <aside
          ref={sidebarRef}
          id="main-navigation"
          role={open ? "dialog" : undefined}
          aria-modal={open ? true : undefined}
          className={`sidebar ${open ? "sidebar-open" : ""}`}
          aria-label="Main navigation"
        >
          <div className="sidebar-brand">
            <Link href="/dashboard" aria-label="Voltronix dashboard">
              <Brand light />
            </Link>
            <button
              className="mobile-close icon-button"
              aria-label="Close menu"
              onClick={() => setOpen(false)}
            >
              <X size={20} />
            </button>
          </div>
          <div className="workspace-label">
            <span className="workspace-avatar">V</span>
            <div>
              <strong>Voltronix workspace</strong>
              <span>Finance operations</span>
            </div>
            <LockKeyhole size={13} />
          </div>
          <nav>
            {nav.map((item) => {
              const Icon = item.icon;
              const selected = active?.href === item.href;
              return (
                <div key={item.href}>
                  {item.section && (
                    <div className="nav-section">{item.section}</div>
                  )}
                  <Link
                    className={`nav-item ${selected ? "nav-item-active" : ""}`}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    aria-current={selected ? "page" : undefined}
                  >
                    <Icon size={18} />
                    <span>{item.label}</span>
                    {selected && <span className="nav-active-dot" />}
                  </Link>
                </div>
              );
            })}
          </nav>
          <div className="sidebar-bottom">
            <div className="secure-workspace">
              <ShieldCheck size={17} />
              <div>
                <strong>Secure workspace</strong>
                <span>Access controlled. Changes tracked.</span>
              </div>
            </div>
            <button
              className="user-profile"
              onClick={logout}
              disabled={busy}
              aria-label="Sign out"
            >
              <span className="avatar">
                {displayName.slice(0, 2).toUpperCase()}
              </span>
              <span className="user-profile-name">
                <strong>{displayName}</strong>
                <span>{user.role.toLowerCase().replaceAll("_", " ")}</span>
              </span>
              <LogOut size={16} />
            </button>
          </div>
        </aside>
        <div className="main-shell" inert={open}>
          <header className="topbar">
            <div className="breadcrumb">
              <button
                className="mobile-menu icon-button"
                aria-label="Open navigation"
                aria-controls="main-navigation"
                aria-expanded={open}
                onClick={() => setOpen(true)}
              >
                <Menu size={22} />
              </button>
              <span className="breadcrumb-workspace">Workspace</span>
              <ChevronRight size={13} />
              <strong>{active?.label ?? "Bills & finance"}</strong>
            </div>
            <div className="topbar-right">
              <span className="environment-pill">
                <span />
                Secure access
              </span>
              <span className="topbar-divider" />
              <span className="topbar-company">VOLTRONIX UAE</span>
              <span className="avatar avatar-small">
                {displayName.slice(0, 2).toUpperCase()}
              </span>
            </div>
          </header>
          <main className="main-content">
            {error && (
              <Notice tone="error" onClose={() => setError("")}>
                {error}
              </Notice>
            )}
            {children}
          </main>
          <footer className="app-footer">
            <span>© VOLTRONIX · Bills & Finance</span>
            <span>All amounts reflect recorded financial activity.</span>
          </footer>
        </div>
      </div>
      </OcrWorkspaceContext.Provider>
      </ManualEntryContext.Provider>
    </UserContext.Provider>
  );
}
