import "server-only";
import { HappyRobotClient, NotFoundError } from "@happyrobot-ai/sdk";
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
  // The wall refreshes every 2 s, so a slow answer is dropped rather than retried.
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

// A run's session never changes once it exists, so it is fetched once per run and kept for the
// life of the server. The wall then costs two HappyRobot requests a tick however many calls are live.
const sessionByRun = new Map<string, { id: string; channel: Channel | null }>();

async function sessionOf(runId: string): Promise<{ id: string; channel: Channel | null } | null> {
  const known = sessionByRun.get(runId);
  if (known) return known;
  let page: unknown;
  try {
    page = await happyRobot().runs.getSessions(runId);
  } catch (error) {
    // An unknown run has no session; any other failure means HappyRobot could not answer.
    if (error instanceof NotFoundError) return null;
    throw error;
  }
  const sessions = sessionsPage.parse(page);
  const session = sessions.data.at(-1);
  if (!session) return null;
  const channel: Channel | null = session.type === "voice" || session.type === "text" ? session.type : null;
  const found = { id: session.id, channel };
  sessionByRun.set(runId, found);
  return found;
}

// Every running run of the workflow with its session. Throws when HappyRobot is unreachable.
export async function listRunningRuns(): Promise<RunningRun[]> {
  const { WORKFLOW_ID } = env();
  const runs = runsPage.parse(await happyRobot().workflows.listRuns(WORKFLOW_ID, { status: "running" }));
  return Promise.all(
    runs.data
      .filter((run) => run.status === "running")
      .map(async (run) => {
        const session = await sessionOf(run.id);
        return {
          runId: run.id,
          startedAt: new Date(run.timestamp).toISOString(),
          session: session?.channel ? { id: session.id, channel: session.channel } : null,
        };
      }),
  );
}

// The newest session of a run, live or ended; HappyRobot keeps its messages after the call.
export async function sessionForRun(runId: string): Promise<string | null> {
  return (await sessionOf(runId))?.id ?? null;
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
      body: JSON.stringify({ key: `session.${sessionId}`, env: env().HAPPYROBOT_ENVIRONMENT, payload: { instruction } }),
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
