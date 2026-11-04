"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatMoney } from "@/lib/finance";
import {
  SESSION_REQUIRED_CODE, SESSION_RESTORED_EVENT, isLocalApi, isSessionExpired,
  isSessionRecoveryRequest, requireSessionRecovery, sessionGeneration,
} from "@/lib/session-recovery";
import type { Bill, Job, JobSummary, Money } from "./types";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const local = isLocalApi(url);
  const recovery = isSessionRecoveryRequest(url);
  if (local && !recovery && isSessionExpired())
    throw new ApiError("Please sign in again to continue.", 401, SESSION_REQUIRED_CODE);
  const generation = sessionGeneration();
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
    const code = local && response.status === 401 && body && typeof body === "object" &&
      "code" in body && body.code === SESSION_REQUIRED_CODE ? SESSION_REQUIRED_CODE : undefined;
    if (code && !recovery && !init?.signal?.aborted && generation === sessionGeneration())
      requireSessionRecovery();
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
    throw new ApiError(message, response.status, code);
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
    sessionExpired?: boolean;
  } | null>(null);
  const needsSessionRetry = useRef(false);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  const requestKey = `${url ?? ""}:${revision}`;
  useEffect(() => {
    function retryRead() {
      if (!needsSessionRetry.current) return;
      needsSessionRetry.current = false;
      reload();
    }
    window.addEventListener(SESSION_RESTORED_EVENT, retryRead);
    return () => window.removeEventListener(SESSION_RESTORED_EVENT, retryRead);
  }, [reload]);
  useEffect(() => {
    if (!url) return;
    needsSessionRetry.current = false;
    const requestSessionGeneration = sessionGeneration();
    const controller = new AbortController();
    api<T>(url, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted)
          setResult({ key: requestKey, url, data, error: null });
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          const sessionExpired = err instanceof ApiError && err.code === SESSION_REQUIRED_CODE;
          needsSessionRetry.current = sessionExpired;
          setResult((previous) => ({
            key: requestKey,
            url,
            data: previous?.url === url && (sessionExpired || (keepPreviousData &&
              (!(err instanceof ApiError) || err.status >= 500))) ? previous.data : null,
            error: err instanceof Error ? err.message : "Unexpected error",
            sessionExpired,
          }));
          // A response from the old session can arrive just after reauthentication.
          // Retry only this read; mutations are never replayed by the API helper.
          if (sessionExpired && requestSessionGeneration !== sessionGeneration() && !isSessionExpired()) reload();
        }
      });
    return () => controller.abort();
  }, [url, requestKey, keepPreviousData, reload]);
  const current = result?.key === requestKey ||
    ((keepPreviousData || result?.sessionExpired) && result?.url === url) ? result : null;
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
