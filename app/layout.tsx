import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rogation",
  description:
    "Turn 20 interviews into Friday's decision. Self-serve synthesis for PMs.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
