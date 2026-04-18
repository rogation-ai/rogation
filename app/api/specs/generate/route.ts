import type { NextRequest } from "next/server";
import { generateSpecStream } from "@/lib/evidence/specs";
import { chargeAndEnforce } from "@/lib/llm/usage";
import { encodeServerEvent } from "@/lib/sse";
import { withAuthedAccountTx } from "@/server/auth";

/*
  POST /api/specs/generate

  Server-Sent Events endpoint that streams spec generation in real time.
  Body: { opportunityId: string }. Response: text/event-stream.

  Why not tRPC: tRPC's transport assumes request/response. Streaming
  requires a raw ReadableStream; easier to own the framing here than
  to shoehorn it through tRPC subscriptions (which need an extra WS
  adapter we don't want to run on Vercel's edge).

  Why POST not GET: EventSource only does GET, but we're using
  fetch()-streaming on the client, which does POST fine and keeps the
  opportunityId out of the URL + query-log. Minor but it matters when
  PMs paste screenshots into Slack.

  Lifecycle:
    auth -> read opp + clusters -> open SSE stream ->
    for each LLM delta, emit event:delta {text}
    on success, emit event:done {specId, version, grade} and close
    on error, emit event:error {message} and close

  The transaction wrapping generateSpecStream holds until the final
  chunk is consumed. Connection drops = roll-back = no partial spec
  persisted. That's the whole point of running the DB write inside
  the streaming generator rather than outside it.
*/

export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  let opportunityId: string;
  try {
    const body = (await req.json()) as { opportunityId?: string };
    if (typeof body.opportunityId !== "string" || body.opportunityId.length === 0) {
      return new Response(JSON.stringify({ error: "opportunityId required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    opportunityId = body.opportunityId;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: Parameters<typeof encodeServerEvent>[0]) => {
        try {
          controller.enqueue(encodeServerEvent(ev));
        } catch {
          // Client disconnected; downstream generator will be aborted
          // by the AbortSignal wired below.
        }
      };

      const abort = new AbortController();
      // If the HTTP request is cancelled (tab close, navigate away),
      // propagate the abort into the LLM stream so we stop burning
      // tokens immediately.
      req.signal.addEventListener("abort", () => abort.abort(), { once: true });

      try {
        const result = await withAuthedAccountTx(async (ctx) => {
          const gen = generateSpecStream(
            { db: ctx.db, accountId: ctx.accountId },
            opportunityId,
            {
              signal: abort.signal,
              onUsage: async (u) => {
                await chargeAndEnforce(ctx.db, ctx.plan, ctx.accountId, u);
              },
            },
          );

          let done: {
            type: "done";
            specId: string;
            version: number;
            grade: "A" | "B" | "C" | "D";
          } | null = null;

          for await (const ev of gen) {
            if (ev.type === "delta") {
              send({ type: "delta", text: ev.text });
            } else {
              done = ev;
            }
          }

          return done;
        });

        if (!result) {
          send({ type: "error", message: "Not signed in" });
        } else {
          send(result);
        }
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : "Spec generation failed",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
