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
Fake demo data for the dashboard and inbox: `npm run seed:demo` (24 carriers marked `demo-` / `DM`, reseeds from scratch); `npm run seed:demo -- --teardown` removes only those rows.

## Simulated calls

```sh
npm run simulate                        # all personas at once, prints one line per run
npm run simulate -- closer walker       # a subset
npm run simulate -- haggler --wait      # polls every 5 s until the runs finish (5 minute cap)
```

Runs HappyRobot e2e scenarios (text sessions, `whole_run`, up to 30 caller messages) against the live `development` version of the agent. Each persona is a scenario created once by name and updated when its prompt changes. They assume the adapter runs against `npm run fake:tms` with `OTP_FIXED_CODE=424242`. Eligible personas use MC 135797 (J B Hunt Transport Inc).

Personas that search (`closer`, `haggler`, `walker`, `human`) get a load picked at run time, printed before the runs start. The picker reads the same board snapshot as the fake TMS (`TMS_BOARD_SNAPSHOT` or `../docs/raw/tms-board-snapshot-2026-09-28.json`), keeps the OPEN loads, and drops every load with a Twin hold that is not released. Each persona gets a load that is alone in its origin city and equipment, in a city no other persona uses, with room for its script: the first ask draws a counter, the haggler and walker get three rising counters, and the walker's ask stays above the last one. The prompt names that load's origin city, state and equipment, so scenarios are updated on every run.

| Persona | Caller | Expected outcome |
| --- | --- | --- |
| `closer` | Picked load, accepts the first counter | Hold placed (booked in autonomous mode) |
| `haggler` | Picked load, three rounds, takes the final counter | Hold placed (booked in autonomous mode) |
| `walker` | Picked load, rejects every counter | Three counters, no deal |
| `suspicious` | MC 135797 but insists on another company name | Refused, never verified |
| `ineligible` | MC 1012, which FMCSA lists as not allowed to operate | Refused at verification |
| `locked` | MC 135797, reads three wrong codes | OTP locked, never verified |
| `human` | Picked load, asks for a senior rep after the first counter | Transferred to a senior rep |

Holds and bookings take loads off the board. The fake TMS keeps its board in memory, so restarting `npm run fake:tms` resets it, but Twin is not reset: booked demo loads stay taken in Twin (there is no cleanup) and the picker skips them. When too few free loads remain, the script stops with a message before starting any run.

## Deploy

`render.yaml` is a Render Blueprint (Docker, free plan). Secrets are entered in the Render dashboard.
