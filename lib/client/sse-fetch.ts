import { parseServerEvents, type ServerEvent } from "@/lib/sse";

/*
  Client-side SSE consumer for fetch()-backed streams.

  Browser EventSource only supports GET; our stream endpoints POST so
  we read the body manually. This helper handles:
    - decoding the byte stream to UTF-8
    - re-prepending partial event frames across chunk boundaries
    - dispatching per-event callbacks
    - propagating aborts via the caller's AbortController

  Returns a promise that resolves when the server closes the stream or
  the abort signal fires. Rejects only on HTTP non-2xx or network
  errors — per-event `error` payloads are handed to `onEvent`.
*/

export interface SseFetchOpts {
  url: string;
  body: unknown;
  signal?: AbortSignal;
  onEvent: (ev: ServerEvent) => void;
}

export async function sseFetch(opts: SseFetchOpts): Promise<void> {
  const res = await fetch(opts.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`sseFetch: ${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const { events, rest } = parseServerEvents(buffer);
    buffer = rest;

    for (const e of events) {
      try {
        const parsed = JSON.parse(e.data) as ServerEvent;
        opts.onEvent(parsed);
      } catch {
        // Non-JSON or malformed event — skip.
      }
    }
  }
}
