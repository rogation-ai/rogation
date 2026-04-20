import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@/server/root";

/*
  Typed tRPC React hooks. Import `trpc.account.me.useQuery()` etc.
  in client components. Server components call tRPC via a different
  helper (added when the first server component needs it).
*/
export const trpc = createTRPCReact<AppRouter>();
