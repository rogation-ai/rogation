import { describe, expect, it } from "vitest";
import {
  encodeServerEvent,
  parseServerEvents,
  type ServerEvent,
} from "@/lib/sse";

/*
  SSE encoder + parser are shared by the route handler and the browser
  client. A bug here corrupts every streaming endpoint silently, so
  lock the wire format down.

  Spec: https://html.spec.whatwg.org/multipage/server-sent-events.html
*/

const DECODER = new TextDecoder();

describe("encodeServerEvent", () => {
  it("emits named events with JSON payloads", () => {
    const bytes = encodeServerEvent({ type: "delta", text: "hello" });
    const s = DECODER.decode(bytes);
    expect(s).toBe(
      'event: delta\ndata: {"type":"delta","text":"hello"}\n\n',
    );
  });

  it("terminates each event with a blank line", () => {
    const a = encodeServerEvent({ type: "delta", text: "a" });
    const b = encodeServerEvent({ type: "delta", text: "b" });
    const combined = DECODER.decode(a) + DECODER.decode(b);
    // Split on the blank-line terminator; expect 3 parts (2 events + trailing).
    const parts = combined.split("\n\n");
    expect(parts).toHaveLength(3);
    expect(parts[2]).toBe("");
  });

  it("encodes all event types", () => {
    const evs: ServerEvent[] = [
      { type: "delta", text: "x" },
      { type: "done", specId: "id", version: 1, grade: "A" },
      { type: "error", message: "boom" },
    ];
    for (const ev of evs) {
      const s = DECODER.decode(encodeServerEvent(ev));
      expect(s).toContain(`event: ${ev.type}`);
      expect(s.endsWith("\n\n")).toBe(true);
    }
  });
});

describe("parseServerEvents", () => {
  it("parses multiple complete events", () => {
    const buf =
      'event: delta\ndata: {"type":"delta","text":"hi"}\n\n' +
      'event: done\ndata: {"type":"done","specId":"s","version":1,"grade":"A"}\n\n';
    const { events, rest } = parseServerEvents(buf);
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe("delta");
    expect(events[1]?.event).toBe("done");
    expect(rest).toBe("");
  });

  it("returns incomplete trailing event as rest", () => {
    const buf =
      'event: delta\ndata: {"type":"delta","text":"hi"}\n\n' +
      "event: done\ndata: {"; // truncated mid-json, no terminator
    const { events, rest } = parseServerEvents(buf);
    expect(events).toHaveLength(1);
    expect(rest).toContain("event: done");
  });

  it("defaults event name to 'message' when omitted", () => {
    const buf = 'data: {"type":"delta","text":"x"}\n\n';
    const { events } = parseServerEvents(buf);
    expect(events[0]?.event).toBe("message");
  });

  it("joins multi-line data with newlines", () => {
    const buf = "event: delta\ndata: line1\ndata: line2\n\n";
    const { events } = parseServerEvents(buf);
    expect(events[0]?.data).toBe("line1\nline2");
  });

  it("round-trips encode -> parse", () => {
    const ev: ServerEvent = {
      type: "done",
      specId: "abc",
      version: 2,
      grade: "B",
    };
    const encoded = DECODER.decode(encodeServerEvent(ev));
    const { events } = parseServerEvents(encoded);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.data)).toEqual(ev);
  });
});
