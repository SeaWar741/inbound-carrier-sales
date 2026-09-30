"use client";

import { Tooltip } from "antd";
import Link from "next/link";
import { useEffect, useState } from "react";
import { LuInbox, LuLoaderCircle, LuTriangleAlert } from "react-icons/lu";
import { iconButton } from "@/components/paged-table";
import type { DemandCarrier, DemandLane, TowerDemandCarriers } from "@/lib/contracts";
import { asksLabel, carrierListHref, demandCarriersQuery, demandInboxHref } from "@/lib/demand";
import { fetchTower } from "@/lib/use-poll";

type Loaded = { rows: DemandCarrier[]; total: number; page: number };

// One carrier: MC and name open it on the Carriers page, the icon opens its calls in the inbox.
function CarrierRow({ carrier }: { carrier: DemandCarrier }) {
  const href = carrierListHref(carrier);
  const who = (
    <>
      <span className="w-24 shrink-0 font-mono text-xs text-fg-muted">MC {carrier.mcNumber ?? "-"}</span>
      <span className="min-w-0 truncate font-medium text-fg">{carrier.carrierName ?? "Unknown carrier"}</span>
    </>
  );
  return (
    <li className="flex h-9 min-w-0 items-center gap-3 text-sm">
      {href ? (
        <Link href={href} className="flex min-w-0 items-center gap-3 rounded outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent/40">
          {who}
        </Link>
      ) : (
        <span className="flex min-w-0 items-center gap-3">{who}</span>
      )}
      <span className="tabular ml-auto shrink-0 text-xs text-fg-muted">{asksLabel(carrier.asks)}</span>
      <Tooltip title="Open in Inbox">
        <Link href={demandInboxHref(carrier)} aria-label={`Open ${carrier.carrierName ?? "carrier"} in Inbox`} className={iconButton}>
          <LuInbox size={15} aria-hidden />
        </Link>
      </Tooltip>
    </li>
  );
}

// Who asked for one exact lane, most asks first as the adapter sends them. Read once when the row
// opens; "Show more" appends the next page.
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

  if (error) {
    return (
      <p role="status" className="flex items-center gap-1.5 py-1 text-xs text-risk">
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
    );
  }
  if (loaded === null) {
    return (
      <p role="status" className="flex items-center gap-1.5 py-1 text-xs text-fg-muted">
        <LuLoaderCircle size={12} className="animate-spin" aria-hidden />
        Loading who asked...
      </p>
    );
  }
  if (loaded.rows.length === 0) return <p className="py-1 text-xs text-fg-muted">No carriers recorded on this lane.</p>;
  return (
    <div className="py-1">
      <p className="text-xs font-medium text-fg-muted">Who asked</p>
      <ul aria-label="Carriers who asked" className="mt-1 divide-y divide-line">
        {loaded.rows.map((carrier) => (
          <CarrierRow key={carrier.key} carrier={carrier} />
        ))}
      </ul>
      {loaded.total > loaded.rows.length && (
        <button
          type="button"
          disabled={loading}
          onClick={() => setPage(loaded.page + 1)}
          className="mt-2 inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-accent hover:underline disabled:cursor-default disabled:opacity-60"
        >
          {loading && <LuLoaderCircle size={12} className="animate-spin" aria-hidden />}
          Show {loaded.total - loaded.rows.length} more
        </button>
      )}
    </div>
  );
}
