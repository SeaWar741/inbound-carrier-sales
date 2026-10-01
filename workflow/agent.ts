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
    exposedFields: ["status", "message", "eligible", "carrierName", "maskedContact"],
    description: "Verify the caller's carrier with FMCSA. Pass the MC number, or the DOT number if they have no MC number; never both.",
    path: "/v1/carriers/verify",
    waitMessage: "Let me pull up your authority real quick.",
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
    waitMessage: "Okay, shooting that code over now.",
    parameters: [{ name: "channel", description: "Where to send the code: email or sms", required: true }],
    body: { channel: "channel" },
  },
  {
    name: "check_otp",
    exposedFields: ["status", "message", "verified", "attemptsLeft"],
    description: "Check the six-digit code the caller read back.",
    path: "/v1/otp/check",
    waitMessage: "Checking that code.",
    parameters: [{ name: "code", description: "The six digits the caller read, digits only", required: true }],
    body: { code: "code" },
  },
  {
    name: "search_loads",
    exposedFields: ["status", "message", "loads"],
    description: "Search open loads for the caller's lane and equipment. Only works after check_otp verified the caller. Each load carries feasibility: solo, team (the delivery window needs a team driver) or null; loads no crew can deliver on time are never returned.",
    path: "/v1/loads/search",
    waitMessage: "Alright, let me see what I've got on that lane.",
    parameters: [
      { name: "origin_city", description: "Origin city, e.g. Chicago", required: false },
      { name: "origin_state", description: "Origin state as a two-letter code, e.g. IL", required: true },
      { name: "destination_city", description: "Destination city, if the caller has one", required: false },
      { name: "destination_state", description: "Destination state as a two-letter code, if the caller has one", required: false },
      { name: "equipment_type", description: "One of: dry van, reefer, flatbed, step deck, power only. Use any when the caller runs anything or has no preference", required: false },
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
    waitMessage: "Okay, let me see.",
    parameters: [
      { name: "load_id", description: "The load number, e.g. LD00881", required: true },
      { name: "carrier_ask", description: "The carrier's rate in whole US dollars, digits only", required: true },
    ],
    body: { loadId: "load_id", carrierAsk: "carrier_ask" },
  },
  {
    name: "get_trip_estimate",
    exposedFields: ["status", "message", "carrierNetUsd", "feasibility"],
    description:
      "Estimate what the carrier keeps on a load after diesel and tolls, at the rate on the table, and whether the window needs a team. Call it when the carrier asks what they'd clear, what fuel or tolls run, or pushes on the rate.",
    path: "/v1/trips/estimate",
    waitMessage: "Let me run the numbers on that lane.",
    parameters: [{ name: "load_id", description: "The load number, e.g. LD00881", required: true }],
    body: { loadId: "load_id" },
  },
  {
    name: "create_hold",
    exposedFields: ["status", "message", "holdStatus"],
    description: "Put the agreed load on hold for a senior rep to confirm. Call it right after evaluate_offer accepts.",
    path: "/v1/holds",
    waitMessage: "Perfect, locking that in for you.",
    parameters: [
      { name: "load_id", description: "The load number", required: true },
      { name: "agreed_rate", description: "The rate evaluate_offer accepted, in whole US dollars", required: true },
    ],
    body: { loadId: "load_id", agreedRate: "agreed_rate" },
  },
  {
    name: "save_capacity",
    exposedFields: ["status", "message"],
    description:
      "Keep the carrier's truck on file so we can send them a load later. Call it only after the carrier said yes to being contacted and told you where and when the truck frees up.",
    path: "/v1/capacity",
    waitMessage: "Okay, saving that.",
    parameters: [
      { name: "city", description: "City where the truck frees up, e.g. Dallas", required: true },
      { name: "state", description: "State where the truck frees up, as a two-letter code, e.g. TX", required: true },
      { name: "free_date", description: "Day the truck frees up as YYYY-MM-DD", required: true },
      { name: "equipment_type", description: "The carrier's equipment as given to search_loads, or any", required: false },
      { name: "preferred_destination_state", description: "Two-letter state the carrier wants to head to, if they said", required: false },
      { name: "consent", description: "yes only when the carrier said yes to being contacted about a load; otherwise no", required: true },
    ],
    body: {
      city: "city",
      state: "state",
      freeDate: "free_date",
      equipmentType: "equipment_type",
      preferredDestinationState: "preferred_destination_state",
      consent: "consent",
    },
  },
  {
    name: "request_human",
    exposedFields: ["status", "message"],
    description: "Hand the call to a senior rep. Call it when the carrier asks for a human or a senior rep.",
    path: "/v1/calls/request-human",
    waitMessage: "Sure, getting a rep for you.",
    parameters: [{ name: "reason", description: "Why the carrier wants a human, in a few words, if they said", required: false }],
    body: { reason: "reason" },
  },
];

// Signals let a senior rep watching the call steer the agent mid call. The platform accepts
// this field on the agent node, but the SDK does not type it, so it is set on the plain node.
const agentSignalsConfig = { enabled: true, shouldRespondOnSignal: true, customTopics: [] as string[] };

function withAgentSignals(nodes: NodeInput[], agent: NodeRef): NodeInput[] {
  return nodes.map((node, index) =>
    index === agent.__index ? { ...node, configuration: { ...node.configuration, agentSignalsConfig } } : node,
  );
}

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
  const { agent, prompt } = aiAgentInbound(wf, "carrier_sales_agent", trigger, {
    agent: {
      name: text("Pablo"),
      languages: [{ type: "static", static: { id: "en", name: "English" } }],
      voices: [{ type: "static", static: { id: "tz9x2rl3l6da", name: "Christopher HR" } }],
    },
  });
  prompt.setPrompt({
    prompt_md: readFileSync(new URL("./prompt.md", import.meta.url), "utf8"),
    initial_message: "Thanks for calling HappyRobot Logistics, this is Pablo, an AI assistant on a recorded line. What's your MC number?",
  });
  for (const spec of tools) addTool(wf, prompt, spec, options);
  return {
    name: wf.name,
    nodes: withAgentSignals(wf.toNodes(), agent),
    exposedToolFields: Object.fromEntries(tools.map((t) => [t.name, t.exposedFields])),
    // One row per completed call with every variable the run produced (transcript, tool results).
    runDumpTable: "call_log",
  };
}
