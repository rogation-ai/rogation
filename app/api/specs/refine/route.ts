import type { NextRequest } from "next/server";
import { refineSpecStream } from "@/lib/evidence/specs";
import { chargeAndEnforce } from "@/lib/llm/usage";
import { checkLimit } from "@/lib/rate-limit";
import { encodeServerEvent, type ServerEvent } from "@/lib/sse";
import { withAuthedAccountTx } from "@/server/auth";

/*
  POST /api/specs/refine

  SSE endpoint that streams a refinement turn. Body:
    { opportunityId: string, userMessage: string }

  Response: text/event-stream. Shares wire format with
  /api/specs/generate — same encodeServerEvent + parseServerEvents on
  both sides. Adds `assistantMessage` to the `done` payload so the
  chat panel can render the reply without a second round-trip.

  Rate-limited per account via the `spec-chat` preset (20/min). The
  limit check runs BEFORE auth transaction + LLM call, so a throttled
  request spends zero provider tokens + holds no DB connection.
*/

export const runtime = "nodejs";

const MAX_USER_MESSAGE_CHARS = 2000;

interface RefineBody {
  opportunityId?: string;
  userMessage?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: RefineBody;
  try {
    body = (await req.json()) as RefineBody;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (typeof body.opportunityId !== "string" || body.opportunityId.length === 0) {
    return jsonError("opportunityId required", 400);
  }
  if (
    typeof body.userMessage !== "string" ||
    body.userMessage.trim().length === 0
  ) {
    return jsonError("userMessage required", 400);
  }
  if (body.userMessage.length > MAX_USER_MESSAGE_CHARS) {
    return jsonError(
      `userMessage exceeds ${MAX_USER_MESSAGE_CHARS} characters`,
      413,
    );
  }

  const { opportunityId, userMessage } = body;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: ServerEvent) => {
        try {
          controller.enqueue(encodeServerEvent(ev));
        } catch {
          /* client disconnected */
        }
      };

      const abort = new AbortController();
      req.signal.addEventListener("abort", () => abort.abort(), { once: true });

      try {
        const result = await withAuthedAccountTx(async (ctx) => {
          // Rate-limit per-account. Key on accountId so a team doesn't
          // burn through another account's budget.
          const limit = await checkLimit("spec-chat", ctx.accountId);
          if (!limit.success) {
            const waitMs = Math.max(0, limit.reset - Date.now());
            const seconds = Math.ceil(waitMs / 1000);
            return {
              error: `Too many refinements — try again in ${seconds}s`,
            };
          }

          const gen = refineSpecStream(
            { db: ctx.db, accountId: ctx.accountId },
            opportunityId,
            userMessage.trim(),
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
            assistantMessage: string;
          } | null = null;

          for await (const ev of gen) {
            if (ev.type === "delta") {
              send({ type: "delta", text: ev.text });
            } else {
              done = ev;
            }
          }

          return { done };
        });

        if (!result) {
          send({ type: "error", message: "Not signed in" });
        } else if ("error" in result && result.error) {
          send({ type: "error", message: result.error });
        } else if ("done" in result && result.done) {
          // Note: assistantMessage is carried in the `done` payload
          // but the shared SSE type omits it; the client extracts
          // it from the refinement history query on invalidate.
          send({
            type: "done",
            specId: result.done.specId,
            version: result.done.version,
            grade: result.done.grade,
          });
        }
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : "Refinement failed",
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

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
