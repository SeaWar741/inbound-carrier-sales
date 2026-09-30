import {
  hosBreakAfterHours,
  hosBreakHours,
  hosDriveHoursPerShift,
  hosOffDutyHours,
  lateToleranceHours,
  teamDriveHoursPerDay,
  tollUsdPerMile,
  truckMpg,
} from "../constants.ts";

// What a load costs the carrier and whether it can legally make the window. Pure arithmetic:
// prices and speeds come in as numbers, and nothing here knows the broker's max buy.

export const feasibilities = ["solo", "team", "impossible"] as const;
export type Feasibility = (typeof feasibilities)[number];

// EIA weekly diesel areas: PADD 1 is split into 1A/1B/1C, California has its own series.
const areaByState: Record<string, string> = {
  CT: "R1X", ME: "R1X", MA: "R1X", NH: "R1X", RI: "R1X", VT: "R1X",
  DE: "R1Y", DC: "R1Y", MD: "R1Y", NJ: "R1Y", NY: "R1Y", PA: "R1Y",
  FL: "R1Z", GA: "R1Z", NC: "R1Z", SC: "R1Z", VA: "R1Z", WV: "R1Z",
  IL: "R20", IN: "R20", IA: "R20", KS: "R20", KY: "R20", MI: "R20", MN: "R20", MO: "R20",
  NE: "R20", ND: "R20", OH: "R20", OK: "R20", SD: "R20", TN: "R20", WI: "R20",
  AL: "R30", AR: "R30", LA: "R30", MS: "R30", NM: "R30", TX: "R30",
  CO: "R40", ID: "R40", MT: "R40", UT: "R40", WY: "R40",
  AK: "R50", AZ: "R50", HI: "R50", NV: "R50", OR: "R50", WA: "R50",
  CA: "SCA",
};
const nationalArea = "NUS";

// $/gal for a state, falling back to the national price for an unknown state or a missing area.
function statePrice(prices: ReadonlyMap<string, number>, state: string): number | undefined {
  return prices.get(areaByState[state.toUpperCase()] ?? nationalArea) ?? prices.get(nationalArea);
}

// A truck buys fuel at both ends, so the lane pays the mean of the two area prices.
export function laneDieselPerGal(prices: ReadonlyMap<string, number>, origState: string, destState: string): number | undefined {
  const origin = statePrice(prices, origState);
  const destination = statePrice(prices, destState);
  return origin === undefined || destination === undefined ? undefined : (origin + destination) / 2;
}

// 49 CFR 395.3 for one driver: an 11 h shift, a 30 min break in every shift that drives past 8 h,
// and 10 h off between shifts.
export function soloLegalHours(driveHours: number): number {
  if (driveHours <= 0) return 0;
  const shifts = Math.ceil(driveHours / hosDriveHoursPerShift);
  const lastShiftDrive = driveHours - hosDriveHoursPerShift * (shifts - 1);
  const breaks = shifts - 1 + (lastShiftDrive > hosBreakAfterHours ? 1 : 0);
  return driveHours + hosBreakHours * breaks + hosOffDutyHours * (shifts - 1);
}

export function teamLegalHours(driveHours: number): number {
  return (driveHours * 24) / teamDriveHoursPerDay;
}

export type TripEstimateInput = {
  miles: number;
  rate: number;
  pickupAt: Date;
  deliveryAt: Date;
  avgMph: number;
  // Null when no route was found: tolls are then left out.
  tollShare: number | null;
  dieselPerGal: number;
};

// What the carrier keeps at a rate after diesel and tolls, and whether the window is legal. The hold
// stores it as is; it never carries the max buy. Times are ISO strings so it serializes unchanged.
export type TripSnapshot = {
  rate: number;
  dieselUsd: number;
  tollsUsd: number;
  carrierNetUsd: number;
  feasibility: Feasibility;
  legalEtaAt: string;
  // Hours the chosen crew needs by law: solo when one driver makes the appointment, else a team.
  legalHours: number;
  // How far past the appointment the chosen crew lands; 0 when on time.
  lateHours: number;
  // The TMS delivery appointment, echoed so the snapshot can show it next to the legal ETA.
  deliveryAt: string;
  netPerHour: number;
  // The diesel price and toll share the estimate used; tollShare is null when no route was found,
  // and then tolls are left out rather than guessed.
  dieselPerGal: number;
  tollShare: number | null;
};

const msPerHour = 3_600_000;
const tenths = (n: number) => Math.round(n * 10) / 10;
// The price and toll share the estimate used, shown with it on the hold; rounding keeps float noise
// (7.3454999999999995) out of the stored JSON.
const roundTo = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

// Miles are the TMS load miles, the ones the agent pitches; the route only lends its speed and toll share.
// Dollars are whole ("about $1,800" on the phone) and the net is built from the rounded parts so they add up.
export function estimateTrip(input: TripEstimateInput): TripSnapshot {
  const driveHours = input.miles / input.avgMph;
  const soloHours = soloLegalHours(driveHours);
  const teamHours = teamLegalHours(driveHours);
  const windowHours = (input.deliveryAt.getTime() - input.pickupAt.getTime()) / msPerHour;
  // A receiver still takes a truck inside the appointment grace, so a crew that lands within it makes the load.
  const latestHours = windowHours + lateToleranceHours;
  const feasibility: Feasibility = soloHours <= latestHours ? "solo" : teamHours <= latestHours ? "team" : "impossible";
  const crewHours = feasibility === "solo" ? soloHours : teamHours;

  const dieselUsd = Math.round((input.miles / truckMpg) * input.dieselPerGal);
  const tollsUsd = input.tollShare === null ? 0 : Math.round(input.miles * input.tollShare * tollUsdPerMile);
  const carrierNetUsd = input.rate - dieselUsd - tollsUsd;

  return {
    rate: input.rate,
    dieselUsd,
    tollsUsd,
    carrierNetUsd,
    feasibility,
    legalEtaAt: new Date(input.pickupAt.getTime() + crewHours * msPerHour).toISOString(),
    legalHours: tenths(crewHours),
    lateHours: tenths(Math.max(0, crewHours - windowHours)),
    deliveryAt: input.deliveryAt.toISOString(),
    netPerHour: crewHours > 0 ? Math.round(carrierNetUsd / crewHours) : 0,
    dieselPerGal: roundTo(input.dieselPerGal, 3),
    tollShare: input.tollShare === null ? null : roundTo(input.tollShare, 4),
  };
}
