"use client";

import { useMemo } from "react";
import { LuMousePointerClick, LuTruck } from "react-icons/lu";
import { EmptyState } from "@/components/empty-state";
import { equipmentLabel, HoldCard, LaneText } from "@/components/hold-card";
import { MarginMeter } from "@/components/margin-meter";
import { LaneMap, type LaneMapLoad } from "@/components/lane-map";
import type { TowerCall, WallOffer } from "@/lib/contracts";
import { loadOutcome, negotiationPath } from "@/lib/pricing";

// The load on the table: the held one while a hold stands, otherwise the one offered most recently.
function currentOffer(call: TowerCall): WallOffer | null {
  const hold = call.hold && call.hold.status !== "released" ? call.hold : null;
  if (hold) {
    const held = call.offers.find((offer) => offer.loadId === hold.loadId);
    if (held) return held;
  }
  return call.offers.at(-1) ?? null;
}

// One view of the load on the table at a time: "pricing" is the meter, receipt and negotiation, led
// by the hold while it waits on the desk; "load" is the map, the lane and the hold details.
export function LoadPanel({
  selectedCall,
  history,
  view,
}: {
  selectedCall: TowerCall | null;
  // The carrier's calls, newest first, for the negotiation path and outcome of the load.
  history: TowerCall[];
  view: "pricing" | "load";
}) {
  const offer = selectedCall ? currentOffer(selectedCall) : null;
  const hold = selectedCall?.hold ?? null;
  const lane = offer?.lane ?? null;

  // The lane on the table; the load has not been picked up while the carrier is on the call.
  const loadId = offer?.loadId ?? null;
  const mapLoads = useMemo<LaneMapLoad[]>(
    () =>
      loadId && lane
        ? [
            {
              id: loadId,
              originZip: lane.origin.zip,
              destinationZip: lane.destination.zip,
              progress: 0,
              status: "upcoming",
              label: `${loadId} ${lane.origin.city}, ${lane.origin.state} to ${lane.destination.city}, ${lane.destination.state}`,
            },
          ]
        : [],
    [loadId, lane],
  );

  // Authorizations before the latest offer are already inside its counter (evaluate_offer adds
  // them); only newer ones are headroom the agent has not priced yet.
  const authorizedUsd = offer
    ? (selectedCall?.interventions ?? [])
        .filter((i) => i.kind === "authorization" && i.loadId === offer.loadId && i.createdAt > offer.createdAt)
        .reduce((sum, i) => sum + (i.amountUsd ?? 0), 0)
    : 0;
  const path = useMemo(() => (loadId ? negotiationPath(history, loadId) : []), [history, loadId]);
  const agreedRate = hold && hold.status !== "released" && hold.loadId === offer?.loadId ? hold.agreedRate : null;

  if (selectedCall === null) {
    return <EmptyState className="py-10" icon={<LuMousePointerClick size={20} />} title="Select a call to see its load" hint="Map, pricing and hold follow the selection" />;
  }
  const noOffer = <EmptyState className="py-10" icon={<LuTruck size={20} />} title="No load on the table yet" hint="The lane and pricing appear with the first offer" />;
  const holdCard = hold && <HoldCard key={hold.holdId} call={selectedCall} hold={hold} />;

  if (view === "pricing") {
    // The confirm and release buttons are the desk's main action, so an open hold comes first.
    const holdOpen = hold !== null && (hold.status === "held" || hold.status === "confirming");
    return (
      <div className="flex flex-col divide-y divide-line">
        {holdOpen && holdCard}
        {offer === null ? (
          noOffer
        ) : (
          <MarginMeter
            key={offer.loadId}
            offer={offer}
            authorizedUsd={authorizedUsd}
            agreedRate={agreedRate}
            path={path}
            outcome={loadOutcome(history, offer.loadId)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-line">
      <div>
        <div className="aspect-[16/10] px-2 pt-2">
          <LaneMap loads={mapLoads} selectedId={loadId} />
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
      {holdCard || (offer === null && noOffer)}
    </div>
  );
}
