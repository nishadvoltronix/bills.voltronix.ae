/** Presentation only; stored names and demo classification keep their original values. */
export function accountDisplayName(name: string) {
  return name.replace(/^\s*\[DEMO\]\s*/i, "");
}
