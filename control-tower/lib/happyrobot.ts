import "server-only";
import { HappyRobotClient } from "@happyrobot-ai/sdk";
import { z } from "zod";
import type { Channel } from "./contracts";
import { env } from "./env";

// HappyRobot platform calls. The SDK covers runs, sessions and voice tokens; signals and the raw
// session stream (heartbeats and client aborts included) go over fetch against the same API.

const apiBase = "https://platform.happyrobot.ai/api/v2";
// The signals endpoint answers only once the running agent has taken the signal, about 11 s today.
const signalTimeoutMs = 20_000;

let client: HappyRobotClient | undefined;
function happyRobot(): HappyRobotClient {
  // The wall refreshes every second, so a slow answer is dropped rather than retried.
  client ??= new HappyRobotClient({ apiKey: env().HAPPYROBOT_API_KEY, timeout: 5_000, maxRetries: 0 });
  return client;
}

const runsPage = z.object({
  data: z.array(z.object({ id: z.string(), status: z.string(), timestamp: z.string() })),
});

const sessionsPage = z.object({
  data: z.array(z.object({ id: z.string(), status: z.string(), type: z.string(), timestamp: z.string() })),
});

export type RunningRun = {
  runId: string;
  startedAt: string;
  // The in-progress session of the run, or null when none has started yet.
  session: { id: string; channel: Channel } | null;
};

// Every running run of the workflow with its in-progress session. Throws when HappyRobot is unreachable.
export async function listRunningRuns(): Promise<RunningRun[]> {
  const { WORKFLOW_ID } = env();
  const runs = runsPage.parse(await happyRobot().workflows.listRuns(WORKFLOW_ID, { status: "running" }));
  return Promise.all(
    runs.data
      .filter((run) => run.status === "running")
      .map(async (run) => {
        const sessions = sessionsPage.parse(await happyRobot().runs.getSessions(run.id));
        const live = sessions.data.find((session) => session.status === "in-progress");
        const channel: Channel | undefined = live?.type === "voice" || live?.type === "text" ? live.type : undefined;
        return {
          runId: run.id,
          startedAt: new Date(run.timestamp).toISOString(),
          session: live && channel ? { id: live.id, channel } : null,
        };
      }),
  );
}

// A run's session never changes once it exists, so found ids are kept for the life of the server.
const sessionByRun = new Map<string, string>();

// The newest session of a run, live or ended; HappyRobot keeps its messages after the call.
export async function sessionForRun(runId: string): Promise<string | null> {
  const known = sessionByRun.get(runId);
  if (known) return known;
  const sessions = sessionsPage.parse(await happyRobot().runs.getSessions(runId));
  const session = sessions.data.at(-1);
  if (!session) return null;
  sessionByRun.set(runId, session.id);
  return session.id;
}

const voiceToken = z.object({ url: z.string(), token: z.string(), room_name: z.string() });

export async function createVoiceToken(sessionId: string, takeover: boolean) {
  const token = voiceToken.parse(await happyRobot().voice.createToken({ session_id: sessionId, should_takeover: takeover }));
  return { url: token.url, token: token.token, roomName: token.room_name };
}

const published = z.object({ status: z.literal("published") });

// Delivers an instruction to the running agent of one session. True only when HappyRobot says it was published.
export async function publishSignal(sessionId: string, instruction: string): Promise<boolean> {
  try {
    const response = await fetch(`${apiBase}/signals`, {
      method: "POST",
      headers: { authorization: `Bearer ${env().HAPPYROBOT_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ key: `session.${sessionId}`, env: "development", payload: { instruction } }),
      signal: AbortSignal.timeout(signalTimeoutMs),
      cache: "no-store",
    });
    if (!response.ok) return false;
    return published.safeParse(await response.json().catch(() => undefined)).success;
  } catch {
    return false;
  }
}

// Opens the raw SSE stream of one session; the caller owns the body and aborts it through `signal`.
export async function openSessionStream(sessionId: string, signal: AbortSignal): Promise<Response> {
  return fetch(`${apiBase}/sessions/${encodeURIComponent(sessionId)}/stream?backfillLimit=500`, {
    headers: { authorization: `Bearer ${env().HAPPYROBOT_API_KEY}`, accept: "text/event-stream" },
    signal,
    cache: "no-store",
  });
}
