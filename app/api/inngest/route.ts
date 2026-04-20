import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { embedEvidence } from "@/lib/inngest/functions/embed-evidence";

/*
  Inngest webhook endpoint. Inngest Cloud (or the local dev server)
  POSTs signed requests here to invoke registered functions. The
  request is verified against INNGEST_SIGNING_KEY by the SDK — no
  need to reach into headers here.

  Add every function to the `functions` array below when we register
  new background jobs. A missing function = a silently-dropped event.
*/
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [embedEvidence],
});
