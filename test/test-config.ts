import type { Config } from "../src/config.ts";

export const testConfig: Config = {
  PORT: 0,
  TMS_HOST: "127.0.0.1",
  TMS_PORT: 1,
  TMS_TOKEN: "test-tms-token",
  FMCSA_API_KEY: "fmcsa-web-key-secret",
  HAPPYROBOT_API_KEY: "test-happyrobot-key",
  AGENT_API_KEY: "agent-key-0123456789",
  OPERATOR_API_KEY: "operator-key-0123456789",
  OTP_DELIVERY_MODE: "demo",
  OTP_HASH_SECRET: "otp-hash-secret-0123456789",
  OTP_EMAIL_WORKFLOW_ID: "wf-otp-email",
  OTP_SMS_WORKFLOW_ID: "wf-otp-sms",
  HAPPYROBOT_ENVIRONMENT: "development",
  OTP_DEMO_EMAIL: "demo@example.com",
  OTP_DEMO_PHONE: "+15555550100",
};
