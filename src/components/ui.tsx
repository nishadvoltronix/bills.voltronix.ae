"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { AlertCircle, LoaderCircle, RefreshCw, Inbox, X } from "lucide-react";
import { useManualEntryOnly } from "./application-mode";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
const buttonVariants = cva("button", {
  variants: {
    variant: {
      default: "button-primary",
      secondary: "button-secondary",
      ghost: "button-ghost",
      destructive: "button-danger",
    },
    size: { default: "", sm: "button-sm", icon: "button-icon" },
  },
  defaultVariants: { variant: "default", size: "default" },
});
export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size }), className)}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn("input", className)} {...props} />
));
Input.displayName = "Input";
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select ref={ref} className={cn("input select", className)} {...props} />
));
Select.displayName = "Select";
export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn("input textarea", className)} {...props} />
));
Textarea.displayName = "Textarea";
export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card", className)} {...props} />;
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}) {
  return (
    <span className={`badge badge-${tone}`}>
      <span className="badge-dot" />
      {children}
    </span>
  );
}
export function StatusBadge({ status }: { status: string }) {
  const manualEntryOnly = useManualEntryOnly();
  const tones: Record<
    string,
    "neutral" | "success" | "warning" | "danger" | "info"
  > = {
    READY: "info",
    APPROVED: "success",
    PAID: "success",
    WITHIN_BUDGET: "success",
    PENDING_APPROVAL: "warning",
    PARTIALLY_PAID: "warning",
    NEAR_LIMIT: "warning",
    REJECTED: "danger",
    OVER_BUDGET: "danger",
    FAILED: "danger",
    DRAFT: "neutral",
    CANCELLED: "neutral",
    UNPAID: "info",
  };
  const labels: Record<string, string> = {
    READY: manualEntryOnly ? "Saved" : "Ready to sync",
    PENDING_APPROVAL: "Awaiting final save",
    APPROVED: "Approved (legacy)",
    NEAR_LIMIT: "Near budget limit",
    VALUE_UNAVAILABLE: "Value unavailable",
  };
  return (
    <Badge tone={tones[status] ?? "neutral"}>
      {labels[status] ?? status.toLowerCase().replaceAll("_", " ")}
    </Badge>
  );
}
export function Field({
  label,
  htmlFor,
  hint,
  children,
  required,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>
        {label}
        {required && (
          <span className="required" aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </label>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Inbox size={24} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function ErrorState({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="error-state" role="alert">
      <AlertCircle size={20} />
      <div>
        <strong>We couldn’t load this information</strong>
        <p>{message}</p>
      </div>
      {retry && (
        <Button type="button" variant="secondary" size="sm" onClick={retry}>
          <RefreshCw size={14} />
          Retry
        </Button>
      )}
    </div>
  );
}
export function Notice({
  children,
  tone = "info",
  onClose,
}: {
  children: React.ReactNode;
  tone?: "info" | "success" | "error";
  onClose?: () => void;
}) {
  return (
    <div
      className={`notice notice-${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <AlertCircle size={17} />
      <div>{children}</div>
      {onClose && (
        <button
          className="icon-button"
          aria-label="Dismiss notification"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden="true" />;
}
export function LoadingPanel() {
  return (
    <div className="loading-panel" role="status">
      <LoaderCircle className="spin" size={20} />
      <span>Loading your records…</span>
    </div>
  );
}
export function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="table-scroll">
      <table>{children}</table>
    </div>
  );
}
