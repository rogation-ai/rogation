"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

/*
  App Router top-level error boundary. Required by Sentry to catch
  render errors that escape nested error.tsx boundaries. Must render
  its own <html> + <body> because it replaces the root layout.

  The UI here is deliberately minimal — it's the last-line defense
  when everything else has already failed.
*/
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          display: "flex",
          minHeight: "100dvh",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
          background: "var(--color-surface-marketing, #F8F1E6)",
          color: "var(--color-text-primary, #1A1815)",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        <div style={{ maxWidth: "32rem" }}>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 600, letterSpacing: "-0.02em" }}>
            Something went wrong.
          </h1>
          <p style={{ marginTop: "0.75rem", opacity: 0.7, fontSize: "0.9rem" }}>
            We&apos;ve logged it and are looking into it. You can try again.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "1.5rem",
              padding: "0.625rem 1.25rem",
              borderRadius: "0.5rem",
              background: "#D04B3F",
              color: "white",
              fontSize: "0.875rem",
              fontWeight: 500,
              border: "none",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
