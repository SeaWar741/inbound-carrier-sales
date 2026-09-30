"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LuLoaderCircle, LuTriangleAlert, LuTruck } from "react-icons/lu";
import type { DemandCarrier, DemandLane, TowerDemandCarriers } from "@/lib/contracts";
import { carrierName } from "@/lib/format";
import { asksLabel, carrierSearchHref, demandCarriersQuery } from "@/lib/demand";
import { fetchTower } from "@/lib/use-poll";

type Loaded = { rows: DemandCarrier[]; total: number; page: number };

function CarrierRow({ carrier }: { carrier: DemandCarrier }) {
  const href = carrierSearchHref(carrier);
  const body = (
    <>
      <LuTruck size={14} className="shrink-0 text-fg-faint" aria-hidden />
      <span className="min-w-0 truncate font-medium text-fg">{carrierName({ ...carrier, dotNumber: null })}</span>
      {carrier.carrierName && carrier.mcNumber && <span className="tabular shrink-0 text-xs text-fg-muted">MC {carrier.mcNumber}</span>}
      <span className="tabular ml-auto shrink-0 text-fg-muted">{asksLabel(carrier.asks)}</span>
    </>
  );
  const row = "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm";
  return (
    <li>
      {href ? (
        <Link href={href} className={`${row} outline-none hover:bg-panel-raised focus-visible:ring-2 focus-visible:ring-accent/40`}>
          {body}
        </Link>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}

// The carriers behind one expanded row, most asks first as the adapter sends them. Read once when
// the row opens; "Load more" appends the next page.
export function DemandCarriers({ lane }: { lane: DemandLane }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const loading = error === null && (loaded === null || loaded.page < page);
  // The rows poll, so the lane is a new object each time; the query string is what decides a read.
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
    <div className="border-t border-line bg-bg px-4 py-3 pl-10">
      {error && (
        <p role="status" className="mb-2 flex items-center gap-1 text-xs text-risk">
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
        <p role="status" className="flex items-center gap-2 text-xs text-fg-faint">
          <LuLoaderCircle size={14} className="animate-spin" aria-hidden />
          Loading carriers...
        </p>
      )}
      {loaded !== null && rows.length === 0 && <p className="text-sm text-fg-muted">No carriers recorded on this lane</p>}
      {rows.length > 0 && (
        <ul aria-label="Carriers who asked" className="max-w-2xl">
          {rows.map((carrier) => (
            <CarrierRow key={carrier.key} carrier={carrier} />
          ))}
        </ul>
      )}
      {loaded !== null && loaded.total > rows.length && (
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            // After a failed page the next page is the same one, so the attempt forces the read.
            setError(null);
            setPage(loaded.page + 1);
            setAttempt((n) => n + 1);
          }}
          className="mt-2 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-line bg-panel px-3 text-xs font-medium text-fg shadow-xs hover:bg-panel-raised disabled:cursor-default disabled:opacity-60"
        >
          {loading && <LuLoaderCircle size={12} className="animate-spin" aria-hidden />}
          Load more ({rows.length} of {loaded.total})
        </button>
      )}
    </div>
  );
}
