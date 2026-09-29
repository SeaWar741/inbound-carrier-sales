import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { tmsAttemptDeadlineMs, tmsBackoffBaseMs, tmsMaxAttempts, tmsTotalBudgetMs } from "../../constants.ts";
import {
  bookingInput,
  encodeQueryFilters,
  encodeRequest,
  loadIdInput,
  parseBookingLine,
  parseEchoLine,
  parseErrorLine,
  parseLoadDetailLine,
  parseLoadSummaryLine,
  redactRequest,
  scanResponse,
  type BookingConfirmation,
  type BookingRequest,
  type EchoResult,
  type LoadDetail,
  type LoadQueryFilters,
  type LoadSummary,
  type TmsResponse,
} from "./codec.ts";
import {
  TmsBusinessError,
  TmsMalformedError,
  TmsUnavailableError,
  type TmsCommand,
  type TmsFault,
} from "./errors.ts";

// Never carries the token: `request` is redacted before it leaves the client.
export type TmsExchange = {
  command: TmsCommand;
  request: string;
  attempt: number;
  latencyMs: number;
  outcome: "ok" | "business-error" | TmsFault;
  code?: string;
};

export type TmsClientOptions = {
  host: string;
  port: number;
  token: string;
  attemptDeadlineMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  totalBudgetMs?: number;
  onExchange?: (exchange: TmsExchange) => void;
};

type AttemptOutcome =
  | { kind: "response"; response: TmsResponse; written: boolean }
  | { kind: "fault"; fault: TmsFault; written: boolean };

type Classified<T> = { kind: "ok"; value: T } | { kind: "fault"; fault: TmsFault } | { kind: "business"; code: string; message: string };

function singleLine(lines: string[]): string {
  const [line] = lines;
  if (lines.length !== 1 || line === undefined) throw new TmsMalformedError(`Expected 1 record line, got ${lines.length}`);
  return line;
}

export class TmsClient {
  readonly #host: string;
  readonly #port: number;
  readonly #token: string;
  readonly #attemptDeadlineMs: number;
  readonly #maxAttempts: number;
  readonly #backoffBaseMs: number;
  readonly #totalBudgetMs: number;
  readonly #onExchange: (exchange: TmsExchange) => void;

  constructor(options: TmsClientOptions) {
    this.#host = options.host;
    this.#port = options.port;
    this.#token = options.token;
    this.#attemptDeadlineMs = options.attemptDeadlineMs ?? tmsAttemptDeadlineMs;
    this.#maxAttempts = options.maxAttempts ?? tmsMaxAttempts;
    this.#backoffBaseMs = options.backoffBaseMs ?? tmsBackoffBaseMs;
    this.#totalBudgetMs = options.totalBudgetMs ?? tmsTotalBudgetMs;
    this.#onExchange = options.onExchange ?? (() => {});
  }

  // Bypasses fault injection but shares the rate-limit bucket.
  async debugEcho(message = "PING"): Promise<EchoResult> {
    return this.#execute("DEBUG_ECHO", { MSG: message }, (lines) => parseEchoLine(singleLine(lines)));
  }

  async queryLoads(filters: LoadQueryFilters): Promise<LoadSummary[]> {
    return this.#execute("LOAD_QUERY", encodeQueryFilters(filters), (lines) => lines.map(parseLoadSummaryLine));
  }

  async getLoad(loadId: string): Promise<LoadDetail> {
    return this.#execute("LOAD_GET", { LOAD_ID: loadIdInput.parse(loadId) }, (lines) =>
      parseLoadDetailLine(singleLine(lines)),
    );
  }

  // Permanently consumes the load for this token. On failure, `error.ambiguous` tells whether
  // an attempt may have committed without us seeing the confirmation.
  async bookLoad(request: BookingRequest): Promise<BookingConfirmation> {
    const booking = bookingInput.parse(request);
    const fields = { LOAD_ID: booking.loadId, MC_NUM: booking.mcNumber, AGREED_RATE: String(booking.agreedRate) };
    return this.#execute("LOAD_BOOK", fields, (lines) => parseBookingLine(singleLine(lines)));
  }

  async #execute<T>(command: TmsCommand, fields: Record<string, string>, parse: (lines: string[]) => T): Promise<T> {
    const request = encodeRequest(command, this.#token, fields);
    const redacted = redactRequest(request);
    const startedAt = performance.now();
    let attempts = 0;
    let ambiguous = false;
    let lastFault: TmsFault = "timeout";

    while (attempts < this.#maxAttempts) {
      const remainingMs = this.#totalBudgetMs - (performance.now() - startedAt);
      if (remainingMs <= 0) break;
      attempts++;
      const attemptStartedAt = performance.now();
      const outcome = await this.#attempt(request, Math.min(this.#attemptDeadlineMs, remainingMs));
      const result = this.#classify(outcome, parse);
      this.#onExchange({
        command,
        request: redacted,
        attempt: attempts,
        latencyMs: Math.round(performance.now() - attemptStartedAt),
        outcome: result.kind === "ok" ? "ok" : result.kind === "business" ? "business-error" : result.fault,
        ...(result.kind === "business" ? { code: result.code } : {}),
      });

      if (result.kind === "ok") return result.value;
      if (result.kind === "business") {
        throw new TmsBusinessError(command, attempts, ambiguous, result.code, this.#scrub(result.message));
      }
      // RATE_LIMITED is a definite refusal; every other fault after the write may have been processed.
      if (outcome.written && result.fault !== "rate-limited") ambiguous = true;
      lastFault = result.fault;

      if (attempts < this.#maxAttempts) {
        // Full jitter: uniform in [0, base * 2^retry].
        const backoffMs = Math.random() * this.#backoffBaseMs * 2 ** (attempts - 1);
        if (performance.now() - startedAt + backoffMs >= this.#totalBudgetMs) break;
        await sleep(backoffMs);
      }
    }
    throw new TmsUnavailableError(command, attempts, ambiguous, lastFault);
  }

  #classify<T>(outcome: AttemptOutcome, parse: (lines: string[]) => T): Classified<T> {
    if (outcome.kind === "fault") return { kind: "fault", fault: outcome.fault };
    try {
      if (outcome.response.kind === "records") return { kind: "ok", value: parse(outcome.response.lines) };
      const { code, message } = parseErrorLine(outcome.response.line);
      if (code === "RATE_LIMITED") return { kind: "fault", fault: "rate-limited" };
      return { kind: "business", code, message };
    } catch (error) {
      if (error instanceof TmsMalformedError) return { kind: "fault", fault: "malformed" };
      throw error;
    }
  }

  #attempt(request: string, deadlineMs: number): Promise<AttemptOutcome> {
    return new Promise((resolve) => {
      let buffer = "";
      let written = false;
      let settled = false;
      const socket = net.createConnection({ host: this.#host, port: this.#port });
      // latin1 maps one byte to one char, so line lengths are byte counts.
      socket.setEncoding("latin1");

      const finish = (outcome: AttemptOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(outcome);
      };
      const closedEarly = () =>
        finish({ kind: "fault", fault: buffer.length === 0 ? "empty-close" : "partial", written });

      const timer = setTimeout(() => finish({ kind: "fault", fault: "timeout", written }), deadlineMs);
      socket.once("connect", () => {
        written = true;
        socket.write(request);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const response = scanResponse(buffer);
        if (response) finish({ kind: "response", response, written });
      });
      socket.once("end", closedEarly);
      socket.once("close", closedEarly);
      socket.once("error", () =>
        finish({ kind: "fault", fault: buffer.length === 0 ? "socket-error" : "partial", written }),
      );
    });
  }

  #scrub(text: string): string {
    return this.#token ? text.replaceAll(this.#token, "[redacted]") : text;
  }
}
