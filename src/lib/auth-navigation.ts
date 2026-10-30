export const AUTH_RETURN_PATH_HEADER = "x-voltronix-return-path";

/** Only app page paths can be a post-login destination; never URLs or API calls. */
export function safeReturnPath(
  value: string | null | undefined,
): string | null {
  if (!value || value.length > 512) return null;
  return /^\/(?:account|approvals|audit|bills|dashboard|integrations|jobs|management|ocr|vendors)(?:\/[A-Za-z0-9_-]+)*\/?$/.test(
    value,
  )
    ? value
    : null;
}

export function loginUrl(returnPath: string | null | undefined): string {
  const path = safeReturnPath(returnPath);
  return path ? `/login?${new URLSearchParams({ next: path })}` : "/login";
}

export function loginDestination(
  role: string,
  returnPath: string | null | undefined,
): string {
  return (
    safeReturnPath(returnPath) ??
    (role === "MANAGEMENT" ? "/management" : "/dashboard")
  );
}
