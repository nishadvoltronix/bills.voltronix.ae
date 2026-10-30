import { NextResponse, type NextRequest } from "next/server";
import { AUTH_RETURN_PATH_HEADER, safeReturnPath } from "@/lib/auth-navigation";

export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  // Always overwrite public input. Carry only the pathname, never OAuth codes,
  // query strings, or a caller-selected destination. Authentication stays in the DAL.
  requestHeaders.set(
    AUTH_RETURN_PATH_HEADER,
    safeReturnPath(request.nextUrl.pathname) ?? "",
  );
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!api(?:/|$)|_next(?:/|$)|favicon.ico$).*)"],
};
