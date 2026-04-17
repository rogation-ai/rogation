import { eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "@/db/schema";
import {
  createCheckoutSession,
  createPortalSession,
} from "@/lib/stripe/checkout";
import { authedProcedure, router } from "@/server/trpc";

/*
  Billing router. Two entrypoints:

  - createCheckout: lazy-creates the Stripe customer if needed, then
    returns a Checkout Session URL for the requested tier. Client
    redirects the browser to it.
  - createPortal: returns a Stripe Customer Portal URL so a subscriber
    can manage / cancel. Throws if the caller has no Stripe customer
    yet (the UI should hide the button for free users).
*/
export const billingRouter = router({
  createCheckout: authedProcedure
    .input(z.object({ tier: z.enum(["solo", "pro"]) }))
    .mutation(async ({ ctx, input }) => {
      const [user] = await ctx.db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, ctx.userId))
        .limit(1);

      if (!user?.email) {
        // Impossible under RLS: the authed middleware resolved ctx.userId
        // from this exact row. Defensive in case schema drifts.
        throw new Error("User row missing email");
      }

      return createCheckoutSession({
        db: ctx.db,
        accountId: ctx.accountId,
        email: user.email,
        tier: input.tier,
      });
    }),

  createPortal: authedProcedure.mutation(async ({ ctx }) => {
    return createPortalSession({
      db: ctx.db,
      accountId: ctx.accountId,
    });
  }),
});
