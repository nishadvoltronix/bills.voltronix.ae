export const SESSION_REQUIRED_CODE = "AUTH_SESSION_REQUIRED";
export const SESSION_EXPIRED_EVENT = "voltronix:session-expired";
export const SESSION_RESTORED_EVENT = "voltronix:session-restored";

// Browser memory only: neither credentials nor form contents enter storage.
let expired = false;
let generation = 0;

export function isSessionExpired() { return expired; }
export function sessionGeneration() { return generation; }

export function isLocalApi(url: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const target = new URL(url, window.location.href);
    return target.origin === window.location.origin && target.pathname.startsWith("/api/");
  } catch { return false; }
}

export function isSessionRecoveryRequest(url: string): boolean {
  return isLocalApi(url) && /^\/api\/auth\/(?:login|logout|me)$/.test(new URL(url, window.location.href).pathname);
}

export function requireSessionRecovery() {
  if (typeof window === "undefined" || expired) return;
  expired = true;
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

export function clearSessionRecovery() {
  expired = false;
  generation++;
}

/** Called only after the mounted account has successfully signed in again. */
export function restoreSession() {
  clearSessionRecovery();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_RESTORED_EVENT));
}
