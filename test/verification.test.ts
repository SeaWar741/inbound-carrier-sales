import { describe, expect, it } from "vitest";
import { maskEmail, maskPhone, riskFlagsFor, verifyCarrier, type VerificationInput } from "../src/domain/verification.ts";
import type { CensusContact } from "../src/infra/census-client.ts";
import type { FmcsaAuthority, FmcsaCarrier } from "../src/infra/fmcsa-client.ts";

const now = new Date("2026-09-29T12:00:00Z");

// Mirrors the J B Hunt record captured in test/fixtures/fmcsa.
const carrier: FmcsaCarrier = {
  dotNumber: 80806,
  legalName: "J B HUNT TRANSPORT INC",
  dbaName: null,
  allowedToOperate: "Y",
  bipdInsuranceOnFile: "3500",
  safetyRating: "S",
};
const authority: FmcsaAuthority = {
  docketNumber: 135797,
  prefix: "MC",
  authorizedForProperty: "Y",
  commonAuthorityStatus: "A",
  contractAuthorityStatus: "A",
};
const contact: CensusContact = {
  email: "dispatch@example-carrier.com",
  phone: "5555550142",
  cellPhone: null,
  mcs150Date: new Date("2025-07-07T00:00:00Z"),
};

const input = (overrides: Partial<Extract<VerificationInput, { match: "one" }>> = {}): VerificationInput => ({
  match: "one",
  carrier,
  authorities: [authority],
  outOfService: [],
  contact,
  now,
  ...overrides,
});

describe("verifyCarrier", () => {
  it("clears a carrier that passes every gate", () => {
    expect(verifyCarrier(input())).toEqual({ eligible: true, status: "ok", reasons: [], riskFlags: [] });
  });

  it("rejects a carrier not allowed to operate", () => {
    const result = verifyCarrier(input({ carrier: { ...carrier, allowedToOperate: "N" } }));
    expect(result).toMatchObject({ eligible: false, status: "not_eligible", reasons: ["not_allowed_to_operate"] });
  });

  it("rejects a carrier under an active out-of-service order", () => {
    const result = verifyCarrier(input({ outOfService: [{ oosDate: "2026-09-26", oosReason: "NRC" }] }));
    expect(result).toMatchObject({ status: "not_eligible", reasons: ["out_of_service"] });
  });

  it("rejects without active property authority, including an empty authority list", () => {
    const inactive = { ...authority, commonAuthorityStatus: "I", contractAuthorityStatus: "N" };
    const passengerOnly = { ...authority, authorizedForProperty: "N" };
    for (const authorities of [[inactive], [passengerOnly], []]) {
      expect(verifyCarrier(input({ authorities }))).toMatchObject({
        status: "not_eligible",
        reasons: ["no_active_property_authority"],
      });
    }
  });

  it("accepts contract authority alone", () => {
    const contractOnly = { ...authority, commonAuthorityStatus: "I", contractAuthorityStatus: "A" };
    expect(verifyCarrier(input({ authorities: [contractOnly] })).status).toBe("ok");
  });

  it("rejects a carrier with no BIPD insurance on file", () => {
    const result = verifyCarrier(input({ carrier: { ...carrier, bipdInsuranceOnFile: "0" } }));
    expect(result).toMatchObject({ status: "not_eligible", reasons: ["no_bipd_insurance"] });
  });

  it("rejects an Unsatisfactory safety rating and lets unrated or Conditional through", () => {
    expect(verifyCarrier(input({ carrier: { ...carrier, safetyRating: "U" } }))).toMatchObject({
      status: "not_eligible",
      reasons: ["unsatisfactory_safety_rating"],
    });
    expect(verifyCarrier(input({ carrier: { ...carrier, safetyRating: null } })).status).toBe("ok");
    expect(verifyCarrier(input({ carrier: { ...carrier, safetyRating: "C" } })).status).toBe("ok");
  });

  it("sends a missing or unrecognised field to review, never to eligible or rejected", () => {
    const { allowedToOperate: _a, ...noOperating } = carrier;
    expect(verifyCarrier(input({ carrier: noOperating }))).toEqual({
      eligible: false,
      status: "needs_review",
      reasons: ["operating_status_unknown"],
      riskFlags: [],
    });
    const { safetyRating: _s, ...noRating } = carrier;
    expect(verifyCarrier(input({ carrier: noRating })).reasons).toEqual(["safety_rating_unknown"]);
    expect(verifyCarrier(input({ carrier: { ...carrier, bipdInsuranceOnFile: null } })).reasons).toEqual([
      "insurance_unknown",
    ]);
    expect(verifyCarrier(input({ authorities: [{ ...authority, commonAuthorityStatus: null, contractAuthorityStatus: "N" }] })))
      .toMatchObject({ status: "needs_review", reasons: ["authority_unknown"] });
  });

  it("lets a hard failure outrank an unknown field", () => {
    const result = verifyCarrier(input({ carrier: { ...carrier, allowedToOperate: "N", bipdInsuranceOnFile: null } }));
    expect(result).toMatchObject({ status: "not_eligible", reasons: ["not_allowed_to_operate", "insurance_unknown"] });
  });

  it("sends zero and multiple lookup matches to review", () => {
    expect(verifyCarrier({ match: "none" })).toMatchObject({ eligible: false, status: "needs_review", reasons: ["carrier_not_found"] });
    expect(verifyCarrier({ match: "multiple" })).toMatchObject({
      eligible: false,
      status: "needs_review",
      reasons: ["multiple_carriers_matched"],
    });
  });
});

describe("riskFlagsFor", () => {
  it("flags a contact change inside the last 30 days", () => {
    expect(riskFlagsFor({ ...contact, mcs150Date: new Date("2026-09-10T00:00:00Z") }, now)).toEqual([
      "contact_changed_recently",
    ]);
    expect(riskFlagsFor({ ...contact, mcs150Date: new Date("2026-08-20T00:00:00Z") }, now)).toEqual([]);
  });

  it("flags a carrier with neither email nor phone", () => {
    expect(riskFlagsFor({ ...contact, email: null, phone: null }, now)).toEqual(["no_contact_on_file"]);
    expect(riskFlagsFor(null, now)).toEqual(["no_contact_on_file"]);
    expect(riskFlagsFor({ ...contact, email: null, phone: null, cellPhone: "5555550100" }, now)).toEqual([]);
  });

  it("raises no flag when the census could not be read", () => {
    expect(riskFlagsFor(undefined, now)).toEqual([]);
  });
});

describe("masking", () => {
  it("keeps only the first letters and the top-level domain of an email", () => {
    expect(maskEmail("jane.doe@gmail.com")).toBe("j***@g***.com");
    expect(maskEmail("not-an-email")).toBeUndefined();
  });

  it("keeps only the last four digits of a phone", () => {
    expect(maskPhone("(479) 820-1234")).toBe("***-***-1234");
    expect(maskPhone("12")).toBeUndefined();
  });
});
