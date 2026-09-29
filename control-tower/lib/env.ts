import "server-only";
import { z } from "zod";

// Every secret lives on the server; the browser only ever holds the signed session cookie.
const envSchema = z.object({
  OPERATOR_PASSCODE: z.string().min(8),
  SESSION_SECRET: z.string().min(32),
  ADAPTER_URL: z.url(),
  OPERATOR_API_KEY: z.string().min(16),
  HAPPYROBOT_API_KEY: z.string().min(1),
  WORKFLOW_ID: z.uuid(),
  // The HappyRobot environment the workflow's signals are published to.
  HAPPYROBOT_ENVIRONMENT: z.enum(["development", "staging", "production"]).default("development"),
});

export type TowerEnv = z.infer<typeof envSchema>;

let cached: TowerEnv | undefined;
export function env(): TowerEnv {
  cached ??= envSchema.parse(process.env);
  return cached;
}
