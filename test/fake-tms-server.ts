import net from "node:net";

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

// Healthy response split into record lines and terminator so faults can reuse the pieces.
function healthyResponse(fields: Map<string, string>, fieldCount: number): { lines: string[]; error?: string } {
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
export async function startFakeTms(options: { token: string; script?: FakeBehavior[] }): Promise<FakeTms> {
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
    const healthy = healthyResponse(fields, requestLine.split("|").length);
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

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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
