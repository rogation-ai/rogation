import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/*
  Clerk middleware. Runs on every non-static request.

  Public routes: landing, pricing, docs, public share links, and the
  Clerk webhook endpoint (which authenticates via signed-header, not session).

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
  "/api/webhooks/(.*)",
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
