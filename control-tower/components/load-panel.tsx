"use client";

import { CursorClick, Truck } from "@phosphor-icons/react";
import { EmptyState } from "@/components/empty-state";
import { equipmentLabel, HoldCard, LaneText } from "@/components/hold-card";
import { MarginMeter } from "@/components/margin-meter";
import { UsMap, type MapArc } from "@/components/us-map";
import type { TowerCall, WallOffer } from "@/lib/contracts";

// The load on the table: the held one while a hold stands, otherwise the one offered most recently.
function currentOffer(call: TowerCall): WallOffer | null {
  const hold = call.hold && call.hold.status !== "released" ? call.hold : null;
  if (hold) {
    const held = call.offers.find((offer) => offer.loadId === hold.loadId);
    if (held) return held;
  }
  return call.offers.at(-1) ?? null;
}

export function LoadPanel({ calls, selectedCall }: { calls: TowerCall[]; selectedCall: TowerCall | null }) {
  const offer = selectedCall ? currentOffer(selectedCall) : null;
  const hold = selectedCall?.hold ?? null;

  const arcs: MapArc[] =
    selectedCall?.offers.map((o) => ({ loadId: o.loadId, lane: o.lane, current: o.loadId === offer?.loadId })) ?? [];
  const otherOrigins = calls
    .filter((call) => call.live && call.callId !== selectedCall?.callId)
    .map((call) => currentOffer(call)?.lane?.origin.zip)
    .filter((zip): zip is string => zip !== undefined);

  // Authorizations before the latest offer are already inside its counter (evaluate_offer adds
  // them); only newer ones are headroom the agent has not priced yet.
  const authorizedUsd = offer
    ? (selectedCall?.interventions ?? [])
        .filter((i) => i.kind === "authorization" && i.loadId === offer.loadId && i.createdAt > offer.createdAt)
        .reduce((sum, i) => sum + (i.amountUsd ?? 0), 0)
    : 0;
  const agreedRate = hold && hold.status !== "released" && hold.loadId === offer?.loadId ? hold.agreedRate : null;
  const lane = offer?.lane ?? null;

  return (
    <div className="flex flex-col">
      <h2 className="border-b border-line px-3 py-2 text-xs font-medium uppercase tracking-wide text-fg-faint">Load</h2>

      <div className="border-b border-line">
        <div className="aspect-[16/10] px-2 pt-2">
          <UsMap
            arcs={arcs}
            live={selectedCall?.live ?? false}
            otherOrigins={otherOrigins}
            label={
              lane
                ? `Lane from ${lane.origin.city}, ${lane.origin.state} to ${lane.destination.city}, ${lane.destination.state}`
                : "United States map"
            }
          />
        </div>
        {offer && (
          <div className="flex items-center gap-2 px-3 pb-2 text-xs">
            {lane ? (
              <>
                <LaneText lane={lane} className="min-w-0 truncate text-fg" />
                <span className="ml-auto shrink-0 text-fg-muted">
                  {equipmentLabel(lane.equipment)} <span className="tabular">{lane.miles.toLocaleString("en-US")} mi</span>
                </span>
              </>
            ) : (
              <span className="text-fg-faint">
                Lane not recorded for <span className="tabular">{offer.loadId}</span>
              </span>
            )}
          </div>
        )}
      </div>

      {selectedCall === null ? (
        <EmptyState className="py-10" icon={<CursorClick size={20} />} title="Select a call to see its load" hint="Map, margin and hold follow the selection" />
      ) : offer === null ? (
        <EmptyState className="py-10" icon={<Truck size={20} />} title="No load on the table yet" hint="The lane and margin appear with the first offer" />
      ) : (
        <div className="border-b border-line">
          <MarginMeter key={offer.loadId} offer={offer} authorizedUsd={authorizedUsd} agreedRate={agreedRate} />
        </div>
      )}

      {selectedCall && hold && <HoldCard key={hold.holdId} call={selectedCall} hold={hold} />}
    </div>
  );
}
