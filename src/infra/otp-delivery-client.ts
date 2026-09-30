import { z } from "zod";

export type OtpChannel = "email" | "sms";

// The slice of @happyrobot-ai/sdk this client uses, so tests can stub it.
export type WorkflowRunner = {
  workflows: { triggerRun(workflowId: string, body: { environment: string; payload: Record<string, string> }): Promise<unknown> };
};

export type OtpDeliveryClientOptions = {
  runner: WorkflowRunner;
  environment: "development" | "staging" | "production";
  emailWorkflowId: string;
  smsWorkflowId?: string;
};

const triggerResponse = z.object({ run_id: z.string() });

export type CarrierMessage = { subject: string; body: string };

// Starts the per-channel delivery workflow, for verification codes and hold notices alike.
// The message rides in the run payload only.
export class OtpDeliveryClient {
  readonly #options: OtpDeliveryClientOptions;

  constructor(options: OtpDeliveryClientOptions) {
    this.#options = options;
  }

  supports(channel: OtpChannel): boolean {
    return channel === "email" || this.#options.smsWorkflowId !== undefined;
  }

  async send(channel: OtpChannel, to: string, message: CarrierMessage): Promise<string> {
    const workflowId = channel === "email" ? this.#options.emailWorkflowId : this.#options.smsWorkflowId;
    if (!workflowId) throw new Error(`no workflow configured for ${channel}`);
    try {
      const response = await this.#options.runner.workflows.triggerRun(workflowId, {
        environment: this.#options.environment,
        payload: channel === "email" ? { to, subject: message.subject, body: message.body } : { to, body: message.body },
      });
      return triggerResponse.parse(response).run_id;
    } catch (error) {
      // Never echo the payload: it can carry a code.
      throw new Error(`${channel} delivery failed (${error instanceof Error ? error.name : "unknown error"})`);
    }
  }
}
