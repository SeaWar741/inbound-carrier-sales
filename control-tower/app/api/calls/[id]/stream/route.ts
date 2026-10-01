import { NextResponse } from "next/server";
import { z } from "zod";
import { getTranscript } from "@/lib/adapter";
import type { StreamEvent } from "@/lib/contracts";
import { openSessionStream, sessionForRun } from "@/lib/happyrobot";

// Transcript of one HappyRobot session as SSE: `line`, `tool`, `signal` and `ended` events.
// The route id is the call id (the HappyRobot run id); its session is looked up, live or ended.
// A call id that is not a run id (the demo dataset) replays the conversation stored in Twin instead.

const params = z.object({ id: z.uuid() });

const toolCall = z.object({ name: z.string().optional(), function: z.object({ name: z.string() }).optional() });
const message = z.object({
  id: z.string(),
  role: z.string(),
  content: z.string().nullish(),
  timestamp: z.string(),
  tool_calls: z.array(z.unknown()).nullish(),
});

// Whisper deliveries and the agent's own reasoning come back as user messages; neither is the carrier speaking.
const thoughtsPrefix = "<Thoughts>";
const signalPrefix = "<Signal Received>";

function toolNames(toolCalls: unknown[] | null | undefined): string[] {
  return (toolCalls ?? []).flatMap((item) => {
    const parsed = toolCall.safeParse(item);
    const name = parsed.success ? (parsed.data.name ?? parsed.data.function?.name) : undefined;
    return name ? [name] : [];
  });
}

function translate(event: string, data: string): StreamEvent[] {
  if (event === "session_ended") return [{ event: "ended", data: {} }];
  if (event !== "message") return [];
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return [];
  }
  const parsed = message.safeParse(raw);
  if (!parsed.success) return [];
  const { id, role, timestamp: at } = parsed.data;
  const text = (parsed.data.content ?? "").trim();
  if (role === "assistant") {
    const tools = toolNames(parsed.data.tool_calls).map((name): StreamEvent => ({ event: "tool", data: { name, at } }));
    return text ? [...tools, { event: "line", data: { id, role: "agent", text, at } }] : tools;
  }
  if (role === "user") {
    if (text.startsWith(thoughtsPrefix)) return [];
    if (text.startsWith(signalPrefix)) return [{ event: "signal", data: { at } }];
    return text ? [{ event: "line", data: { id, role: "carrier", text, at } }] : [];
  }
  return [];
}

const encode = (event: StreamEvent) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;

const sseHeaders = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

async function storedTranscript(callId: string): Promise<Response> {
  const transcript = await getTranscript(callId);
  if (!transcript.ok) return NextResponse.json(transcript.body, { status: transcript.httpStatus });
  if (transcript.body.entries.length === 0) {
    return NextResponse.json({ status: "not_found", message: "This call has no transcript." }, { status: 404 });
  }
  const events = transcript.body.entries.map(({ seq, role, text, at }): StreamEvent => {
    if (role === "tool") return { event: "tool", data: { name: text, at } };
    if (role === "signal") return { event: "signal", data: { at } };
    return { event: "line", data: { id: `${callId}-${seq}`, role, text, at } };
  });
  return new Response([...events, { event: "ended", data: {} } satisfies StreamEvent].map(encode).join(""), { headers: sseHeaders });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const raw = await context.params;
  const parsedParams = params.safeParse(raw);
  if (!parsedParams.success) {
    if (/^demo-[\w-]{1,120}$/.test(raw.id)) return storedTranscript(raw.id);
    return NextResponse.json({ status: "invalid_request", message: "The call id must be a uuid." }, { status: 400 });
  }
  let sessionId: string | null;
  try {
    sessionId = await sessionForRun(parsedParams.data.id);
  } catch {
    return NextResponse.json({ status: "live_unavailable", message: "The transcript is unavailable right now." }, { status: 502 });
  }
  if (sessionId === null) {
    return NextResponse.json({ status: "not_found", message: "This call has no session yet." }, { status: 404 });
  }

  // The browser leaving aborts the request signal, which closes the upstream fetch with it.
  let upstream: Response;
  try {
    upstream = await openSessionStream(sessionId, request.signal);
  } catch {
    return NextResponse.json({ status: "live_unavailable", message: "The live transcript is unavailable right now." }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    void upstream.body?.cancel().catch(() => undefined);
    if (upstream.status === 404) {
      return NextResponse.json({ status: "not_found", message: "No session with that id." }, { status: 404 });
    }
    return NextResponse.json({ status: "live_unavailable", message: "The live transcript is unavailable right now." }, { status: 502 });
  }

  const reader = upstream.body.pipeThrough(new TextDecoderStream()).getReader();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text));
      let buffer = "";
      let eventName = "message";
      let data = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line === "") {
              if (eventName === "heartbeat" || eventName === "ping") send(": heartbeat\n\n");
              else if (data) for (const event of translate(eventName, data)) send(encode(event));
              eventName = "message";
              data = "";
            } else if (line.startsWith(":")) {
              // Heartbeat comments keep the browser connection and any proxy in between open.
              send(`${line}\n\n`);
            } else {
              const colon = line.indexOf(":");
              const field = colon === -1 ? line : line.slice(0, colon);
              const fieldValue = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
              if (field === "event") eventName = fieldValue;
              else if (field === "data") data += data ? `\n${fieldValue}` : fieldValue;
            }
          }
        }
        controller.close();
      } catch {
        // The client left or the upstream dropped; either way the stream is over.
        void reader.cancel().catch(() => undefined);
        try {
          controller.close();
        } catch {
          // Already closed by a cancel.
        }
      }
    },
    cancel() {
      void reader.cancel().catch(() => undefined);
    },
  });

  return new Response(stream, { headers: sseHeaders });
}
