import { NextResponse, type NextRequest } from "next/server";
import { AUTH_RETURN_PATH_HEADER, safeReturnPath } from "@/lib/auth-navigation";
import { AUTH_RESOURCE_PATH_HEADER } from "@/lib/route-access";

export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(AUTH_RESOURCE_PATH_HEADER, request.nextUrl.pathname);
  // Always overwrite public input. Carry only the pathname, never OAuth codes,
  // query strings, or a caller-selected destination. Authentication stays in the DAL.
  requestHeaders.set(
    AUTH_RETURN_PATH_HEADER,
    safeReturnPath(request.nextUrl.pathname) ?? "",
  );
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next(?:/|$)|favicon.ico$).*)"],
};
