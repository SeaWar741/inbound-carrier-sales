# Inbound Carrier Sales

TMS adapter and HappyRobot workflow for an AI voice agent that handles inbound carrier calls: carrier verification (FMCSA), one-time passcode, load search against the legacy TMS, rate negotiation within a ceiling the model never sees, and load holds confirmed by a senior rep.

## Run locally

```sh
cp .env.example .env   # fill in the values
npm install
npm run dev            # http://localhost:8080/healthz
npm run typecheck && npm test
```

Requires Node 25 (TypeScript runs natively, no build step).

## Auth

Every `/v1` route requires an `x-api-key` header. Two keys, two principals:

| Key | Caller | Routes |
|---|---|---|
| `AGENT_API_KEY` | HappyRobot agent workflow | verify, OTP, search, offers, create hold |
| `OPERATOR_API_KEY` | Control tower | confirm hold (the only route that books in the TMS) |

`GET /healthz` is public and never touches the TMS.

## Deploy

`render.yaml` is a Render Blueprint (Docker, free plan). Secrets are entered in the Render dashboard.
