"use client";

import { createContext, useContext } from "react";
import type { TowerWall } from "@/lib/contracts";
import { usePoll } from "@/lib/use-poll";

const pollMs = 2_000;

export type WallState = {
  wall: TowerWall | null;
  error: string | null;
  loading: boolean;
  // When the shown wall was fetched; used to tell the operator how stale it is after an error.
  updatedAt: number | null;
};

// Polls /api/wall every 2 s while the tab is visible. A failed poll keeps the last good wall.
export function useWall(): WallState {
  const { data, error, loading, updatedAt } = usePoll<TowerWall>("/api/wall", pollMs, "wall");
  return { wall: data, error, loading, updatedAt };
}

// The tower layout polls the wall once and every page reads it from here.
export const WallContext = createContext<WallState>({ wall: null, error: null, loading: true, updatedAt: null });

export function useSharedWall(): WallState {
  return useContext(WallContext);
}
