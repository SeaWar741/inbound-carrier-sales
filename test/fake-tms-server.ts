import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadGetLineLength, loadQueryLineLength } from "../src/infra/tms/codec.ts";

// Real lines captured from the live board on 2026-09-28, byte-exact: 246 bytes for LOAD_QUERY, 524 for LOAD_GET.
export const sampleQueryLines = [
  "LOAD_ID:LD00881     |ORIG_CITY:Savannah                      |ORIG_STATE:GA|ORIG_ZIP:31401|DEST_CITY:Wichita                       |DEST_STATE:KS|DEST_ZIP:67202|PICKUP_DT:20261003141300|EQTYPE:DRY_VAN   |RATE:2093    |MILES:997   |STATUS:OPEN    ",
  "LOAD_ID:LD00848     |ORIG_CITY:Anchorage                     |ORIG_STATE:AK|ORIG_ZIP:99501|DEST_CITY:Springfield                   |DEST_STATE:IL|DEST_ZIP:62701|PICKUP_DT:20260930110000|EQTYPE:REEFER    |RATE:6886    |MILES:2894  |STATUS:OPEN    ",
] as const;

export const sampleDetailLines: Record<string, string> = {
  LD00881:
    "LOAD_ID:LD00881     |ORIG_CITY:Savannah                      |ORIG_STATE:GA|ORIG_ZIP:31401|DEST_CITY:Wichita                       |DEST_STATE:KS|DEST_ZIP:67202|PICKUP_DT:20261003141300|DELIVERY_DT:20261006111300|EQTYPE:DRY_VAN   |RATE:2093    |WEIGHT:29831   |COMMODITY:Frozen Goods                  |PIECES:25    |MILES:997   |DIMS:41ft x 8ft x 9ft              |NOTES:                                                                                                                        |STATUS:OPEN    |MAX_BUY:2538    ",
  LD00848:
    "LOAD_ID:LD00848     |ORIG_CITY:Anchorage                     |ORIG_STATE:AK|ORIG_ZIP:99501|DEST_CITY:Springfield                   |DEST_STATE:IL|DEST_ZIP:62701|PICKUP_DT:20260930110000|DELIVERY_DT:20261002060000|EQTYPE:REEFER    |RATE:6886    |WEIGHT:20977   |COMMODITY:Auto Parts                    |PIECES:24    |MILES:2894  |DIMS:45ft x 8ft x 9ft              |NOTES:Live unload. 2H detention free, then $75/h.                                                                             |STATUS:OPEN    |MAX_BUY:7684    ",
};

// The malformed fault injects 3 bytes, e.g. `|C|XXOMMODITY:` or `|XX        `, as seen on the live TMS.
export function injectMalformedBytes(line: string): string {
  return line.includes("|COMMODITY:")
    ? line.replace("|COMMODITY:", "|C|XXOMMODITY:")
    : line.replace(/(\|RATE:\d+)/, "$1|XX");
}

export type FakeBehavior =
  | "ok"
  | "silence"
  | "empty-close"
  | "partial"
  | "malformed"
  | "delayed-close"
  | "rate-limited"
  | { errorCode: string; message?: string };

export type FakeTms = {
  port: number;
  // Raw request lines as received, in connection order.
  requests: string[];
  close(): Promise<void>;
};

function parseRequest(line: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of line.split("|")) {
    const colon = part.indexOf(":");
    if (colon > 0) fields.set(part.slice(0, colon), part.slice(colon + 1));
  }
  return fields;
}

const errorLine = (code: string, message: string) => `ERR|CODE:${code}|MSG:${message}\r\n`;

// A board record keeps the padded wire values in wire field order, as captured in the snapshot.
export type BoardRecord = Record<string, string>;

const summaryKeys = [
  "LOAD_ID",
  "ORIG_CITY",
  "ORIG_STATE",
  "ORIG_ZIP",
  "DEST_CITY",
  "DEST_STATE",
  "DEST_ZIP",
  "PICKUP_DT",
  "EQTYPE",
  "RATE",
  "MILES",
  "STATUS",
] as const;

// Request filter key to board field; PICKUP_DATE (YYYYMMDD) is matched as a prefix of PICKUP_DT.
const exactFilters = ["ORIG_CITY", "ORIG_STATE", "ORIG_ZIP", "DEST_CITY", "DEST_STATE", "DEST_ZIP", "EQTYPE"] as const;

const summaryLine = (record: BoardRecord) => summaryKeys.map((key) => `${key}:${record[key] ?? ""}`).join("|");
const detailLine = (record: BoardRecord) =>
  Object.entries(record)
    .map(([key, value]) => `${key}:${value}`)
    .join("|");
const trimmed = (value: string | undefined) => (value ?? "").trim().toUpperCase();

// In-memory board served by the standalone fake. Line widths are checked up front so a bad
// snapshot fails at startup instead of as malformed responses.
export class FakeBoard {
  readonly #records = new Map<string, BoardRecord>();
  #nextBookingRef = 1;

  constructor(records: BoardRecord[]) {
    for (const record of records) {
      const loadId = trimmed(record.LOAD_ID);
      const query = summaryLine(record).length;
      const get = detailLine(record).length;
      if (query !== loadQueryLineLength || get !== loadGetLineLength) {
        throw new Error(
          `Load ${loadId} renders LOAD_QUERY ${query} bytes (expected ${loadQueryLineLength}) and LOAD_GET ${get} bytes (expected ${loadGetLineLength})`,
        );
      }
      this.#records.set(loadId, { ...record });
    }
  }

  get size(): number {
    return this.#records.size;
  }

  query(fields: Map<string, string>): string[] {
    const limit = Number(fields.get("MAX_RESULTS") ?? "10");
    const pickupDate = fields.get("PICKUP_DATE")?.trim();
    return [...this.#records.values()]
      .filter((record) => trimmed(record.STATUS) === "OPEN")
      .filter((record) => exactFilters.every((key) => !fields.has(key) || trimmed(record[key]) === trimmed(fields.get(key))))
      .filter((record) => pickupDate === undefined || (record.PICKUP_DT ?? "").startsWith(pickupDate))
      .slice(0, limit)
      .map(summaryLine);
  }

  get(loadId: string): string | undefined {
    const record = this.#records.get(trimmed(loadId));
    return record && detailLine(record);
  }

  // Error codes follow the LOAD_BOOK transcripts in the TMS handbook.
  book(fields: Map<string, string>): { line: string } | { error: string } {
    const loadId = fields.get("LOAD_ID");
    const rate = fields.get("AGREED_RATE");
    if (!loadId || !fields.get("MC_NUM") || !rate) return { error: errorLine("MISSING_FIELD", "missing required field") };
    const record = this.#records.get(trimmed(loadId));
    if (!record) return { error: errorLine("UNKNOWN_LOAD", "load not found") };
    if (!/^\d+$/.test(rate) || Number(rate) <= 0) return { error: errorLine("INVALID_RATE", "rate rejected") };
    if (trimmed(record.STATUS) !== "OPEN") return { error: errorLine("ALREADY_BOOKED", "load not available") };

    // Same padded width as OPEN, so booked loads still render byte-exact LOAD_GET lines.
    record.STATUS = "BOOKED".padEnd((record.STATUS ?? "").length);
    const bookingRef = `BR${String(this.#nextBookingRef++).padStart(14, "0")}`;
    const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    return { line: `LOAD_ID:${trimmed(loadId)}|BOOKING_REF:${bookingRef}|STATUS:BOOKED  |TIMESTAMP:${timestamp}` };
  }
}

function boardResponse(board: FakeBoard, fields: Map<string, string>): { lines: string[]; error?: string } | undefined {
  switch (fields.get("CMD")) {
    case "LOAD_QUERY":
      return { lines: board.query(fields) };
    case "LOAD_GET": {
      const line = board.get(fields.get("LOAD_ID") ?? "");
      return line ? { lines: [line] } : { lines: [], error: errorLine("NOT_FOUND", "Load not found") };
    }
    case "LOAD_BOOK": {
      const result = board.book(fields);
      return "error" in result ? { lines: [], error: result.error } : { lines: [result.line] };
    }
    default:
      return undefined;
  }
}

// Healthy response split into record lines and terminator so faults can reuse the pieces.
function healthyResponse(
  fields: Map<string, string>,
  fieldCount: number,
  board?: FakeBoard,
): { lines: string[]; error?: string } {
  const fromBoard = board && boardResponse(board, fields);
  if (fromBoard) return fromBoard;
  switch (fields.get("CMD")) {
    case "DEBUG_ECHO":
      return { lines: [`ECHO|AUTH:OK|FIELDS_PARSED:${fieldCount}|MSG:${fields.get("MSG") ?? ""}`] };
    case "LOAD_QUERY":
      return { lines: [...sampleQueryLines] };
    case "LOAD_GET": {
      const line = sampleDetailLines[fields.get("LOAD_ID") ?? ""];
      return line ? { lines: [line] } : { lines: [], error: errorLine("NOT_FOUND", "Load not found") };
    }
    case "LOAD_BOOK":
      return {
        lines: [`LOAD_ID:${fields.get("LOAD_ID") ?? ""}|BOOKING_REF:BR00000000091277|STATUS:BOOKED  |TIMESTAMP:20260928193122`],
      };
    default:
      return { lines: [], error: errorLine("UNKNOWN_CMD", "Unknown command") };
  }
}

// Each connection consumes the next scripted behavior; once the script is empty it answers "ok".
// Without a board it serves the fixed sample lines; the port defaults to an ephemeral one.
export async function startFakeTms(options: {
  token: string;
  script?: FakeBehavior[];
  board?: FakeBoard;
  port?: number;
}): Promise<FakeTms> {
  const script = [...(options.script ?? [])];
  const requests: string[] = [];
  const sockets = new Set<net.Socket>();

  const respond = (socket: net.Socket, requestLine: string) => {
    requests.push(requestLine);
    const fields = parseRequest(requestLine);
    const behavior = script.shift() ?? "ok";

    if (fields.get("AUTH") !== options.token) {
      socket.end(errorLine("AUTH_FAILED", "Invalid or missing auth token"));
      return;
    }
    const healthy = healthyResponse(fields, requestLine.split("|").length, options.board);
    const body = healthy.error ?? healthy.lines.map((line) => `${line}\r\n`).join("") + "END\r\n";

    if (typeof behavior === "object") {
      socket.end(errorLine(behavior.errorCode, behavior.message ?? "Rejected"));
      return;
    }
    switch (behavior) {
      case "ok":
        socket.end(body);
        return;
      case "silence":
        return;
      case "empty-close":
        socket.end();
        return;
      case "partial":
        socket.end(healthy.lines.map((line) => `${line}\r\n`).join(""));
        return;
      case "malformed": {
        const [first, ...rest] = healthy.lines;
        const lines = first === undefined ? [] : [injectMalformedBytes(first), ...rest];
        socket.end(lines.map((line) => `${line}\r\n`).join("") + "END\r\n");
        return;
      }
      case "delayed-close":
        socket.write(body);
        return;
      case "rate-limited":
        socket.end(errorLine("RATE_LIMITED", "Rate limit exceeded"));
        return;
    }
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("latin1");
    let buffer = "";
    let answered = false;
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\r\n");
      if (answered || end === -1) return;
      answered = true;
      respond(socket, buffer.slice(0, end));
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Fake TMS has no TCP address");

  return {
    port: address.port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const defaultSnapshotPath = fileURLToPath(new URL("../../docs/raw/tms-board-snapshot-2026-09-28.json", import.meta.url));

// Standalone local TMS: `npm run fake:tms`, serving the board snapshot. Searches list only the
// OPEN loads; the rest still answer LOAD_GET and LOAD_BOOK answers ALREADY_BOOKED for them.
if (import.meta.main) {
  const token = process.env.TMS_TOKEN;
  if (!token) throw new Error("TMS_TOKEN is required");
  const snapshotPath = process.env.TMS_BOARD_SNAPSHOT ?? (existsSync(defaultSnapshotPath) ? defaultSnapshotPath : undefined);
  if (!snapshotPath) throw new Error(`TMS_BOARD_SNAPSHOT is required (no snapshot at ${defaultSnapshotPath})`);
  const port = Number(process.env.FAKE_TMS_PORT ?? "9400");

  const records: BoardRecord[] = z.array(z.record(z.string(), z.string())).parse(JSON.parse(readFileSync(snapshotPath, "utf8")));
  const board = new FakeBoard(records);
  const fake = await startFakeTms({ token, board, port });
  console.log(`Fake TMS listening on 127.0.0.1:${fake.port} with ${board.size} loads from ${snapshotPath}`);
}
