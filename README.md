# Inbound Carrier Sales

TMS adapter and HappyRobot workflow for an AI voice agent that handles inbound carrier calls: carrier verification (FMCSA), one-time passcode, load search against the legacy TMS, rate negotiation within a ceiling the model never sees, and load holds confirmed by a senior rep.

## Run locally

```sh
cp .env.example .env   # fill in the values
npm install
npm run dev            # http://localhost:8080/healthz
npm run typecheck && npm test
npm run fake:tms       # local TMS on 127.0.0.1:9400 (FAKE_TMS_PORT) serving the board snapshot (TMS_BOARD_SNAPSHOT), searches list only its OPEN loads; point TMS_HOST/TMS_PORT at it; with it, OTP_FIXED_CODE pins the OTP so simulated carriers can pass verification
```

Requires Node 25 (TypeScript runs natively, no build step).

## Auth

Every `/v1` route requires an `x-api-key` header. Two keys, two principals:

| Key | Caller | Routes |
|---|---|---|
| `AGENT_API_KEY` | HappyRobot agent workflow | verify, OTP, search, offers, create hold |
| `OPERATOR_API_KEY` | Control tower | confirm hold (the only route that books in the TMS), release hold |

`GET /healthz` is public and never touches the TMS.

## HappyRobot workflows

Workflows are code in `workflow/` and are pushed with the public API; each push forks the latest version, replaces its nodes and publishes to `development`.

```sh
npm run push:workflow -- otp-email              # OTP delivery by email (built-in Email node)
npm run push:workflow -- otp-sms                # OTP delivery by SMS (needs TWILIO_CREDENTIAL_ID, TWILIO_PHONE_NUMBER)
npm run push:workflow -- inbound-carrier-sales  # the voice agent (needs ADAPTER_URL, AGENT_API_KEY)
```

- **Agent** (`workflow/agent.ts`, `workflow/prompt.md`): Web Call trigger, one inbound voice agent, six tools (`verify_carrier`, `send_otp`, `check_otp`, `search_loads`, `evaluate_offer`, `create_hold`). Each tool is a webhook to this adapter keyed by the run id. The agent sees only a whitelist of response fields per tool; the load's max buy never reaches it.
- **OTP delivery** (`workflow/otp-delivery.ts`): the adapter starts these workflows directly, so a code never passes through the agent or its model.
- **Call log**: completed runs are dumped to the Twin table `call_log`.

Pushing the agent generates each tool's result once, which calls the adapter with blank input, so the adapter must be running at `ADAPTER_URL`.

Twin tables are created with `npm run bootstrap:twin` (idempotent; also applies migrations and prints SQL latency).

## Simulated calls

```sh
npm run simulate                    # all personas at once, prints one line per run
npm run simulate -- haggler --wait  # one persona, polls every 5 s until it finishes (5 minute cap)
```

Runs HappyRobot e2e scenarios (text sessions, `whole_run`) against the live `development` version of the agent. Each persona (`haggler`, `suspicious`, `human`) is a scenario created once by name and updated when its prompt changes. They use MC 135797 and assume the adapter runs against `npm run fake:tms` with `OTP_FIXED_CODE=424242`. A simulated call can place a hold but never book: booking runs only from the operator confirm route.

## Deploy

`render.yaml` is a Render Blueprint (Docker, free plan). Secrets are entered in the Render dashboard.
