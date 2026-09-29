import { NextResponse } from "next/server";
import { getWall } from "@/lib/adapter";
import type { AdapterWallCall, AdapterWallResponse, ErrorResponse, TowerCall, TowerWall } from "@/lib/contracts";
import { listRunningRuns, type RunningRun } from "@/lib/happyrobot";

// Stages the call data settles on its own; every other stage of a call that is no longer running is "ended".
const settledStages = new Set<TowerCall["stage"]>(["holding", "booked", "released"]);

// Shared by every open tab; with the 2 s browser poll it keeps the tower well inside the API quota.
const cacheMs = 2_000;
type WallAnswer = { httpStatus: number; body: TowerWall | ErrorResponse };
// At most one upstream fetch per cacheMs (every 2 s); concurrent requests share the in-flight one.
let cached: { at: number; answer: Promise<WallAnswer> } | undefined;

function connectingCall(run: RunningRun): TowerCall {
  return {
    callId: run.runId,
    mcNumber: null,
    dotNumber: null,
    eligible: false,
    verified: false,
    otp: { attempts: 0, locked: false, expiresAt: null },
    stage: "connecting",
    round: null,
    risk: "green",
    riskReason: null,
    offers: [],
    hold: null,
    events: [],
    interventions: [],
    createdAt: run.startedAt,
    live: run.session !== null,
    sessionId: run.session?.id ?? null,
    channel: run.session?.channel ?? null,
  };
}

function merge(wall: AdapterWallResponse, runs: RunningRun[] | undefined): TowerWall {
  if (runs === undefined) {
    const calls = wall.calls.map((call): TowerCall => ({ ...call, live: false, sessionId: null, channel: null }));
    return { ...wall, calls, liveUnavailable: true };
  }
  const running = new Map(runs.map((run) => [run.runId, run]));
  const known = new Set(wall.calls.map((call) => call.callId));
  const towerCall = (call: AdapterWallCall): TowerCall => {
    const run = running.get(call.callId);
    const stage = run === undefined && !settledStages.has(call.stage) ? "ended" : call.stage;
    return { ...call, stage, live: run?.session != null, sessionId: run?.session?.id ?? null, channel: run?.session?.channel ?? null };
  };
  // Newest first, like the adapter: calls not yet in the adapter started most recently.
  const connecting = runs
    .filter((run) => !known.has(run.runId))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(connectingCall);
  return { ...wall, calls: [...connecting, ...wall.calls.map(towerCall)], liveUnavailable: false };
}

async function load(): Promise<WallAnswer> {
  const [wall, runs] = await Promise.all([getWall(), listRunningRuns().catch(() => undefined)]);
  if (!wall.ok) return { httpStatus: wall.httpStatus, body: wall.body };
  return { httpStatus: 200, body: merge(wall.body, runs) };
}

export async function GET() {
  const now = Date.now();
  if (cached === undefined || now - cached.at >= cacheMs) cached = { at: now, answer: load() };
  const { httpStatus, body } = await cached.answer;
  return NextResponse.json(body, { status: httpStatus, headers: { "cache-control": "no-store" } });
}
