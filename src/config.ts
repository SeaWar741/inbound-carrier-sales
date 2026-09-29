import { z } from "zod";

const secret = z.string().min(16);

const configSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(8080),
    TMS_HOST: z.string().min(1),
    TMS_PORT: z.coerce.number().int().positive(),
    TMS_TOKEN: z.string().min(1),
    FMCSA_API_KEY: z.string().min(1),
    HAPPYROBOT_API_KEY: z.string().min(1),
    AGENT_API_KEY: secret,
    OPERATOR_API_KEY: secret,
    OTP_DELIVERY_MODE: z.enum(["demo", "live"]).default("demo"),
    OTP_DEMO_EMAIL: z.email().optional(),
    OTP_DEMO_PHONE: z.string().regex(/^\+[1-9]\d{7,14}$/, "E.164").optional(),
  })
  .refine((c) => c.AGENT_API_KEY !== c.OPERATOR_API_KEY, {
    message: "AGENT_API_KEY and OPERATOR_API_KEY must differ",
  })
  .refine((c) => c.OTP_DELIVERY_MODE === "live" || (c.OTP_DEMO_EMAIL && c.OTP_DEMO_PHONE), {
    message: "demo mode needs OTP_DEMO_EMAIL and OTP_DEMO_PHONE",
  });

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse(env);
}
