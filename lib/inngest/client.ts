import { Inngest } from "inngest";

/*
  Inngest client — emits background events from request handlers and
  exposes `send()` to the rest of the app. Worker functions live
  under lib/inngest/functions/ and are registered via the Next.js
  route handler at app/api/inngest/route.ts.

  Why Inngest: retries, concurrency caps, idempotency keys, and a
  real dashboard for failed jobs. We get all four without standing up
  our own queue or worker pool. Event keys + signing keys come from
  env; both are optional in dev — the SDK routes to the local dev
  server at 127.0.0.1:8288 when no event key is set.
*/

export const EVENT_EMBED_REQUESTED = "evidence/embed.requested" as const;

export interface EvidenceEmbedRequestedData {
  accountId: string;
  evidenceId: string;
}

export const inngest = new Inngest({
  id: "rogation",
});
