import { DemandLane, LaneFrame } from "@/components/demand/demand-lane";
import { parseDemandLaneParam } from "@/lib/demand";

// One lane's page. A hand-edited path that is not a lane never reaches the adapter.
export default async function DemandLanePage({ params }: { params: Promise<{ lane: string }> }) {
  const lane = parseDemandLaneParam((await params).lane);
  if (lane === null) {
    return (
      <LaneFrame>
        <p className="mt-4 text-sm text-fg-muted">This is not a lane on the Demand page.</p>
      </LaneFrame>
    );
  }
  return <DemandLane lane={lane} />;
}
