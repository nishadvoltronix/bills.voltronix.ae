/** The proxy always replaces this header with the actual request pathname. */
export const AUTH_RESOURCE_PATH_HEADER = "x-voltronix-resource-path";

/** Accounts users work with bill/vendor records and the lookups needed to enter them. */
export function canAccessRoleApiPath(
  role: string,
  pathname: string | null | undefined,
): boolean {
  if (pathname && (/^\/api\/account\/users(?:\/|$)/.test(pathname) || /^\/api\/auth\/password\/?$/.test(pathname))) return role === "ADMIN";
  if (role !== "ACCOUNTS") return true;
  if (!pathname || pathname.length > 512) return false;
  return /^\/api\/auth\/(?:me|logout)\/?$/.test(pathname) ||
    /^\/api\/companies\/?$/.test(pathname) ||
    /^\/api\/(?:bills|vendors)(?:\/[A-Za-z0-9_-]+)*\/?$/.test(pathname) ||
    /^\/api\/documents\/[A-Za-z0-9_-]+\/?$/.test(pathname) ||
    /^\/api\/jobs(?:\/(?:[A-Za-z0-9_-]+|crm\/[A-Za-z0-9_-]+))?\/?$/.test(pathname) ||
    /^\/api\/crm\/jobs\/[A-Za-z0-9_-]+\/expenses\/?$/.test(pathname) ||
    /^\/api\/dashboard\/search\/?$/.test(pathname) ||
    /^\/api\/integrations(?:\/vendor-mapping|\/jobs\/[A-Za-z0-9_-]+)?\/?$/.test(pathname);
}
