"use client";

import { useMemo } from "react";
import type { IconType } from "react-icons";
import { LuCalendarClock, LuContainer, LuFlag, LuMap, LuMapPin, LuMousePointerClick, LuTruck } from "react-icons/lu";
import { DealCard, HowItWent, TripSection } from "@/components/deal-card";
import { EmptyState } from "@/components/empty-state";
import { formatPickup, HoldCard, LaneText } from "@/components/hold-card";
import { LaneMap, type LaneMapLoad } from "@/components/lane-map";
import { Section } from "@/components/section";
import type { TowerCall, TowerCarrier, WallOffer } from "@/lib/contracts";
import { equipmentLabel, formatDateTime } from "@/lib/format";

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

function Fact({ icon: Icon, label, children }: { icon: IconType; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="flex shrink-0 items-center gap-1.5 text-fg-muted">
        <Icon size={13} className="shrink-0" aria-hidden />
        {label}
      </dt>
      <dd className="min-w-0 truncate text-right text-fg">{children}</dd>
    </div>
  );
}

// The selected call's load as detail-panel sections, top to bottom: the deal, which is what the
// operator acts on, then the load with its map. The call's open hold is drawn here as the deal's action card, so the needs-you list above
// leaves it out.
export function LoadPanel({
  selectedCall,
  history,
  nextTrip,
}: {
  selectedCall: TowerCall | null;
  // The carrier's calls, newest first, to tell whether this load is the carrier's next trip.
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

  const standingHold = hold && hold.status !== "released" && hold.loadId === offer?.loadId ? hold : null;
  const trip = nextTrip && loadId !== null && latestBookedLoad(history) === loadId ? nextTrip : null;
  const openHold = hold && (hold.status === "held" || hold.status === "confirming") ? hold : null;
  const openHoldCard = selectedCall && openHold && <HoldCard key={openHold.holdId} call={selectedCall} hold={openHold} />;

  if (selectedCall === null) {
    return <EmptyState className="py-10" icon={<LuMousePointerClick size={20} />} title="Select a call to see its load" hint="Map, pricing and hold follow the selection" />;
  }
  if (offer === null) {
    return (
      <>
        {hold && (
          <DealCard
            call={selectedCall}
            loadId={hold.loadId}
            postedRate={hold.postedRate}
            maxBuy={hold.maxBuy}
            miles={hold.lane?.miles ?? null}
            trip={hold.status === "released" ? null : hold.trip}
            action={openHoldCard}
          />
        )}
        {hold && hold.status !== "released" && hold.trip && <TripSection trip={hold.trip} />}
        <EmptyState className="py-10" icon={<LuTruck size={20} />} title="No load on the table yet" hint="The lane and pricing appear with the first offer" />
      </>
    );
  }

  const pickup = trip?.pickupAt ? formatDateTime(trip.pickupAt) : lane ? formatPickup(lane.pickupAt) : null;
  // The hold's legal (HOS) ETA beats the next trip's flat-speed one when this load's hold has an estimate.
  const eta = standingHold?.trip?.legalEtaAt ?? trip?.etaAt ?? null;

  return (
    <>
      {/* A hold on a load that has no offer on this call still needs its buttons. */}
      {openHold && openHold.loadId !== offer.loadId && <div className="p-4 pb-0">{openHoldCard}</div>}
      <DealCard
        key={offer.loadId}
        call={selectedCall}
        loadId={offer.loadId}
        postedRate={offer.postedRate ?? standingHold?.postedRate ?? null}
        maxBuy={offer.maxBuy ?? standingHold?.maxBuy ?? null}
        miles={lane?.miles ?? null}
        trip={standingHold?.trip ?? null}
        action={openHold?.loadId === offer.loadId ? openHoldCard : undefined}
      />
      <Section icon={LuMap} title="Load" aside={<span className="tabular truncate text-xs text-fg-muted">{offer.loadId}</span>}>
        <div className="h-[200px] overflow-hidden rounded-lg border border-line">
          <LaneMap loads={mapLoads} selectedId={loadId} />
        </div>
        {lane ? (
          <dl className="mt-3 flex flex-col gap-2 text-xs">
            <Fact icon={LuMapPin} label="Lane">
              <LaneText lane={lane} />
            </Fact>
            <Fact icon={LuContainer} label="Equipment">
              {equipmentLabel(lane.equipment)} · <span className="tabular">{lane.miles.toLocaleString("en-US")} mi</span>
            </Fact>
            {pickup && (
              <Fact icon={LuCalendarClock} label="Pickup">
                <span className="tabular">{pickup}</span>
              </Fact>
            )}
            {eta && (
              <Fact icon={LuFlag} label="ETA">
                <span className="tabular">{formatDateTime(eta)}</span>
              </Fact>
            )}
          </dl>
        ) : (
          <p className="mt-3 text-xs text-fg-faint">Lane not recorded for this load.</p>
        )}
      </Section>
      <HowItWent call={selectedCall} loadId={offer.loadId} />
      {standingHold?.trip && <TripSection trip={standingHold.trip} />}
    </>
  );
}
