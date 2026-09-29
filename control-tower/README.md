# Control Tower

The operator console for the inbound carrier sales agent. A senior rep signs in with a passcode and watches every call the agent takes, steps in when needed, and books or releases the loads the agent holds.

It is a Next.js app. Every secret stays on the server; the browser only holds a signed session cookie.

## What it shows

- **Call wall**: every call of the day with its stage (connecting, verifying, OTP, searching, negotiating, holding, booked, released, ended) and a risk color (green, amber, red) with the reason.
- **Day counters**: calls, loads booked, fraud blocked, dollars generated and margin saved.
- **TMS health**: attempts, retries, faults absorbed and p50 / p95 latency of the legacy TMS since the adapter started.
- **Live transcript**: the agent and carrier lines of the selected call, plus the tools the agent calls. The transcript stays readable after the call ends.
- **Listen / whisper / take over**: listen plays the call audio; take over puts the rep on the line in place of the agent; a whisper sends a private instruction to the agent mid-call. Authorize +$50 lets the agent go that much higher on the current load.
- **Lane map**: origin and destination of the load under discussion.
- **Margin meter**: posted rate, the carrier's ask, our counter and the load's MAX_BUY, round by round. MAX_BUY is operator only: the agent never sees it.
- **Hold card**: the load, the agreed rate and the margin kept. Confirm books the load in the TMS (two presses, so a stray click never books); Release frees it.
- **Human in the loop / Autonomous switch**: applies to every new hold. Human in the loop (the default) waits for a rep to confirm each hold in the tower. Autonomous books the load as soon as the carrier agrees, under the same MAX_BUY guard.

## Run locally

Requires Node 25 for the adapter and Node 22 or later for the tower. From the repo root:

```sh
# 1. Fake TMS on 127.0.0.1:9400 (reads TMS_TOKEN from the root .env)
npm run fake:tms

# 2. Adapter against the fake TMS, in another terminal
TMS_HOST=127.0.0.1 TMS_PORT=9400 TMS_TOKEN=<same token as the fake TMS> \
OTP_FIXED_CODE=424242 OTP_DELIVERY_MODE=demo \
npm run dev

# 3. Twin tables (idempotent)
npm run bootstrap:twin

# 4. Expose the adapter so the agent's tool webhooks can reach it
ngrok http 8080
#    set ADAPTER_URL in the root .env to the https URL ngrok prints, then
npm run push:workflow -- inbound-carrier-sales   # prints the workflow id for WORKFLOW_ID

# 5. The tower
cd control-tower
cp .env.example .env.local   # fill in the values; ADAPTER_URL=http://localhost:8080 works locally
npm install
npm run dev                  # http://localhost:3000

# 6. Simulated calls, from the repo root
npm run simulate
```

Shell variables win over the `.env` file, so the overrides in step 2 point the adapter at the fake TMS without editing `.env`. Restarting `npm run fake:tms` resets its board. Checks: `npm run typecheck` at the root and `npx tsc --noEmit` in `control-tower`.

## Environment variables

All of them are server only; none is prefixed `NEXT_PUBLIC_`.

| Variable | What it is |
| --- | --- |
| `OPERATOR_PASSCODE` | Passcode the rep types on `/login` (8+ characters). |
| `SESSION_SECRET` | Random secret, 32+ characters, that signs the session cookie. |
| `ADAPTER_URL` | Base URL of the adapter. |
| `OPERATOR_API_KEY` | The adapter's operator key (16+ characters). Never the agent key. |
| `HAPPYROBOT_API_KEY` | HappyRobot API key used for runs, sessions, signals and voice tokens. |
| `WORKFLOW_ID` | Id of the `inbound-carrier-sales` workflow (a UUID). |

Use a separate HappyRobot API key for the tower. The public API allows 300 requests per minute per key, and the adapter's tool calls use the same budget when the key is shared. The tower polls every 2 s and fetches each run's session once, about 60 requests per minute with any number of open tabs.

## How it works

- **Twin is the bus.** The adapter writes `call_events`, `interventions`, offers and holds (with `posted_rate`, `max_buy` and the lane) and `settings` (the autonomy mode). The tower reads them through the adapter's operator API (`/v1/operator/wall`) and writes through it too (interventions, hold confirm and release, the autonomy switch).
- **HappyRobot runs and sessions** give live state: which runs are in progress, their session, and the transcript stream. Sessions keep their messages after the call, so ended calls still show their transcript.
- **Signals carry whispers.** The adapter records the whisper first, then the tower publishes it to the session. HappyRobot answers only once the running agent has taken it, about 11 s today, so the UI shows Sending and then Delivered.
- **Voice tokens** power listen and take over. They work on voice web calls only; simulator runs are text sessions, so those buttons stay disabled for them.

## Import into HappyRobot Apps

HappyRobot Apps imports a Next.js project from its own GitHub repository, so split the tower out of this repo first:

```sh
git subtree split --prefix control-tower -b control-tower-app
git push <your-github-remote> control-tower-app:main
```

Then in HappyRobot: **Apps**, **Create App**, **Import from existing repo**, give the repository URL and a GitHub token with read access. The platform copies the code into a managed repository and deploys it on Vercel with `next build`. The first build of an imported app often fails; read the build logs and adjust.

Set the six variables above in the app's **Environment variables** panel. Each change triggers a redeploy. `ADAPTER_URL` must be the adapter's public URL (the Render deploy or an ngrok tunnel), never `localhost`: the app runs on Vercel and calls the adapter from there.

## Platform findings

- The Agent Signals toggle is `configuration.agentSignalsConfig` on the agent node. `workflow/agent.ts` sets it on every push; without it whispers never reach the agent.
- Scenario runs refuse a version whose prompt has no enabled Northstars, and every push replaces the nodes, so scenarios must target the current agent persistent id. `npm run simulate` generates the Northstars and updates the scenarios on each run.
- `{{current.today}}` in the prompt gives the agent today's date, so "tomorrow" becomes a real pickup date.
