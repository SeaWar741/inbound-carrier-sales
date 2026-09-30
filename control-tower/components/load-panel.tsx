"use client";

import { useMemo } from "react";
import { LuMap, LuMousePointerClick, LuTruck } from "react-icons/lu";
import { EmptyState } from "@/components/empty-state";
import { equipmentLabel, formatPickup, HoldCard, LaneText } from "@/components/hold-card";
import { MarginMeter } from "@/components/margin-meter";
import { LaneMap, type LaneMapLoad } from "@/components/lane-map";
import { Section } from "@/components/section";
import type { TowerCall, TowerCarrier, WallOffer } from "@/lib/contracts";
import { formatDateTime } from "@/lib/format";
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

// The load of the carrier's latest booked hold, which is the load its next trip describes.
function latestBookedLoad(history: TowerCall[]): string | null {
  const call = history.find((c) => c.hold?.status === "booked" || c.hold?.status === "booked_unconfirmed");
  return call?.hold?.loadId ?? null;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-fg-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right text-fg">{children}</dd>
    </div>
  );
}

// The selected call's load as detail-panel sections, top to bottom: the hold while it waits on the
// desk (its buttons are the main action), the pricing, the load itself, then a settled hold.
export function LoadPanel({
  selectedCall,
  history,
  nextTrip,
}: {
  selectedCall: TowerCall | null;
  // The carrier's calls, newest first, for the negotiation path and outcome of the load.
  history: TowerCall[];
  // The carrier's next trip; its pickup and ETA show when it is this load.
  nextTrip: TowerCarrier["nextTrip"];
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
  const trip = nextTrip && loadId !== null && latestBookedLoad(history) === loadId ? nextTrip : null;

  if (selectedCall === null) {
    return <EmptyState className="py-10" icon={<LuMousePointerClick size={20} />} title="Select a call to see its load" hint="Map, pricing and hold follow the selection" />;
  }
  if (offer === null) {
    return (
      <>
        {hold && <HoldCard key={hold.holdId} call={selectedCall} hold={hold} />}
        <EmptyState className="py-10" icon={<LuTruck size={20} />} title="No load on the table yet" hint="The lane and pricing appear with the first offer" />
      </>
    );
  }

  const holdOpen = hold !== null && (hold.status === "held" || hold.status === "confirming");
  const holdCard = hold && <HoldCard key={hold.holdId} call={selectedCall} hold={hold} />;
  const pickup = trip?.pickupAt ? formatDateTime(trip.pickupAt) : lane ? formatPickup(lane.pickupAt) : null;

  return (
    <>
      {holdOpen && holdCard}
      <MarginMeter
        key={offer.loadId}
        offer={offer}
        authorizedUsd={authorizedUsd}
        agreedRate={agreedRate}
        path={path}
        outcome={loadOutcome(history, offer.loadId)}
      />
      <Section icon={LuMap} title="Load" aside={<span className="tabular truncate text-xs text-fg-muted">{offer.loadId}</span>}>
        <div className="aspect-[16/10] overflow-hidden rounded-[var(--radius-panel)] border border-line">
          <LaneMap loads={mapLoads} selectedId={loadId} />
        </div>
        {lane ? (
          <dl className="mt-3 flex flex-col gap-1.5 text-xs">
            <Fact label="Lane">
              <LaneText lane={lane} />
            </Fact>
            <Fact label="Equipment">
              {equipmentLabel(lane.equipment)} · <span className="tabular">{lane.miles.toLocaleString("en-US")} mi</span>
            </Fact>
            {pickup && (
              <Fact label="Pickup">
                <span className="tabular">{pickup}</span>
              </Fact>
            )}
            {trip?.etaAt && (
              <Fact label="ETA">
                <span className="tabular">{formatDateTime(trip.etaAt)}</span>
              </Fact>
            )}
          </dl>
        ) : (
          <p className="mt-3 text-xs text-fg-faint">Lane not recorded for this load.</p>
        )}
      </Section>
      {!holdOpen && holdCard}
    </>
  );
}
