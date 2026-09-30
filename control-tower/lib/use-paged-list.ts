"use client";

import { useCallback, useState } from "react";
import { fetchTower, usePollWith } from "@/lib/use-poll";

// One page as the adapter answers it; the rest of the answer (counts, flags) comes from page 1.
type PageAnswer = { rows: unknown[]; total: number; pageSize: number };

// The loaded pages merged into one answer, with the query and page count they were read for.
export type Pages<A> = A & { query: string; pages: number };

// Pages 1 to `pages` in one go, merged in order. Every poll reads them all again, so a row that moves
// between loaded pages is never lost; a row on two pages shows once.
async function loadPages<A extends PageAnswer>(
  path: string,
  query: string,
  pages: number,
  keyOf: (row: A["rows"][number]) => string,
  signal: AbortSignal,
  name: string,
): Promise<Pages<A>> {
  const answers = await Promise.all(
    Array.from({ length: pages }, (_, i) => {
      const params = new URLSearchParams(query);
      if (i > 0) params.set("page", String(i + 1));
      const search = params.toString();
      return fetchTower<A>(`${path}${search ? `?${search}` : ""}`, signal, name);
    }),
  );
  const seen = new Set<string>();
  const rows: A["rows"][number][] = [];
  for (const row of answers.flatMap((answer) => answer.rows)) {
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return { ...answers[0]!, rows, query, pages };
}

// A polled list that grows a page at a time as the operator scrolls. `name` words the errors.
export function usePagedList<A extends PageAnswer>(
  path: string,
  listQuery: string,
  keyOf: (row: A["rows"][number]) => string,
  pollMs: number,
  name: string,
) {
  // How many pages the list shows; any new query starts again at one.
  const [paging, setPaging] = useState({ query: listQuery, pages: 1 });
  const pages = paging.query === listQuery ? paging.pages : 1;
  const { data, error, loading } = usePollWith<Pages<A>>(
    `${path}?${listQuery}#${pages}`,
    (signal) => loadPages<A>(path, listQuery, pages, keyOf, signal, name),
    pollMs,
    name,
  );
  // Until the new query answers, the list shows the old one, which must not ask for more pages.
  const current = data !== null && data.query === listQuery ? data : null;
  const loadingMore = current !== null && current.pages < pages;
  const hasMore = current !== null && current.rows.length < current.total && current.pages * current.pageSize < current.total;
  const onLoadMore = useCallback(() => {
    if (current === null || loadingMore || !hasMore) return;
    setPaging({ query: listQuery, pages: current.pages + 1 });
  }, [current, loadingMore, hasMore, listQuery]);

  return { data, error, loading, loadingMore, hasMore, onLoadMore };
}

// Writes URL state. Empty values drop the key. replaceState keeps the back button for leaving the
// page, not for every click.
export function updateSearch(changes: Record<string, string | null>) {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(changes)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const query = params.toString();
  window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
}
