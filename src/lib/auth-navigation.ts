export const AUTH_RETURN_PATH_HEADER = "x-voltronix-return-path";

const appPagePath = /^\/(?:account|approvals|audit|bills|dashboard|integrations|jobs|management|ocr|vendors)(?:\/[A-Za-z0-9_-]+)*\/?$/;

export function roleHomePath(role: string): string {
  if (role === "ACCOUNTS") return "/bills/manual";
  return role === "MANAGEMENT" ? "/management" : "/dashboard";
}

/** Page navigation policy only; services must independently authorize their data. */
export function canAccessRolePath(role: string, path: string): boolean {
  if (!path || path.length > 512 || !appPagePath.test(path)) return false;
  if (/^\/account\/users(?:\/|$)/.test(path)) return role === "ADMIN";
  if (role !== "ACCOUNTS") return true;
  return /^\/(?:account|vendors)\/?$/.test(path) ||
    /^\/bills(?:\/(?:books(?:\/[A-Za-z0-9_-]+)?|[A-Za-z0-9_-]+(?:\/(?:edit|payment))?))?\/?$/.test(path) ||
    /^\/jobs\/(?:crm\/)?[A-Za-z0-9_-]+\/?$/.test(path);
}

/** Only app page paths can be a post-login destination; never URLs or API calls. */
export function safeReturnPath(
  value: string | null | undefined,
  role?: string,
): string | null {
  if (!value || value.length > 512 || !appPagePath.test(value)) return null;
  return role === undefined || canAccessRolePath(role, value) ? value : null;
}

export function loginUrl(returnPath: string | null | undefined): string {
  const path = safeReturnPath(returnPath);
  return path ? `/login?${new URLSearchParams({ next: path })}` : "/login";
}

export function loginDestination(
  role: string,
  returnPath: string | null | undefined,
): string {
  return safeReturnPath(returnPath, role) ?? roleHomePath(role);
}
