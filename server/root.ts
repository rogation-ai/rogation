import { accountRouter } from "@/server/routers/account";
import { router } from "@/server/trpc";

/*
  Root tRPC router. Feature routers (evidence, insights, opportunities,
  specs, outcomes, integrations, billing) mount here as they land.
*/
export const appRouter = router({
  account: accountRouter,
});

export type AppRouter = typeof appRouter;
