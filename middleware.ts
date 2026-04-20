import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/*
  Clerk middleware. Runs on every non-static request.

  Public routes: landing, pricing, docs, public share links, and
  signed-header endpoints (Clerk / Stripe webhooks, Inngest serve
  handler). Signed requests are the trust boundary — no Clerk session
  can exist on those calls.

  Every other route requires a valid Clerk session. Unauthenticated requests
  get redirected to the Clerk-hosted sign-in page (or a local one later).

  The webhook MUST be public here — Clerk cannot have a session when calling
  its own webhook.
*/

const isPublicRoute = createRouteMatcher([
  "/",
  "/pricing",
  "/docs(.*)",
  "/s/(.*)", // view-only public share links (rate-limited in the handler)
  "/api/health", // deploy + uptime probe; no auth, no account context
  "/api/webhooks/(.*)",
  "/api/inngest(.*)", // Inngest serve handler; verifies its own signature via INNGEST_SIGNING_KEY

  "/sign-in(.*)",
  "/sign-up(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next internals + static assets.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API + tRPC routes.
    "/(api|trpc)(.*)",
  ],
};
