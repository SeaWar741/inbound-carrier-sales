"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LuChevronRight, LuLoaderCircle, LuTriangleAlert } from "react-icons/lu";
import type { DemandCarrier, DemandLane, TowerDemandCarriers } from "@/lib/contracts";
import { carrierName } from "@/lib/format";
import { asksLabel, carrierHref, demandCarriersQuery } from "@/lib/demand";
import { fetchTower } from "@/lib/use-poll";

type Loaded = { rows: DemandCarrier[]; total: number; page: number };

// One carrier; the whole row opens the carrier's own page.
function CarrierRow({ carrier }: { carrier: DemandCarrier }) {
  return (
    <li>
      <Link
        href={carrierHref(carrier.key)}
        className="flex h-11 min-w-0 items-center gap-3 px-4 text-sm outline-none transition-colors hover:bg-panel-raised focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset"
      >
        <span className="min-w-0 truncate font-medium text-fg">{carrierName({ ...carrier, dotNumber: null })}</span>
        {carrier.carrierName && carrier.mcNumber && <span className="shrink-0 font-mono text-xs text-fg-muted">MC {carrier.mcNumber}</span>}
        <span className="tabular ml-auto shrink-0 text-xs text-fg-muted">{asksLabel(carrier.asks)}</span>
        <LuChevronRight size={14} className="shrink-0 text-fg-faint" aria-hidden />
      </Link>
    </li>
  );
}

// The carriers behind one lane, most asks first as the adapter sends them. Read once per lane;
// "Load more" appends the next page.
export function DemandCarriers({ lane }: { lane: Pick<DemandLane, "originState" | "destinationState" | "equipment"> }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const loading = error === null && (loaded === null || loaded.page < page);
  // The lane is a new object on every poll of the page; the query string is what decides a read.
  const query = demandCarriersQuery(lane, page);

  useEffect(() => {
    const controller = new AbortController();
    fetchTower<TowerDemandCarriers>(`/api/demand/carriers?${query}`, controller.signal, "carrier list")
      .then((answer) => {
        setError(null);
        setLoaded((prev) => {
          // A carrier on two pages shows once.
          const rows = page === 1 || prev === null ? [] : [...prev.rows];
          const seen = new Set(rows.map((row) => row.key));
          for (const row of answer.rows) if (!seen.has(row.key)) rows.push(row);
          return { rows, total: answer.total, page };
        });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error && err.message.startsWith("The carrier list") ? err.message : "Could not reach the carrier list");
      });
    return () => controller.abort();
  }, [query, page, attempt]);

  const rows = loaded?.rows ?? [];
  return (
    <section aria-labelledby="who-asked" className="overflow-hidden rounded-lg border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 id="who-asked" className="text-xs font-medium tracking-wide text-fg-muted uppercase">
          Who asked
        </h2>
        {loaded && <span className="tabular text-xs text-fg-faint">{loaded.total}</span>}
      </div>
      {error && (
        <p role="status" className="flex items-center gap-1 px-4 py-3 text-xs text-risk">
          <LuTriangleAlert size={12} className="shrink-0" aria-hidden />
          {error}
          <button
            type="button"
            onClick={() => {
              setError(null);
              setAttempt((n) => n + 1);
            }}
            className="ml-1 cursor-pointer font-medium underline"
          >
            Retry
          </button>
        </p>
      )}
      {loaded === null && !error && (
        <p role="status" className="flex items-center gap-2 px-4 py-3 text-xs text-fg-faint">
          <LuLoaderCircle size={14} className="animate-spin" aria-hidden />
          Loading carriers...
        </p>
      )}
      {loaded !== null && rows.length === 0 && <p className="px-4 py-3 text-sm text-fg-muted">No carriers recorded on this lane</p>}
      {rows.length > 0 && (
        <ul aria-label="Carriers who asked" className="divide-y divide-line">
          {rows.map((carrier) => (
            <CarrierRow key={carrier.key} carrier={carrier} />
          ))}
        </ul>
      )}
      {loaded !== null && loaded.total > rows.length && (
        <div className="flex justify-center border-t border-line px-4 py-3">
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              // After a failed page the next page is the same one, so the attempt forces the read.
              setError(null);
              setPage(loaded.page + 1);
              setAttempt((n) => n + 1);
            }}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-line bg-panel px-3 text-xs font-medium text-fg hover:bg-panel-raised disabled:cursor-default disabled:opacity-60"
          >
            {loading && <LuLoaderCircle size={12} className="animate-spin" aria-hidden />}
            Load more ({rows.length} of {loaded.total})
          </button>
        </div>
      )}
    </section>
  );
}
