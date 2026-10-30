"use client";
import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@/lib/finance";
import type { Bill, Job, JobSummary, Money } from "./types";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
    cache: "no-store",
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      body && typeof body === "object" && "error" in body ? body.error : null;
    const message =
      typeof error === "string"
        ? error
        : error &&
            typeof error === "object" &&
            "message" in error &&
            typeof error.message === "string"
          ? error.message
          : response.status === 401
            ? "Your session has expired. Please sign in again."
            : "The request could not be completed. Please try again.";
    throw new ApiError(message, response.status);
  }
  return body as T;
}
export function useApi<T>(
  url: string | null,
  { keepPreviousData = false }: { keepPreviousData?: boolean } = {},
) {
  const [result, setResult] = useState<{
    key: string;
    url: string;
    data: T | null;
    error: string | null;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  const requestKey = `${url ?? ""}:${revision}`;
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    api<T>(url, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted)
          setResult({ key: requestKey, url, data, error: null });
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted)
          setResult((previous) => ({
            key: requestKey,
            url,
            data: keepPreviousData && previous?.url === url &&
              (!(err instanceof ApiError) || err.status >= 500) ? previous.data : null,
            error: err instanceof Error ? err.message : "Unexpected error",
          }));
      });
    return () => controller.abort();
  }, [url, requestKey, keepPreviousData]);
  const current = result?.key === requestKey ||
    (keepPreviousData && result?.url === url) ? result : null;
  return {
    data: current?.data ?? null,
    error: current?.data ? null : current?.error ?? null,
    refreshError: current?.data ? current.error : null,
    refreshing: Boolean(url && current && result?.key !== requestKey),
    loading: Boolean(url && !current),
    reload,
  };
}
export function money(value: Money | null | undefined, currency = "AED") {
  return formatMoney(value, currency);
}
export function number(value: Money | null | undefined) {
  return new Intl.NumberFormat("en-AE", { maximumFractionDigits: 0 }).format(
    Number(value ?? 0),
  );
}
export function date(value: string | null | undefined) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Dubai",
      }).format(d);
}
export function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Dubai",
        hour12: false,
      }).format(d);
}
export function dateInput(value?: string | null) {
  return value ? value.slice(0, 10) : "";
}
export function billTotal(bill: Bill) {
  return bill.grandTotal ?? bill.total ?? 0;
}
export function summary(job: Job): JobSummary {
  return (
    job.summary ?? {
      adjustedValue: job.adjustedValue ?? null,
      recognizedExpenses: job.recognizedExpenses ?? null,
      paidExpenses: job.paidExpenses ?? null,
      outstanding: job.outstanding ?? null,
      remainingBudget: job.remainingBudget ?? null,
      estimatedProfit: job.estimatedProfit ?? null,
      expensePercentage: job.expensePercentage ?? null,
      budgetStatus: job.budgetStatus ?? "VALUE_UNAVAILABLE",
    }
  );
}
export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
