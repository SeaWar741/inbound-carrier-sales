import {
  hosBreakAfterHours,
  hosBreakHours,
  hosDriveHoursPerShift,
  hosOffDutyHours,
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
  tollShare: number;
  dieselPerGal: number;
};

export type TripEstimate = {
  dieselUsd: number;
  tollsUsd: number;
  carrierNetUsd: number;
  driveHours: number;
  soloHours: number;
  teamHours: number;
  feasibility: Feasibility;
  legalEtaAt: Date;
  netPerHour: number;
  dieselPerGal: number;
  tollShare: number;
};

const msPerHour = 3_600_000;
const tenths = (n: number) => Math.round(n * 10) / 10;

// Miles are the TMS load miles, the ones the agent pitches; the route only lends its speed and toll share.
// Dollars are whole ("about $1,800" on the phone) and the net is built from the rounded parts so they add up.
export function estimateTrip(input: TripEstimateInput): TripEstimate {
  const driveHours = input.miles / input.avgMph;
  const soloHours = soloLegalHours(driveHours);
  const teamHours = teamLegalHours(driveHours);
  const windowHours = (input.deliveryAt.getTime() - input.pickupAt.getTime()) / msPerHour;
  const feasibility: Feasibility = soloHours <= windowHours ? "solo" : teamHours <= windowHours ? "team" : "impossible";
  const crewHours = feasibility === "solo" ? soloHours : teamHours;

  const dieselUsd = Math.round((input.miles / truckMpg) * input.dieselPerGal);
  const tollsUsd = Math.round(input.miles * input.tollShare * tollUsdPerMile);
  const carrierNetUsd = input.rate - dieselUsd - tollsUsd;

  return {
    dieselUsd,
    tollsUsd,
    carrierNetUsd,
    driveHours: tenths(driveHours),
    soloHours: tenths(soloHours),
    teamHours: tenths(teamHours),
    feasibility,
    legalEtaAt: new Date(input.pickupAt.getTime() + crewHours * msPerHour),
    netPerHour: crewHours > 0 ? Math.round(carrierNetUsd / crewHours) : 0,
    dieselPerGal: input.dieselPerGal,
    tollShare: input.tollShare,
  };
}
