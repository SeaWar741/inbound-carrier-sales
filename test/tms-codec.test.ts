import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  encodeQueryFilters,
  encodeRequest,
  loadGetLineLength,
  loadQueryLineLength,
  parseBookingLine,
  parseEchoLine,
  parseErrorLine,
  parseLoadDetailLine,
  parseLoadSummaryLine,
  redactRequest,
  scanResponse,
} from "../src/infra/tms/codec.ts";
import { TmsMalformedError } from "../src/infra/tms/errors.ts";
import { injectMalformedBytes, sampleDetailLines, sampleQueryLines } from "./fake-tms-server.ts";

const [savannahSummary = "", anchorageSummary = ""] = sampleQueryLines;
const savannahDetail = sampleDetailLines.LD00881 ?? "";
const anchorageDetail = sampleDetailLines.LD00848 ?? "";

describe("record widths", () => {
  it("matches the observed fixed widths", () => {
    expect(loadQueryLineLength).toBe(246);
    expect(loadGetLineLength).toBe(524);
    for (const line of sampleQueryLines) expect(line).toHaveLength(246);
    for (const line of Object.values(sampleDetailLines)) expect(line).toHaveLength(524);
  });
});

describe("parseLoadSummaryLine", () => {
  it("parses by key into camelCase with trimmed strings and integer money", () => {
    expect(parseLoadSummaryLine(savannahSummary)).toEqual({
      loadId: "LD00881",
      origCity: "Savannah",
      origState: "GA",
      origZip: "31401",
      destCity: "Wichita",
      destState: "KS",
      destZip: "67202",
      pickupDateTime: "20261003141300",
      equipmentType: "DRY_VAN",
      rate: 2093,
      miles: 997,
      status: "OPEN",
    });
  });

  it("does not depend on field order", () => {
    const reordered = savannahSummary.split("|").reverse().join("|");
    expect(parseLoadSummaryLine(reordered)).toEqual(parseLoadSummaryLine(savannahSummary));
  });

  it("rejects a line with injected bytes before splitting", () => {
    const corrupted = injectMalformedBytes(savannahSummary);
    expect(corrupted).toHaveLength(249);
    expect(() => parseLoadSummaryLine(corrupted)).toThrow(TmsMalformedError);
  });

  it("rejects a correct-width line whose values do not parse", () => {
    const badRate = savannahSummary.replace("RATE:2093    ", "RATE:20X3    ");
    expect(badRate).toHaveLength(246);
    expect(() => parseLoadSummaryLine(badRate)).toThrow(TmsMalformedError);
  });

  it("rejects a truncated line and a detail line", () => {
    expect(() => parseLoadSummaryLine(anchorageSummary.slice(0, 245))).toThrow(TmsMalformedError);
    expect(() => parseLoadSummaryLine(anchorageDetail)).toThrow(TmsMalformedError);
  });
});

describe("parseLoadDetailLine", () => {
  it("collapses blank NOTES to an empty string and keeps MAX_BUY", () => {
    expect(parseLoadDetailLine(savannahDetail)).toMatchObject({
      loadId: "LD00881",
      deliveryDateTime: "20261006111300",
      weight: 29831,
      commodity: "Frozen Goods",
      pieces: 25,
      dims: "41ft x 8ft x 9ft",
      notes: "",
      maxBuy: 2538,
    });
  });

  it("keeps free text intact, including characters after the first colon", () => {
    expect(parseLoadDetailLine(anchorageDetail).notes).toBe("Live unload. 2H detention free, then $75/h.");
    const withColon = anchorageDetail.replace("Live unload.", "Appt: 08:00.");
    expect(parseLoadDetailLine(withColon).notes).toBe("Appt: 08:00. 2H detention free, then $75/h.");
  });

  it("rejects the COMMODITY injection seen on the wire", () => {
    const corrupted = injectMalformedBytes(savannahDetail);
    expect(corrupted).toContain("|C|XXOMMODITY:");
    expect(() => parseLoadDetailLine(corrupted)).toThrow(TmsMalformedError);
  });
});

describe("other lines", () => {
  it("parses echo, error and booking lines", () => {
    expect(parseEchoLine("ECHO|AUTH:OK|FIELDS_PARSED:3|MSG:HELLO")).toEqual({ fieldsParsed: 3, message: "HELLO" });
    expect(parseErrorLine("ERR|CODE:NOT_FOUND|MSG:Load not found")).toEqual({ code: "NOT_FOUND", message: "Load not found" });
    expect(parseBookingLine("LOAD_ID:LD00881     |BOOKING_REF:BR00000000091277|STATUS:BOOKED  |TIMESTAMP:20260504193122")).toEqual({
      loadId: "LD00881",
      bookingRef: "BR00000000091277",
      status: "BOOKED",
      timestampUtc: "20260504193122",
    });
  });

  it("treats an error line without a code as malformed", () => {
    expect(() => parseErrorLine("ERR|MSG:oops")).toThrow(TmsMalformedError);
  });
});

describe("scanResponse", () => {
  it("waits for a terminator", () => {
    expect(scanResponse("")).toBeUndefined();
    expect(scanResponse(`${savannahSummary}\r\n`)).toBeUndefined();
    expect(scanResponse(`${savannahSummary}\r\nEN`)).toBeUndefined();
    expect(scanResponse("ERR|CODE:RATE_LIMITED")).toBeUndefined();
  });

  it("recognizes END and ERR terminators", () => {
    expect(scanResponse("END\r\n")).toEqual({ kind: "records", lines: [] });
    expect(scanResponse(`${savannahSummary}\r\n${anchorageSummary}\r\nEND\r\n`)).toEqual({
      kind: "records",
      lines: [savannahSummary, anchorageSummary],
    });
    expect(scanResponse("ERR|CODE:RATE_LIMITED|MSG:Rate limit exceeded\r\n")).toEqual({
      kind: "error",
      line: "ERR|CODE:RATE_LIMITED|MSG:Rate limit exceeded",
    });
  });
});

describe("encodeRequest", () => {
  it("puts CMD first and AUTH second", () => {
    expect(encodeRequest("LOAD_GET", "tok", { LOAD_ID: "LD00881" })).toBe("CMD:LOAD_GET|AUTH:tok|LOAD_ID:LD00881\r\n");
  });

  it("refuses reserved characters without echoing the token", () => {
    expect(() => encodeRequest("DEBUG_ECHO", "tok", { MSG: "a|b" })).toThrow(TypeError);
    const error = (() => {
      try {
        encodeRequest("DEBUG_ECHO", "se|cret");
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain("se|cret");
  });

  it("redacts AUTH for logs", () => {
    expect(redactRequest("CMD:LOAD_GET|AUTH:secret-token|LOAD_ID:LD00881\r\n")).toBe(
      "CMD:LOAD_GET|AUTH:[redacted]|LOAD_ID:LD00881",
    );
  });
});

describe("encodeQueryFilters", () => {
  it("normalizes spoken input to the exact wire forms and always sends MAX_RESULTS", () => {
    expect(
      encodeQueryFilters({ origCity: "  savannah ", origState: "ga", destZip: " 06510", equipmentType: "reefer", pickupDate: "2026-10-03" }),
    ).toEqual({
      ORIG_CITY: "savannah",
      ORIG_STATE: "GA",
      DEST_ZIP: "06510",
      EQTYPE: "REEFER",
      PICKUP_DATE: "20261003",
      MAX_RESULTS: "10",
    });
    expect(encodeQueryFilters({ equipmentType: "power only", maxResults: 3 })).toEqual({ EQTYPE: "POWER_ONLY", MAX_RESULTS: "3" });
    expect(encodeQueryFilters({ equipmentType: "step-deck" })).toMatchObject({ EQTYPE: "STEP_DECK" });
  });

  it.each([
    [{}],
    [{ maxResults: 5 }],
    [{ origState: "Texas" }],
    [{ origZip: "3140" }],
    [{ equipmentType: "box truck" }],
    [{ pickupDate: "20261332" }],
    [{ origCity: "Sav|annah" }],
    [{ origCity: "   " }],
    [{ origState: "GA", maxResults: 0 }],
  ])("rejects %j", (filters) => {
    expect(() => encodeQueryFilters(filters)).toThrow(z.ZodError);
  });
});
