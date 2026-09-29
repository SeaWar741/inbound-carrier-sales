// Inbound carrier sales voice agent. Every business decision (eligibility, OTP, search,
// negotiation, holds) lives in the adapter; the agent only talks and calls tools.
import { readFileSync } from "node:fs";
import {
  WorkflowBuilder,
  aiAgentInbound,
  aiWebCall,
  text,
  variable,
  webhookPost,
  type NodeInput,
  type NodeRef,
} from "@happyrobot-ai/workflow-sdk";

export type AgentOptions = { adapterUrl: string; agentApiKey: string };

type ToolParameter = { name: string; description: string; required: boolean };

type ToolSpec = {
  name: string;
  // The only response fields the agent sees; everything else stays in the run log.
  exposedFields: string[];
  description: string;
  path: string;
  waitMessage: string;
  parameters: ToolParameter[];
  // Adapter body field -> tool parameter name.
  body: Record<string, string>;
};

const tools: ToolSpec[] = [
  {
    name: "verify_carrier",
    exposedFields: ["status", "message", "eligible", "carrierName"],
    description: "Verify the caller's carrier with FMCSA. Pass the MC number, or the DOT number if they have no MC number; never both.",
    path: "/v1/carriers/verify",
    waitMessage: "Give me one second while I pull up your authority.",
    parameters: [
      { name: "mc_number", description: "The carrier's MC number, digits only", required: false },
      { name: "dot_number", description: "The carrier's USDOT number, digits only, only if they have no MC number", required: false },
    ],
    body: { mcNumber: "mc_number", dotNumber: "dot_number" },
  },
  {
    name: "send_otp",
    exposedFields: ["status", "message", "maskedDestination"],
    description: "Send a six-digit identity code to the carrier's contact on file.",
    path: "/v1/otp/send",
    waitMessage: "Sending that code now.",
    parameters: [{ name: "channel", description: "Where to send the code: email or sms", required: true }],
    body: { channel: "channel" },
  },
  {
    name: "check_otp",
    exposedFields: ["status", "message", "verified", "attemptsLeft"],
    description: "Check the six-digit code the caller read back.",
    path: "/v1/otp/check",
    waitMessage: "Let me check that.",
    parameters: [{ name: "code", description: "The six digits the caller read, digits only", required: true }],
    body: { code: "code" },
  },
  {
    name: "search_loads",
    exposedFields: ["status", "message", "loads"],
    description: "Search open loads for the caller's lane and equipment. Only works after check_otp verified the caller.",
    path: "/v1/loads/search",
    waitMessage: "Let me see what I've got on that lane.",
    parameters: [
      { name: "origin_city", description: "Origin city, e.g. Chicago", required: false },
      { name: "origin_state", description: "Origin state as a two-letter code, e.g. IL", required: true },
      { name: "destination_city", description: "Destination city, if the caller has one", required: false },
      { name: "destination_state", description: "Destination state as a two-letter code, if the caller has one", required: false },
      { name: "equipment_type", description: "One of: dry van, reefer, flatbed, step deck, power only", required: true },
      { name: "pickup_date", description: "Pickup date as YYYY-MM-DD, if the caller has one", required: false },
    ],
    body: {
      originCity: "origin_city",
      originState: "origin_state",
      destinationCity: "destination_city",
      destinationState: "destination_state",
      equipmentType: "equipment_type",
      pickupDate: "pickup_date",
    },
  },
  {
    name: "evaluate_offer",
    exposedFields: ["status", "message", "decision", "rateToSay", "round", "isFinalRound"],
    description: "Evaluate a rate the carrier proposed for a load. Call it for every number the carrier says.",
    path: "/v1/offers/evaluate",
    waitMessage: "Let me see what I can do.",
    parameters: [
      { name: "load_id", description: "The load number, e.g. LD00881", required: true },
      { name: "carrier_ask", description: "The carrier's rate in whole US dollars, digits only", required: true },
    ],
    body: { loadId: "load_id", carrierAsk: "carrier_ask" },
  },
  {
    name: "create_hold",
    exposedFields: ["status", "message", "holdStatus"],
    description: "Put the agreed load on hold for a senior rep to confirm. Call it right after evaluate_offer accepts.",
    path: "/v1/holds",
    waitMessage: "Locking that in for you.",
    parameters: [
      { name: "load_id", description: "The load number", required: true },
      { name: "agreed_rate", description: "The rate evaluate_offer accepted, in whole US dollars", required: true },
    ],
    body: { loadId: "load_id", agreedRate: "agreed_rate" },
  },
];

// The adapter keys every call by the HappyRobot run id.
const runId = variable("current", "run_id");

function addTool(wf: WorkflowBuilder, prompt: NodeRef, spec: ToolSpec, options: AgentOptions): void {
  const tool = wf.addTool(spec.name, prompt, {
    description: spec.description,
    message: { type: "fixed", example: spec.waitMessage },
    parameters: spec.parameters,
  });
  webhookPost(wf, `${spec.name}_request`, tool, {
    url: text(`${options.adapterUrl}${spec.path}`),
    contentType: "application/json",
    bodyMode: "builder",
    data: [
      { key: "callId", value: runId },
      ...Object.entries(spec.body).map(([key, parameter]) => ({ key, value: variable(tool, parameter) })),
    ],
    headers: [{ key: "x-api-key", value: text(options.agentApiKey) }],
    // The adapter always answers 200 with a typed status; a 5XX means it is down and the agent says so.
    ignore5XX: true,
  });
}

export function buildAgent(options: AgentOptions): {
  name: string;
  nodes: NodeInput[];
  exposedToolFields: Record<string, string[]>;
  runDumpTable: string;
} {
  const wf = new WorkflowBuilder("inbound-carrier-sales");
  const trigger = aiWebCall(wf, "web_call", { params: [] });
  const { prompt } = aiAgentInbound(wf, "carrier_sales_agent", trigger, {
    agent: {
      name: text("Pablo"),
      languages: [{ type: "static", static: { id: "en", name: "English" } }],
      voices: [{ type: "static", static: { id: "2j33fces4qv5", name: "Pablo HR" } }],
    },
  });
  prompt.setPrompt({
    prompt_md: readFileSync(new URL("./prompt.md", import.meta.url), "utf8"),
    initial_message: "Thanks for calling HappyRobot Logistics, this is Pablo, an AI assistant on a recorded line. What's your MC number?",
  });
  for (const spec of tools) addTool(wf, prompt, spec, options);
  return {
    name: wf.name,
    nodes: wf.toNodes(),
    exposedToolFields: Object.fromEntries(tools.map((t) => [t.name, t.exposedFields])),
    // One row per completed call with every variable the run produced (transcript, tool results).
    runDumpTable: "call_log",
  };
}
