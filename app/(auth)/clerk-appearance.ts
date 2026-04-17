/*
  Maps Clerk's component slots to Rogation's DESIGN.md tokens. Keep this
  file as the single place that translates brand -> Clerk variables so
  color or type shifts only happen in ONE translation layer.

  Anything not overridden here uses Clerk's defaults; fine for now,
  tighten as the system matures. Type inference comes from the call site
  (<SignIn appearance={...} />) so we don't need to pull @clerk/types.
*/
export const clerkAppearance = {
  variables: {
    colorPrimary: "#D04B3F",
    colorText: "#1A1815",
    colorTextSecondary: "#5C5651",
    colorBackground: "#FBFAF7",
    colorInputBackground: "#FFFFFF",
    colorInputText: "#1A1815",
    colorDanger: "#B93A2E",
    colorSuccess: "#2F7A4F",
    colorWarning: "#B4701E",
    borderRadius: "8px",
    fontFamily:
      '"Söhne", "Inter", ui-sans-serif, system-ui, sans-serif',
  },
  elements: {
    rootBox: "w-full max-w-[420px]",
    card: "shadow-none border border-[var(--color-border-subtle)] rounded-xl",
    headerTitle: "tracking-tight",
    socialButtonsBlockButton: "font-medium",
    formFieldLabel: "font-medium",
    footer: "bg-transparent",
  },
};
