// Wire faults are never signalled by the server; the client infers them from the socket.
export type TmsFault = "timeout" | "empty-close" | "partial" | "malformed" | "socket-error" | "rate-limited";

export type TmsCommand = "LOAD_QUERY" | "LOAD_GET" | "LOAD_BOOK" | "DEBUG_ECHO";

// Thrown by the codec when a response line cannot be trusted; the client retries it as a fault.
export class TmsMalformedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TmsMalformedError";
  }
}

export class TmsError extends Error {
  // True when some attempt wrote the request and never got a terminal response,
  // so the server may have committed it (only meaningful for LOAD_BOOK).
  readonly ambiguous: boolean;
  constructor(ambiguous: boolean, message: string) {
    super(message);
    this.name = "TmsError";
    this.ambiguous = ambiguous;
  }
}

// An `ERR|CODE:...` answer other than RATE_LIMITED. Never retried.
export class TmsBusinessError extends TmsError {
  readonly code: string;
  constructor(command: TmsCommand, attempts: number, ambiguous: boolean, code: string, serverMessage: string) {
    super(ambiguous, `${command} rejected: ${code}${serverMessage ? ` (${serverMessage})` : ""}`);
    this.name = "TmsBusinessError";
    this.code = code;
  }
}

// Every attempt faulted, or the retry budget ran out.
export class TmsUnavailableError extends TmsError {
  readonly fault: TmsFault;
  constructor(command: TmsCommand, attempts: number, ambiguous: boolean, fault: TmsFault) {
    super(ambiguous, `${command} unavailable after ${attempts} attempt(s): last fault ${fault}`);
    this.name = "TmsUnavailableError";
    this.fault = fault;
  }
}
