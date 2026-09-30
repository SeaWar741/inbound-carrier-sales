// Delivers one-time passcodes and hold notices; the adapter writes the text. It triggers these
// workflows directly, so a code never passes through the voice agent's workflow or its LLM. One workflow per channel keeps
// each one a straight line (trigger -> send) with nothing to branch on.
import {
  WorkflowBuilder,
  happyrobotEmailSendEmail,
  text,
  variable,
  webhookPredefinedRequest,
  type NodeInput,
} from "@happyrobot-ai/workflow-sdk";

type WorkflowDefinition = { name: string; nodes: NodeInput[] };

// Send SMS (Text integration) is not typed in the workflow SDK yet, so it is added as a raw node.
const sendSmsEventId = "019e3b65-e185-7c44-b042-67de4be40728";

export function buildOtpEmail(): WorkflowDefinition {
  const wf = new WorkflowBuilder("otp-email");
  const trigger = webhookPredefinedRequest(wf, "otp_request", { params: ["to", "subject", "body"] });
  happyrobotEmailSendEmail(wf, "send_otp_email", trigger, {
    to: variable(trigger, "to"),
    from_name: text("Carrier Sales"),
    subject: variable(trigger, "subject"),
    body: variable(trigger, "body"),
  });
  return { name: wf.name, nodes: wf.toNodes() };
}

export type OtpSmsOptions = { twilioCredentialId: string; twilioPhoneNumber: string };

export function buildOtpSms(options: OtpSmsOptions): WorkflowDefinition {
  const wf = new WorkflowBuilder("otp-sms");
  const trigger = webhookPredefinedRequest(wf, "otp_request", { params: ["to", "body"] });
  const nodes = wf.toNodes();
  nodes.push({
    type: "action",
    event_id: sendSmsEventId,
    name: "send_otp_sms",
    parent_node_index: trigger.__index,
    configuration: {
      to: variable(trigger, "to"),
      body: variable(trigger, "body"),
      smsConfig: {
        provider: "bring_your_own_twilio",
        twilioCredentialId: options.twilioCredentialId,
        twilioPhoneNumber: { type: "static", static: { id: options.twilioPhoneNumber, name: options.twilioPhoneNumber } },
      },
    },
  });
  return { name: wf.name, nodes };
}
