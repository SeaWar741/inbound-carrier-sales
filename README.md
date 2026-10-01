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
Fake demo data for the dashboard and inbox: `npm run seed:demo` (24 carriers marked `demo-` / `DM`, reseeds from scratch); `npm run seed:demo -- --teardown` removes only those rows. The seed also saves 4 capacity trucks: 3 fitted to real OPEN loads it reads from the TMS (read only, so seeding needs `TMS_HOST`/`TMS_PORT`/`TMS_TOKEN`; teardown does not) and 1 in a state with no fit. Their load notices go to `DEMO_NOTICE_EMAIL`; unset, the trucks show no contact and cannot be notified.

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

## Carriers and demand

Two operator pages built from what the inbound calls already record: **Carriers** (who to call back and why) and **Demand** (lanes carriers ask for that the board did not cover). The adapter routes are `GET /v1/operator/network`, `GET /v1/operator/demand` and `GET /v1/operator/demand/carriers`, in `src/routes/operator-network.ts`. Each is one Twin query. Every search that reaches the board is stored in `load_searches`.

### Carriers

The page reads a fixed window: the last 30 days. There is no date range to pick. Each carrier gets one relationship status, first match wins:
- **New**: fewer than `segmentNewMaxCalls` (3) calls ever. There is no pattern to judge yet.
- **At risk**: at least one booking ever, and either no call in `segmentRecentDays` (14) days, or fewer than half as many calls in the last 14 days as in the 14 before. An at-risk carrier stays listed even when its last call is older than 30 days, because going quiet is what puts it there.
- **Active**: everyone else.

Two tags sit on top of the status, independent of it and of each other:
- **Top**: at least `segmentTopMinBookings` (2) bookings in the 30 days, and at least `segmentTopMinRate` (0.5) bookings per call that reached an offer. Calls that failed verification or found no load do not count against a carrier.
- **Lane open**: a lane the carrier searched or negotiated has an open load on the board now. The match is strict: the exact origin state, destination state and equipment, or origin state and equipment alone when the carrier booked that exact lane 2 or more times. A search's Any destination or equipment matches only that part. Under an equipment or origin filter, only an open lane that matches the filter counts, so the tag, the Lane open number and a click on the side panel agree.

A carrier can be At risk, Top and Lane open at once, so the statuses overlap. They are decided once, in SQL, and the tower only words the reason on the row. The key numbers and status counts follow the filters but never the chosen status. Each row opens the carrier's calls in place, and a link opens it in the Inbox; there is no separate profile page.

A booking is a hold in `booked` or `booked_unconfirmed`, the same as the inbox and the dashboard. A carrier's lanes count calls, not rows: a call that searched a lane and negotiated a load on it ran it once.

### Demand

Only uncovered demand shows: a search that found a load is covered and counts nowhere. Rows are lane (origin state to destination state, or Any) x equipment (or Any), over the last 4 desk weeks in `America/Chicago`. Per row:
- **No match**: searches from `load_searches` that found nothing, grouped by the lane the carrier asked for.
- **Offered, no booking**: a load negotiated on a call that ended with no live hold on it, grouped by the offered load's lane. Twin records no explicit carrier rejection (`offers.decision` is our verdict, and calls carry no outcome), so the page never says "rejected".
- **Unmet** = no match + offered, no booking. Rows sort by unmet by default.
- **Carriers**: distinct carriers with an unmet ask on the row. Opening the row lists who asked, a page at a time.
- **Last → this wk**: unmet in the desk week before against this one.
- **Next step**: find a load when the board had nothing, check the rate when offers did not book. It opens the Dashboard filtered to the row's origin state and equipment.

There is no booked column. A search has no id that follows it to an offer and a hold, so a booking cannot be tied to the search that led to it. A search that found nothing only because the TMS failed to return load details is not recorded, so an outage never reads as demand.

### Prior art

- [Highway Lane Intelligence](https://highway.com/lane-intelligence) shows why a carrier is recommended, with a count and a window. We take that: every reason names its numbers and its window.
- [DAT LaneMakers](https://secure.businesswire.com/news/home/20250505910165/en/DAT-introduces-LaneMakers-for-DAT-iQ-Benchmark-to-help-shippers-find-capacity-for-underserved-lanes) starts from the underserved lane and lists the carriers active on it. We take the lane-first view: a demand row opens to who asked.
- [Parade](https://help.parade.ai/en/articles/2673088-interpreting-carrier-profile) ranks carriers with a score. We discard scores and show raw counts, so a rep can check them.
- RFM segmentation ([Count](https://count.co/metric/rfm-segmentation), [Umbrex](https://umbrex.com/resources/frameworks/marketing-frameworks/rfm-segmentation-recency-frequency-monetary/)) is the baseline behind New, At risk and Top: recency, frequency and bookings. The baseline to beat is a list sorted by bookings.
- We found no public product with an "asked but not covered" view, so the Demand page is our own.

### Known limits

- Only inbound calls count. Outbound touchpoints are not recorded, so At risk means no recent inbound call.
- The board is read with one LOAD_QUERY per equipment type, capped at `openLanesPerEquipment` (50) loads each and cached `openLanesCacheMs` (10 minutes) in memory. LOAD_QUERY has no status filter, so a type that fills the cap may hide open lanes, and the adapter logs it. When the TMS cannot be read, no lane shows as open and the page says so.
- Lanes are matched at the state level, not the city.
- Zip-only searches have no origin state and do not appear on the Demand page.

## Capacity capture

When a verified carrier finds no load it can take, the agent offers to keep the truck on file: city, state, the day it frees up, equipment (or any) and an optional preferred destination state, saved only with the carrier's consent (`POST /v1/capacity`, table `truck_capacity`). The Dashboard's Free trucks panel lists the saved trucks with the OPEN loads that fit each one, and a rep sends one load to the carrier with a click (`GET /v1/operator/capacity`, `POST /v1/operator/capacity/:id/notify`, in `src/routes/capacity.ts`). Nothing is sent automatically.

Match rule (`fitsTruck`): the load picks up in the truck's state, with its equipment (any when the carrier said any), from the free date through `capacityWindowDays` (2) days after. A load with a live hold is hidden. A load to the preferred destination state ranks first but never filters. The panel shows the newest `capacityTrucksShown` (20) trucks still inside their window, and each board read is cached `openLanesCacheMs` (10 minutes). A truck gets one notice; the notice quotes the posted rate only and goes to the email or phone verified on the call, which the panel never shows.

KPIs on the wall:
- **Booked load value**: sum of agreed rates on today's booked holds (desk day, `America/Chicago`).
- **Win rate on offered**: today's booked holds over today's calls that were offered a load (a search returned loads or an offer was made).
- **Trucks captured funnel**, over the last 7 desk days: trucks captured, then notified, then booked after notice (the same carrier booked the notified load after the notice went out).

### Prior art

- [Parade](https://parade.ai/) matches carrier-posted capacity to open loads and puts the offer in front of a rep. DAT [truck posting](https://www.dat.com/) lists a truck by origin, equipment and available date. [Loadsmart](https://loadsmart.com/) keeps carriers' preferred lanes.
- We took the per-truck match on lane, equipment and date, and an offer a human sends.
- We dropped auto-send (a wrong load sent in our name costs more than a click), radius and geocoding matching (it needs a geocoder and is not free; state level is enough for a demo board), and several notices per load (one notice per truck keeps the carrier from being spammed).

### Known limits

- States, not distance: a truck near a state border never sees a load across it.
- Each board read is one LOAD_QUERY capped at 50 results, with no status filter, so a full answer may leave open loads out; the adapter logs it.
- Booked after notice is a correlation: the carrier may have booked that load without the notice.

## Margin and negotiation research

Researched on 2026-09-30, to answer "are our margins standard?". Figures are dated and sourced; vendor numbers are marketing claims.

### What the tower can and cannot say

A broker's gross margin is (shipper rate - carrier rate) / shipper rate. The TMS gives the posted rate and the max buy, never the shipper rate, so the tower cannot show margin. What it shows is headroom: max buy - agreed rate, labelled "Under our max". The max buy is usually set as the sell rate minus a minimum margin, or from a market rate engine: [Triumph](https://intelligencehelp.triumph.io/en/articles/8371238-triumph-rates-best-practices) uses its buy rate as the max buy and marks up 10% to 16% by confidence. If our TMS works that way, headroom is margin on top of that minimum, but that is not confirmed.

Our real bookings on Twin (n=21, demo rows excluded): posted $4,558, agreed $4,912 (+6.9% over posted, 20 of 21 above it), max buy $5,243 (+15.3% over posted), headroom $331 (7.2% of the max). The agent gives away about 45% of the posted to max gap. No public data measures how far above posted carrier deals usually close, so this cannot be benchmarked yet.

### Gross margin benchmarks

| Source | Period | Gross margin |
| --- | --- | --- |
| TIA members, all modes ([Logistics Management](https://www.logisticsmgmt.com/article/tia_report_signals_continued_recovery_in_freight_brokerage_market)) | Q2 2026 | 17.8% (invoice $1,989 per shipment) |
| TIA members ([FreightCaviar](https://www.freightcaviar.com/small-freight-brokers-outperform-on-volume-margin-pressure-mounting)) | Q2 2023 to Q1 2025 | from over 16% to just above 15% |
| C.H. Robinson NAST ([8-K](https://www.sec.gov/Archives/edgar/data/0001043277/000104327726000027/ex991earningsreleaseq20630.htm)) | Q2 2026 | 13.1% (14.8% a year earlier) |
| J.B. Hunt brokerage ([ARK TMS](https://arktms.com/blog/freight-broker-margin-compression-purchased-transportation-costs-2026)) | Q2 2026 | 12.5% (15.5% a year earlier) |
| RXO brokerage ([release](https://investors.rxo.com/news/news-details/2026/Market-Share-Gains-and-Improved-Profitability-Drive-Strong-Second-Quarter-Results-for-RXO/default.aspx)) | Q2 2026 | 10.7% (14.4% a year earlier) |
| Landstar, all truck ([8-K](https://www.sec.gov/Archives/edgar/data/0000853816/000119312526321050/d123956dex991.htm)) | Q2 2026 | 9.2% |

A healthy range is roughly 11% to 18%, falling in 2026 as carrier costs outrun contract rates (C.H. Robinson Q2 2026: cost per mile +29.0% against price per mile +25.5%). Spot freight carries a wider dollar margin than contract. Buying above market does not by itself mean a poor margin ([TIA](https://news.tianet.org/youre-only-looking-at-half-the-rate/)).

### What the negotiation literature says about our policy

The agent counters at 35%, 60% and 80% of the posted to max gap and accepts any ask at or under its counter (`concessionSchedule` in `src/constants.ts`).
- Shrinking steps (+35, +25, +20 points) signal that a floor is near, and the other side then infers a higher reservation price and gets a better deal: seven studies, 2,311 participants ([Tey et al. 2021](https://www.insead.edu/faculty-research/publications/journal-articles/impact-concession-patterns-negotiations-when-and-why)). Human negotiators, not carriers.
- The first offer anchors the outcome, about $0.50 of final price per $1 of opening ([Orr and Guthrie 2006](https://ir.vanderbilt.edu/handle/1803/7415)). The carrier asks first, so it holds the anchor; naming our target and the carrier's alternatives weakens it ([Galinsky and Mussweiler 2001](https://pubmed.ncbi.nlm.nih.gov/11642352)).
- Across seven field markets, splitting the difference between the last two offers is the most common move, is accepted more often and ends fewer negotiations ([Keniston et al., NBER w29111](https://ideas.repec.org/p/nbr/nberwo/29111.html)). Accepting any ask under our counter captures none of that.
- Time-dependent tactics (Boulware vs Conceder) are the reference model for automated negotiators ([Faratin, Sierra and Jennings 1998](https://spiral.imperial.ac.uk/entities/publication/591e717c-cc0e-4d61-8c68-8925b34c4b4d)).
- Vendor claims, no method published: Parade reports $154 saved per load with AI against $115 rep only ([Parade](https://www.parade.ai/resources/ai-amplifies-carrier-negotiation-performance)); HappyRobot reports 10% higher margins at Circle Logistics ([case study](https://happyrobot.ai/blog/circle-logistics-x-happyrobot-case-study)).
- No published work covers dynamic reservation prices for carrier negotiation, or accept against counter on a broker desk.

### Next step

A negotiation cycle, tested before it ships:
- Candidate rules: even or growing concession steps, a counter at the midpoint when an acceptable ask sits well above posted, and a first counter anchored on our target.
- A lane signal, holding firmer where Demand shows many carriers asking.
- Test first by replaying recorded asks and simulating carrier personas that concede fast, hold out, or probe for our floor. Then A/B test per call on booked rate, paid over posted, share of the gap used, walk-away per round, and rounds to a deal. At n=21 no difference in booked rate is detectable.

## Deploy

`render.yaml` is a Render Blueprint (Docker, free plan). Secrets are entered in the Render dashboard.
