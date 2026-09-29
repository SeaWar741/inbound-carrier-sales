import { z } from "zod";
import { TmsMalformedError, type TmsCommand } from "./errors.ts";

// Wire rules observed on the live TMS: every field is a fixed-width,
// right-space-padded `KEY:VALUE`, so a valid record line always has the same byte length.
// Length is checked before splitting because the malformed fault injects extra `|` bytes.
export const loadQueryLineLength = 246;
export const loadGetLineLength = 524;

export const equipmentTypes = ["DRY_VAN", "REEFER", "FLATBED", "STEP_DECK", "POWER_ONLY"] as const;
export type EquipmentType = (typeof equipmentTypes)[number];

const reservedCharacters = /[|\r\n]/;

export function encodeRequest(command: TmsCommand, token: string, fields: Record<string, string> = {}): string {
  if (reservedCharacters.test(token)) throw new TypeError("AUTH token contains a reserved character");
  const parts = [`CMD:${command}`, `AUTH:${token}`];
  for (const [key, value] of Object.entries(fields)) {
    if (!/^[A-Z_]+$/.test(key)) throw new TypeError(`Invalid TMS field name: ${key}`);
    if (reservedCharacters.test(value)) throw new TypeError(`TMS field ${key} contains a reserved character`);
    parts.push(`${key}:${value}`);
  }
  return `${parts.join("|")}\r\n`;
}

export function redactRequest(line: string): string {
  return line.replace(/AUTH:[^|\r\n]*/, "AUTH:[redacted]").replace(/\r\n$/, "");
}

export type TmsResponse = { kind: "records"; lines: string[] } | { kind: "error"; line: string };

// Returns the response once a terminator is buffered, so the caller can close without
// waiting for EOF (the delayed-termination fault holds the socket open for seconds).
export function scanResponse(buffer: string): TmsResponse | undefined {
  const lines: string[] = [];
  let start = 0;
  for (let end = buffer.indexOf("\r\n"); end !== -1; end = buffer.indexOf("\r\n", start)) {
    const line = buffer.slice(start, end);
    start = end + 2;
    if (line === "END") return { kind: "records", lines };
    if (line.startsWith("ERR|")) return { kind: "error", line };
    lines.push(line);
  }
  return undefined;
}

// Parsed by key name, not position: the spec says field order may change across builds.
function splitFields(parts: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of parts) {
    const colon = part.indexOf(":");
    const key = part.slice(0, colon);
    if (colon <= 0 || !/^[A-Z_]+$/.test(key)) throw new TmsMalformedError(`Unparseable field ${JSON.stringify(part.slice(0, 20))}`);
    if (Object.hasOwn(fields, key)) throw new TmsMalformedError(`Duplicate field ${key}`);
    // Only the first colon splits: free-text values may contain ':'.
    fields[key] = part.slice(colon + 1).replace(/ +$/, "");
  }
  return fields;
}

function parseWith<T>(schema: z.ZodType<T>, fields: Record<string, string>, what: string): T {
  const result = schema.safeParse(fields);
  if (result.success) return result.data;
  const where = result.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
  throw new TmsMalformedError(`Invalid ${what}: ${where}`);
}

function parseRecordLine<T>(line: string, expectedLength: number, schema: z.ZodType<T>, what: string): T {
  if (line.length !== expectedLength) {
    throw new TmsMalformedError(`${what} line is ${line.length} bytes, expected ${expectedLength}`);
  }
  return parseWith(schema, splitFields(line.split("|")), what);
}

const wireInt = z.string().regex(/^\d+$/).transform(Number);
const wireText = z.string();
const wireState = z.string().regex(/^[A-Z]{2}$/);
const wireZip = z.string().regex(/^\d{5}$/);
// YYYYMMDDHHMMSS; the TMS does not state a timezone, so it stays a string.
const wireDateTime = z.string().regex(/^\d{14}$/);

const summaryShape = {
  LOAD_ID: z.string().min(1),
  ORIG_CITY: z.string().min(1),
  ORIG_STATE: wireState,
  ORIG_ZIP: wireZip,
  DEST_CITY: z.string().min(1),
  DEST_STATE: wireState,
  DEST_ZIP: wireZip,
  PICKUP_DT: wireDateTime,
  EQTYPE: z.enum(equipmentTypes),
  RATE: wireInt,
  MILES: wireInt,
  STATUS: z.string().min(1),
};

type SummaryWire = z.output<z.ZodObject<typeof summaryShape>>;

const toSummary = (w: SummaryWire) => ({
  loadId: w.LOAD_ID,
  origCity: w.ORIG_CITY,
  origState: w.ORIG_STATE,
  origZip: w.ORIG_ZIP,
  destCity: w.DEST_CITY,
  destState: w.DEST_STATE,
  destZip: w.DEST_ZIP,
  pickupDateTime: w.PICKUP_DT,
  equipmentType: w.EQTYPE,
  rate: w.RATE,
  miles: w.MILES,
  status: w.STATUS,
});

const loadSummarySchema = z.object(summaryShape).transform(toSummary);

const loadDetailSchema = z
  .object({
    ...summaryShape,
    DELIVERY_DT: wireDateTime,
    WEIGHT: wireInt,
    COMMODITY: wireText,
    PIECES: wireInt,
    DIMS: wireText,
    NOTES: wireText,
    MAX_BUY: wireInt,
  })
  .transform((w) => ({
    ...toSummary(w),
    deliveryDateTime: w.DELIVERY_DT,
    weight: w.WEIGHT,
    commodity: w.COMMODITY,
    pieces: w.PIECES,
    dims: w.DIMS,
    notes: w.NOTES,
    maxBuy: w.MAX_BUY,
  }));

export type LoadSummary = z.output<typeof loadSummarySchema>;
export type LoadDetail = z.output<typeof loadDetailSchema>;

export function parseLoadSummaryLine(line: string): LoadSummary {
  return parseRecordLine(line, loadQueryLineLength, loadSummarySchema, "LOAD_QUERY record");
}

export function parseLoadDetailLine(line: string): LoadDetail {
  return parseRecordLine(line, loadGetLineLength, loadDetailSchema, "LOAD_GET record");
}

// LOAD_BOOK success lines were never observed on the live TMS, so their width is unknown and not checked.
const bookingSchema = z
  .object({ LOAD_ID: z.string().min(1), BOOKING_REF: z.string().min(1), STATUS: z.string().min(1), TIMESTAMP: wireDateTime })
  .transform((w) => ({ loadId: w.LOAD_ID, bookingRef: w.BOOKING_REF, status: w.STATUS, timestampUtc: w.TIMESTAMP }));

export type BookingConfirmation = z.output<typeof bookingSchema>;

export function parseBookingLine(line: string): BookingConfirmation {
  return parseWith(bookingSchema, splitFields(line.split("|")), "LOAD_BOOK record");
}

const echoSchema = z
  .object({ AUTH: z.literal("OK"), FIELDS_PARSED: wireInt, MSG: wireText })
  .transform((w) => ({ fieldsParsed: w.FIELDS_PARSED, message: w.MSG }));

export type EchoResult = z.output<typeof echoSchema>;

export function parseEchoLine(line: string): EchoResult {
  const [tag, ...parts] = line.split("|");
  if (tag !== "ECHO") throw new TmsMalformedError("DEBUG_ECHO line does not start with ECHO");
  return parseWith(echoSchema, splitFields(parts), "DEBUG_ECHO record");
}

const errorSchema = z.object({ CODE: z.string().regex(/^[A-Z_]+$/), MSG: wireText.default("") });

export function parseErrorLine(line: string): { code: string; message: string } {
  const { CODE, MSG } = parseWith(errorSchema, splitFields(line.split("|").slice(1)), "ERR line");
  return { code: CODE, message: MSG };
}

// Callers speak loosely ("reefer", "tx", "2026-10-03"); the TMS rejects anything but the exact form.
const noReserved = (s: string) => !reservedCharacters.test(s);
const cityInput = z.string().trim().min(1).max(30).refine(noReserved);
const stateInput = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/);
const zipInput = z.string().trim().regex(/^\d{5}$/);
const equipmentInput = z
  .string()
  .trim()
  .toUpperCase()
  .transform((s) => s.replace(/[\s-]+/g, "_"))
  .pipe(z.enum(equipmentTypes));
const pickupDateInput = z
  .string()
  .trim()
  .transform((s) => s.replaceAll("-", ""))
  .pipe(z.string().regex(/^\d{8}$/))
  .refine((s) => {
    const date = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10).replaceAll("-", "") === s;
  }, "Invalid calendar date");

// The server defaults MAX_RESULTS to 10 when omitted; it is always sent so the cap is ours.
export const defaultMaxResults = 10;

const loadQueryFiltersSchema = z
  .object({
    origCity: cityInput.optional(),
    origState: stateInput.optional(),
    origZip: zipInput.optional(),
    destCity: cityInput.optional(),
    destState: stateInput.optional(),
    destZip: zipInput.optional(),
    equipmentType: equipmentInput.optional(),
    pickupDate: pickupDateInput.optional(),
    maxResults: z.number().int().min(1).max(50).default(defaultMaxResults),
  })
  .refine(({ maxResults: _, ...filters }) => Object.values(filters).some((v) => v !== undefined), {
    message: "At least one filter is required",
  });

export type LoadQueryFilters = z.input<typeof loadQueryFiltersSchema>;

export function encodeQueryFilters(filters: LoadQueryFilters): Record<string, string> {
  const f = loadQueryFiltersSchema.parse(filters);
  const wire: Record<string, string | undefined> = {
    ORIG_CITY: f.origCity,
    ORIG_STATE: f.origState,
    ORIG_ZIP: f.origZip,
    DEST_CITY: f.destCity,
    DEST_STATE: f.destState,
    DEST_ZIP: f.destZip,
    EQTYPE: f.equipmentType,
    PICKUP_DATE: f.pickupDate,
    MAX_RESULTS: String(f.maxResults),
  };
  return Object.fromEntries(Object.entries(wire).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export const loadIdInput = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,12}$/);

export const bookingInput = z.object({
  loadId: loadIdInput,
  mcNumber: z.string().trim().regex(/^\d{1,8}$/),
  agreedRate: z.number().int().positive(),
});

export type BookingRequest = z.input<typeof bookingInput>;
