/*
  Tiny Server-Sent Events helpers.

  The SSE wire format is deliberately simple: UTF-8 text, events
  separated by `\n\n`, each line inside a "block" is either:
    event: <name>
    data: <line>
    id: <id>

  We use named events (`delta`, `done`, `error`) with JSON payloads so
  the client can switch on `event.event` without sniffing shapes.

  Why a shared module instead of inlining in the route handler:
  - The encoder is identical for every streaming endpoint we'll add
    (spec generate + spec chat + future: opportunity re-score UX).
  - Unit-testable without spinning up a Route Handler runtime.
*/

export type ServerEvent =
  | { type: "delta"; text: string }
  | {
      type: "done";
      specId: string;
      version: number;
      grade: "A" | "B" | "C" | "D";
    }
  | { type: "error"; message: string };

const ENCODER = new TextEncoder();

/** Serialize one event into a chunk of bytes ready for controller.enqueue(). */
export function encodeServerEvent(ev: ServerEvent): Uint8Array {
  const eventName = ev.type;
  const payload = JSON.stringify(ev);
  // Split `data:` across lines if payload contains newlines — the SSE
  // spec requires each data line to be prefixed. JSON.stringify won't
  // emit raw newlines, but be defensive.
  const dataLines = payload
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  return ENCODER.encode(`event: ${eventName}\n${dataLines}\n\n`);
}

/**
 * Parse a text buffer containing zero or more SSE events. Returns the
 * parsed events plus any trailing partial buffer the caller should
 * re-prepend to the next read.
 *
 * We accept events without an `event:` line by defaulting to "message"
 * (standard browser EventSource behavior).
 */
export function parseServerEvents(buffer: string): {
  events: Array<{ event: string; data: string }>;
  rest: string;
} {
  const events: Array<{ event: string; data: string }> = [];
  // A complete event ends with a blank line (`\n\n`).
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";

  for (const block of parts) {
    if (!block.trim()) continue;
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    events.push({ event: eventName, data: dataLines.join("\n") });
  }

  return { events, rest };
}
