import { NextResponse } from "next/server";
import { getWall } from "@/lib/adapter";
import type { ErrorResponse, TowerWall } from "@/lib/contracts";

// Shared by every open tab; with the 2 s browser poll it keeps the tower well inside the adapter's load.
const cacheMs = 2_000;
type WallAnswer = { httpStatus: number; body: TowerWall | ErrorResponse };
// At most one upstream fetch per cacheMs (every 2 s); concurrent requests share the in-flight one.
let cached: { at: number; answer: Promise<WallAnswer> } | undefined;

async function load(): Promise<WallAnswer> {
  const wall = await getWall();
  return { httpStatus: wall.httpStatus, body: wall.body };
}

export async function GET() {
  const now = Date.now();
  if (cached === undefined || now - cached.at >= cacheMs) cached = { at: now, answer: load() };
  const { httpStatus, body } = await cached.answer;
  return NextResponse.json(body, { status: httpStatus, headers: { "cache-control": "no-store" } });
}
