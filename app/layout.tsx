import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { Providers } from "./providers";
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
    <ClerkProvider>
      <html lang="en">
        <head>
          {/*
            Fonts loaded from Fontshare (free, no API key). General Sans
            does display + UI + body; JetBrains Mono Display does data,
            IDs, timestamps, scores. Single <link> covers both families
            with the weights actually used (DESIGN.md §2).

            preconnect first cuts ~100ms off the initial paint.
          */}
          <link rel="preconnect" href="https://api.fontshare.com" />
          <link rel="preconnect" href="https://cdn.fontshare.com" crossOrigin="" />
          <link
            rel="stylesheet"
            href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&f[]=jetbrains-mono@400,500&display=swap"
          />
        </head>
        <body>
          <Providers>{children}</Providers>
        </body>
      </html>
    </ClerkProvider>
  );
}
