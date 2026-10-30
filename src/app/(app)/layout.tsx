import { requirePageUser } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { isManualEntryOnly, isOcrWorkspaceEnabled } from "@/lib/application-mode";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requirePageUser();
  return <AppShell user={user} manualEntryOnly={isManualEntryOnly()} ocrWorkspaceEnabled={isOcrWorkspaceEnabled()}>{children}</AppShell>;
}
