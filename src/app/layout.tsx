import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "VOLTRONIX | Bills & Finance", template: "%s | VOLTRONIX" },
  description:
    "Secure bill entry, approvals, and provisional job profitability for VOLTRONIX.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
