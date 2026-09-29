import { contactChangeWindowDays } from "../constants.ts";
import type { CensusContact } from "../infra/census-client.ts";
import type { FmcsaAuthority, FmcsaCarrier, FmcsaOutOfService } from "../infra/fmcsa-client.ts";

export type VerificationStatus = "ok" | "not_eligible" | "needs_review";
export type RiskFlag = "contact_changed_recently" | "no_contact_on_file";

export type Verification = {
  eligible: boolean;
  status: VerificationStatus;
  reasons: string[];
  riskFlags: RiskFlag[];
};

export type VerificationInput =
  | { match: "none" | "multiple" }
  | {
      match: "one";
      carrier: FmcsaCarrier;
      authorities: FmcsaAuthority[];
      outOfService: FmcsaOutOfService[];
      contact: CensusContact | null;
      now: Date;
    };

type Gate = { result: "pass" } | { result: "fail" | "unknown"; reason: string };

const pass: Gate = { result: "pass" };
const fail = (reason: string): Gate => ({ result: "fail", reason });
const unknown = (reason: string): Gate => ({ result: "unknown", reason });

function allowedToOperateGate(carrier: FmcsaCarrier): Gate {
  if (carrier.allowedToOperate === "Y") return pass;
  if (carrier.allowedToOperate === "N") return fail("not_allowed_to_operate");
  return unknown("operating_status_unknown");
}

const isActive = (status: string | null | undefined) => status === "A";

// QCMobile lists only for-hire authorities, so an empty list is a known "no authority".
function authorityGate(authorities: FmcsaAuthority[]): Gate {
  const property = authorities.filter((a) => a.authorizedForProperty === "Y");
  if (property.some((a) => isActive(a.commonAuthorityStatus) || isActive(a.contractAuthorityStatus))) return pass;
  const incomplete = authorities.some(
    (a) => a.authorizedForProperty == null || a.commonAuthorityStatus == null || a.contractAuthorityStatus == null,
  );
  return incomplete ? unknown("authority_unknown") : fail("no_active_property_authority");
}

function outOfServiceGate(orders: FmcsaOutOfService[]): Gate {
  return orders.length > 0 ? fail("out_of_service") : pass;
}

// QCMobile reports the BIPD amount on file in thousands of dollars; "0" means none.
function insuranceGate(carrier: FmcsaCarrier): Gate {
  const raw = carrier.bipdInsuranceOnFile;
  if (raw == null || !/^\d+$/.test(raw)) return unknown("insurance_unknown");
  return Number(raw) > 0 ? pass : fail("no_bipd_insurance");
}

// S = Satisfactory, C = Conditional, U = Unsatisfactory; null is an unrated carrier, which most
// carriers are. Only an absent field or an unrecognised code is unknown.
function safetyRatingGate(carrier: FmcsaCarrier): Gate {
  const rating = carrier.safetyRating;
  if (rating === "U") return fail("unsatisfactory_safety_rating");
  if (rating === null || rating === "S" || rating === "C") return pass;
  return unknown("safety_rating_unknown");
}

const dayMs = 86_400_000;

export function riskFlagsFor(contact: CensusContact | null, now: Date): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const changedAt = contact?.mcs150Date;
  if (changedAt && now.getTime() - changedAt.getTime() < contactChangeWindowDays * dayMs) {
    flags.push("contact_changed_recently");
  }
  if (!contact || (!contact.email && !contact.phone && !contact.cellPhone)) flags.push("no_contact_on_file");
  return flags;
}

export function verifyCarrier(input: VerificationInput): Verification {
  if (input.match !== "one") {
    const reason = input.match === "none" ? "carrier_not_found" : "multiple_carriers_matched";
    return { eligible: false, status: "needs_review", reasons: [reason], riskFlags: [] };
  }
  const gates = [
    allowedToOperateGate(input.carrier),
    authorityGate(input.authorities),
    outOfServiceGate(input.outOfService),
    insuranceGate(input.carrier),
    safetyRatingGate(input.carrier),
  ];
  const reasons = gates.flatMap((g) => (g.result === "pass" ? [] : [g.reason]));
  const status: VerificationStatus = gates.some((g) => g.result === "fail")
    ? "not_eligible"
    : gates.some((g) => g.result === "unknown")
      ? "needs_review"
      : "ok";
  return { eligible: status === "ok", status, reasons, riskFlags: riskFlagsFor(input.contact, input.now) };
}

// "jane.doe@gmail.com" -> "j***@g***.com"
export function maskEmail(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  if (at < 1 || dot < 1) return undefined;
  return `${local[0]}***@${domain[0]}***${domain.slice(dot)}`;
}

// "(479) 820-1234" -> "***-***-1234"
export function maskPhone(phone: string): string | undefined {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `***-***-${digits.slice(-4)}` : undefined;
}
