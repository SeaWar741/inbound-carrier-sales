"use client";

import { useEffect, useRef } from "react";

// The cortex list skeleton: two bars per row.
export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden className="space-y-3 p-4">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-2">
          <div className="h-4 w-1/2 animate-pulse rounded-md bg-panel-raised" />
          <div className="h-3 w-3/4 animate-pulse rounded-md bg-panel-raised" />
        </div>
      ))}
    </div>
  );
}

// Loads the next page when the sentinel at the end of the scroller comes near. Same paging as the
// inbox list: a new observer per page length reports at once, so a page too short to scroll still
// loads the next one.
export function useLoadMore(hasMore: boolean, rowCount: number, onLoadMore: () => void) {
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = sentinel.current;
    if (!hasMore || target === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
    }, { root: scroller.current, rootMargin: "0px 0px 200px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, rowCount, onLoadMore]);
  return { scroller, sentinel };
}
