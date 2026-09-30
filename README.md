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
| `AGENT_API_KEY` | HappyRobot agent workflow | verify, OTP, search, offers, trip estimate (`POST /v1/trips/estimate`), create hold |
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
| `flexible` | Picked load, runs any equipment | Search without an equipment filter, hold placed |
| `curious` | Picked load, asks which email is on file before choosing | Agent reads the masked contact, hold placed |
| `netAsker` | Picked load, asks what they would clear after fuel and tolls | Agent quotes the trip estimate, hold placed |

Holds and bookings take loads off the board. The fake TMS keeps its board in memory, so restarting `npm run fake:tms` resets it, but Twin is not reset: booked demo loads stay taken in Twin (there is no cleanup) and the picker skips them. When too few free loads remain, the script stops with a message before starting any run.

## Trip Intelligence

For each load, the agent and the tower estimate what the carrier keeps and whether the load can be delivered on time. Everything is priced at the rate on the table. The estimate is computed on demand, cached in memory, and stored on the hold (`holds.trip`).

What it computes:
- Diesel: TMS miles / mpg x the regional diesel price.
- Tolls: TMS miles x the share of the route on toll roads x the cost per toll mile.
- Carrier net: rate - diesel - tolls. It never includes our margin or max buy.
- Legal ETA under hours of service, for a solo driver or a team, and net per hour.

The math is in `src/domain/trip-estimate.ts`. The vendor clients are in `src/infra/`. Every tuned number is in `src/constants.ts`, with its source. The facts below were verified on 2026-09-29.

| Input | Source | Notes |
| --- | --- | --- |
| Diesel $/gal | [EIA API v2](https://www.eia.gov/opendata/) `petroleum/pri/gnd`, product `EPD2D`, weekly | 9 areas (NUS, New England, Central Atlantic, Lower Atlantic, Midwest, Gulf Coast, Rocky Mountain, West Coast, California). The lane price averages the origin and destination areas. EIA publishes Tuesdays around 10:00 ET with Monday prices, so the price is cached 7 days. There is no SDK, and the key rides in the query string, so the URL is never logged. |
| Speed and toll share | [openrouteservice](https://openrouteservice.org/) `driving-hgv` with `extra_info: ["tollways"]` | Routed between ZIP3 centroids (`control-tower/lib/zip3-centroids.json`), so there is no geocoding. `tollways.summary[].amount` is a percent of the route, not money. |
| Miles | TMS | ORS miles differ from TMS miles: Tacoma to Baltimore is 2,789 in ORS and 2,335 in the TMS. Cost and time use the TMS miles the agent pitches. ORS supplies only the average speed and the toll share. |
| Tolls | $0.226 per toll mile, the Ohio Turnpike Class 5 E-ZPass rate (2026) | A floor: Indiana (~$0.56/mi) and Pennsylvania charge more. ATRI's 4.3 cents is averaged over all miles, so it would undercount toll miles. |
| Fuel economy | 6.3 mpg | Class 8 average, AFDC data/10310 (FHWA VM-1 2024). |
| Hours of service | 49 CFR 395.3 | 11 h of driving per shift, a 30 min break after 8 h of driving, and 10 h off between shifts. A team drives about 22 h in 24. The 14 h window and the 60/70 h cycle are ignored. |
| Late tolerance | 2 h past the delivery appointment | Receivers give roughly 15 min to 2 h of grace ([Termont](https://www.termont.com/wp-content/uploads/2026/02/Communication-Termont-RDV-Grace-period-before_26_02_2026_EN.pdf) 15 min, [APM Terminals](https://www.apmterminals.com/en/port-elizabeth/practical-information/news-and-alerts/2025/251126-Appt-Window-Changes-FAQs) 1 h, retail DCs 2 h windows). We take the loose end. |

Feasibility compares the legal ETA with the delivery appointment plus the tolerance:
- `solo` means a single driver makes it.
- `team` means only a team makes it.
- `impossible` means no crew makes it.

What each result does:
- Search never pitches an `impossible` load.
- `create_hold` refuses one with `window_too_tight`.
- For a `team` load, the agent asks whether the carrier runs team.
- A failed estimate never blocks a load or a hold.

Measured on this board: in the 2026-09-28 snapshot, the 50 OPEN loads split 25 solo, 11 team, 7 impossible (never pitched), and 7 that ORS could not route (they now use the fallback speed).

Vendor latency: 5 calls from a laptop took 254 to 1,577 ms for ORS and 111 to 1,331 ms for EIA. The 4.5 s timeout is about 3x the slowest call.

Known limits:
- When ORS cannot route a lane (quota exceeded, a rural centroid too far from a road, error 2010, or a route over 6,000 km, error 2004), the estimate falls back to 45 mph of pure driving and leaves tolls out ("before any tolls"), so the window check never switches off.
- Diesel is the regional retail average, not a fleet card price.
- Tolls use one national rate.
- The hold snapshot is not refreshed before pickup.
- The dashboard and map ETA still use the 50 mph estimate. The inbox load panel and carrier header show the legal ETA once the load has a hold with an estimate.
- A booking the TMS did not confirm (`booked_unconfirmed`) sends no notice to the carrier. A rep checks the TMS and calls the carrier.

## Deploy

`render.yaml` is a Render Blueprint (Docker, free plan). Secrets are entered in the Render dashboard.
