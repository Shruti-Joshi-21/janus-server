# Janus server (Track A)

Everything **Janus** calls. Janus is the AI agent (built on Pine Labs' AgenticOrg platform) that coordinates household appliance repairs in India for Team The Phantom Elite, The Ken's Case Build Competition 2026.

This is one Next.js app on Vercel that exposes **six MCP servers** (one per AgenticOrg connector), one **WhatsApp webhook**, and a **call log**.

- **[TOOLS.md](TOOLS.md)**: every tool, its inputs, outputs, example call and error codes. Janus's prompt must use these exact names.
- **[MOCKS.md](MOCKS.md)**: for each mocked partner API, the documentation it was copied from and what is assumed.

## Connectors

| Route | Register on AgenticOrg as | Shows up as | Tools | What it is |
| --- | --- | --- | --- | --- |
| `/janus-core/mcp` | `janus_core_pict` | `mcp_janus_core_pict` | 35 | Janus's own database: people, appliances, technicians, jobs, payments, ratings, complaints, follow-up checks, price fairness, failure switches, demo reset |
| `/gnani/mcp` | `gnani_janus_pict` | `mcp_gnani_janus_pict` | 2 | **Real** Gnani speech-to-text (WhatsApp voice notes) and text-to-speech (voice replies) |
| `/delhivery/mcp` | `delhivery_janus_pict` | `mcp_delhivery_janus_pict` | 6 | **Mock** of Delhivery Maps: validate / verify / geocode / reverse-geocode addresses, distance matrix, autosuggest |
| `/pinelabs/mcp` | `pinelabs_janus_pict` | `mcp_pinelabs_janus_pict` | 13 | **Mock** of Pine Labs One-Time Mandate, UPI AutoPay subscriptions and Payouts |
| `/custom/mcp` | `janus_custom_pict` | `mcp_janus_custom_pict` | 3 | Custom capabilities: `proof_of_presence`, `technician_discovery` (partner Delhivery), `technician_identity_check` (partner Pine Labs) |
| `/whatsapp/mcp` | `whatsapp_janus_pict` | `mcp_whatsapp_janus_pict` | 3 | **Real** Twilio: send WhatsApp messages, make AI-disclosed calls, check delivery (only to known members/technicians) |
| `/api/twilio/inbound` | (Twilio webhook) | | | Incoming WhatsApp → JSON → emailed to the Janus inbox |
| `/api/health` | | | | Returns `{"ok": true}` |

Live base URL: `https://janus-server.vercel.app`

## How a message flows

```
Household's WhatsApp ──► Twilio ──► /api/twilio/inbound ──► email to janus.pict.demo@gmail.com ──► AgenticOrg "Email Received" trigger ──► Janus
                                                                                                                                        │
Janus calls tools on the 5 MCP connectors (all requests recorded in the call log) ◄──────────────────────────────────────────────────┘
Janus replies on WhatsApp through our /whatsapp/mcp connector (real Twilio), because AgenticOrg's native Twilio connector failed its connection test.
```

AgenticOrg has no webhook URL our role can use (its `POST /api/v1/workflows/{id}/run` needs an org-admin API key), so incoming messages travel by **email**. If an admin key becomes available, set `AGENTICORG_WEBHOOK_URL` and `AGENTICORG_API_KEY` and the server posts there instead, with no code change.

## Run it locally

Needs Node 20+ and Git.

```bash
npm install
```
Get the environment variables from Vercel (needs `npx vercel login` and `npx vercel link` once):
```bash
npx vercel env pull .env.local
```
Variables marked Sensitive in Vercel don't come down; add those to `.env.local` by hand (see `.env.example` for every name). Then:
```bash
npm run dev
```
The server runs on http://localhost:3000.

## Environment variables

All are in Vercel → Settings → Environment Variables (and `.env.local` for local work). **Never commit `.env.local`**; Git ignores it.

| Variable | Used for |
| --- | --- |
| `MCP_API_KEY` | The key AgenticOrg sends; every `/…/mcp` route checks it |
| `DATABASE_URL` | Neon Postgres (added by the Vercel ↔ Neon integration) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Checking Twilio's webhook signature; downloading voice notes; sending WhatsApp messages and calls |
| `TWILIO_WHATSAPP_FROM`, `TWILIO_VOICE_FROM`, `TWILIO_SANDBOX_JOIN` | Optional: WhatsApp sender (default sandbox), voice number for `make_call`, sandbox join phrase |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `JANUS_INBOX_EMAIL` | Emailing incoming WhatsApp messages to the Janus inbox (Gmail App Password) |
| `GNANI_API_KEY` | Gnani speech APIs |
| `BLOB_READ_WRITE_TOKEN` | Storing text-to-speech audio in Vercel Blob (`janus-audio`) |
| `AGENTICORG_WEBHOOK_URL`, `AGENTICORG_API_KEY`, `INBOUND_FORWARD_MODE`, `TWILIO_WEBHOOK_URL` | Optional; see `.env.example` |

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Local server on port 3000 |
| `npm run build` | Production build (what Vercel runs) |
| `npm run typecheck` | TypeScript check |
| `npm run reset` | **Wipes the database** and restores the demo cast (the call log is kept) |
| `npm run calls` | Last 20 tool calls to any connector, in IST. `npm run calls -- 50` for more; `npm run calls -- 20 all` to include registrations and handshakes |
| `npm test` | Every test suite against the local server; `npm test -- https://janus-server.vercel.app` for the live server. **Resets the database** before, between and after suites |
| `npm run send:test -- +91… "text"` | Sends ONE real WhatsApp message through the live `send_whatsapp` tool, then checks delivery |
| `npm run docs:tools` | Regenerates the tool reference in TOOLS.md from a running server (`npm run docs:tools -- https://janus-server.vercel.app` for live) |

Janus testers can reset without a terminal: the `reset_demo_data {confirm: "RESET"}` tool on janus_core does the same as `npm run reset`.

## Tests

`tests/` holds 204 checks across 7 suites: janus_core tools (56), price fairness (16), Gnani (15, real API, uses a few seconds of credits), Delhivery mock (37), Pine Labs mock (40), custom capabilities (21), failure switches and reset (19). They act like Janus: they call the tools over MCP exactly as AgenticOrg does, including every failure path. Last full run on the live server: all passing.

## Deploying

Vercel deploys automatically when you push to GitHub (`git push`). After adding or changing environment variables, redeploy (Vercel → Deployments → ⋯ → Redeploy).

**After adding tools to a connector**, AgenticOrg won't see them until the connector is **archived and registered again** with the same name (it only reads the tool list at registration). Then the Janus agent needs the new connector's tools attached again.

## Registering a connector on AgenticOrg

Connectors → Register Connector: Provider **Custom / Generic Connector**, name from the table above, tick **MCP**, MCP Server URL = live base URL + route, Category **Ops**, Auth Type **Api Key**, API Key = `MCP_API_KEY` (only the value, without quotes or `MCP_API_KEY=`). Register connectors in the **Track B teammate's login**, where the Janus agent lives (connectors are only visible to the login that registered them).

If registration says "Could not discover tools from MCP server: ExceptionGroup" while the server is up, the API key is wrong. Check the field shows exactly 64 masked characters.

## Debugging "did Janus really call a tool?"

Run `npm run calls` right after a test. New rows show which tools ran and their result (`ok`, `failed (ERROR_CODE)`, `error`, `HTTP 401`). No new rows means Janus called nothing (check that the connector's tools are attached to the agent, and the platform's approval gate). Vercel → Logs shows the raw requests too.

## Data

- `db/schema.sql`: all tables. `db/seed.sql`: the demo cast (Priya, Rohan, Ramesh, Suresh, Anil, appliances, past jobs, prices, Delhivery places, Pine Labs data). `db/ops.sql`: the call log, which survives resets.
- `db/reference_prices_sources.csv`: the team-collected price list behind `reference_prices` (sources, links, dates).
- Real phone numbers: Priya = Shruti, Ramesh = Aarya, Suresh = Gayatri. Rohan and Anil are placeholders (`+9190000000xx`).
- Placeholders still to replace: AC gas top-up low end (₹700) until technician calls; the yearly price-rise rates (6% parts, 8% labour); geyser heating element and thermostat prices.

## Project layout

```
app/                    one folder per route (janus-core/mcp, gnani/mcp, delhivery/mcp, pinelabs/mcp, custom/mcp, api/twilio/inbound, api/health)
lib/janus-core/         janus_core tools (people, appliances, technicians, jobs, money, price, checks, demo)
lib/gnani/  lib/delhivery/  lib/pinelabs/  lib/custom/   the other connectors
lib/mcp.ts              tool helpers: addTool ({ok} answers) and addMockTool (partner-exact answers)
lib/auth.ts  lib/calllog.ts  lib/scenarios.ts  lib/db.ts  lib/reset.ts  lib/inbound.ts  lib/geo.ts  lib/phone.ts
db/  scripts/  tests/
```
