import { z } from "zod";

const secret = z.string().min(16);
const localTmsHosts = new Set(["127.0.0.1", "localhost"]);

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
    // Keys the stored OTP hash so a leaked row cannot be brute-forced over the 10^6 code space.
    OTP_HASH_SECRET: secret,
    OTP_EMAIL_WORKFLOW_ID: z.string().min(1),
    // Without it the SMS channel answers channel_unavailable.
    OTP_SMS_WORKFLOW_ID: z.string().min(1).optional(),
    HAPPYROBOT_ENVIRONMENT: z.enum(["development", "staging", "production"]).default("development"),
    OTP_DEMO_EMAIL: z.email().optional(),
    OTP_DEMO_PHONE: z.string().regex(/^\+[1-9]\d{7,14}$/, "E.164").optional(),
    // Simulated carriers cannot read an inbox, so local runs against the fake TMS may pin the code.
    OTP_FIXED_CODE: z.string().regex(/^\d{6}$/).optional(),
    // Trip estimates need both; without either one the estimator answers null and calls go on without them.
    EIA_API_KEY: z.string().min(1).optional(),
    ORS_API_KEY: z.string().min(1).optional(),
    // Shared rate-limit counters (Render Key Value) so every instance counts together; without it each counts alone.
    REDIS_URL: z.url({ protocol: /^rediss?$/ }).optional(),
  })
  .refine((c) => c.AGENT_API_KEY !== c.OPERATOR_API_KEY, {
    message: "AGENT_API_KEY and OPERATOR_API_KEY must differ",
  })
  .refine((c) => c.OTP_DELIVERY_MODE === "live" || c.OTP_DEMO_EMAIL, {
    message: "demo mode needs OTP_DEMO_EMAIL",
  })
  .refine((c) => c.OTP_DELIVERY_MODE === "live" || !c.OTP_SMS_WORKFLOW_ID || c.OTP_DEMO_PHONE, {
    message: "demo mode with SMS needs OTP_DEMO_PHONE",
  })
  .refine((c) => !c.OTP_FIXED_CODE || (localTmsHosts.has(c.TMS_HOST) && c.OTP_DELIVERY_MODE === "demo"), {
    message: "OTP_FIXED_CODE is only allowed in demo mode against a local fake TMS",
  });

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse(env);
}
