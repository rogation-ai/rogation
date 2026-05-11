/*
  Browser-runtime Sentry init. Next.js 15 picks this up via the new
  instrumentation-client convention (replaces the older
  sentry.client.config.ts from v8). No-op when the DSN is unset.

  Sentry is loaded via dynamic import inside requestIdleCallback so
  the ~126 KB SDK chunk doesn't block FCP on the marketing landing
  page (where it's pure dead weight) or on the first authed paint.
  Tradeoff: errors thrown in the first idle-window worth of page
  bootstrap aren't captured. Replays are off, sampling is 5% — the
  SDK exists to log crashes, not first-paint metrics, so the window
  isn't load-bearing.
*/

type SentryRouterHook = (...args: readonly unknown[]) => void;

let capture: SentryRouterHook | null = null;

export const onRouterTransitionStart: SentryRouterHook = (...args) => {
  capture?.(...args);
};

if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_SENTRY_DSN) {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

  const initSentry = (): void => {
    void (async () => {
      const [Sentry, filter] = await Promise.all([
        import("@sentry/nextjs"),
        import("@/lib/sentry-filter"),
      ]);
      Sentry.init({
        dsn,
        tracesSampleRate: 0.05,
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,
        sendDefaultPii: false,
        environment: process.env.NODE_ENV,
        beforeSend: filter.sentryBeforeSend,
      });
      capture = Sentry.captureRouterTransitionStart as SentryRouterHook;
    })();
  };

  if ("requestIdleCallback" in window) {
    (
      window as Window & {
        requestIdleCallback: (
          cb: () => void,
          opts?: { timeout: number },
        ) => number;
      }
    ).requestIdleCallback(initSentry, { timeout: 2000 });
  } else {
    setTimeout(initSentry, 100);
  }
}
