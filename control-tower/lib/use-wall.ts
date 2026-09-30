"use client";

import { createContext, useContext } from "react";
import type { TowerWall } from "@/lib/contracts";
import type { PollState } from "@/lib/use-poll";

// The tower layout polls the wall once and every page reads it from here.
export const WallContext = createContext<PollState<TowerWall>>({ data: null, error: null, loading: true, updatedAt: null });

export function useSharedWall(): PollState<TowerWall> {
  return useContext(WallContext);
}
