"use client";

import { createContext, useContext } from "react";

export const ManualEntryContext = createContext(false);
export function useManualEntryOnly() {
  return useContext(ManualEntryContext);
}

export const OcrWorkspaceContext = createContext(false);
export function useOcrWorkspaceEnabled() {
  return useContext(OcrWorkspaceContext);
}
