# CLAUDE.md — Janus server (Track A)

## Who you are working with
Shruti is a design-first Computer Engineering student. **This is her first time doing backend, deployment and agentic work.**
- Explain every step in plain words before doing it: what the command does and why.
- Ask before: deploying, pushing to GitHub, deleting anything, or running database migrations against the live database.
- **Never ask her to paste secrets (API keys, tokens, passwords) into chat.** Tell her exactly which file or Vercel screen to put them in. Secrets live in `.env.local` (git-ignored) and in Vercel Environment Variables. Never commit them.
- Work milestone by milestone (below). Stop at the end of each milestone, show what was built, and tell her how to test it.
- Keep code simple and readable over clever.

## Git rule (strict)
**Never run `git commit` or `git push` yourself, and never add a `Co-Authored-By` line anywhere.** Shruti makes every commit and push herself so the repository shows only her as the author.
- You may run read-only git commands (`git status`, `git diff`, `git log`, `git pull`) and `git init`.
- When a milestone's work is ready to save, stop and give her the exact commands to type, for example:
  ```
  git add .
  git commit -m "M1: ping MCP tool"
  git push
  ```
  Suggest a short commit message; she may change it.
- Before her first commit, help her check `git config user.name` and `git config user.email` are set to her own name and the email on her GitHub account.
- Deploy through Vercel's GitHub integration (Vercel redeploys automatically when she pushes). Do not deploy with the Vercel CLI unless she asks.

## What we are building and why
Team PICT Pune is in Round 3 of The Ken's Case Competition 2026. They are building **Janus**, an AI agent that coordinates household appliance repairs in India: it contacts the household's known technician, notices when he goes silent, checks the bill against price history before the household pays, records what was paid, tracks warranties and AMC servicing, and handles complaints after bad work.

Janus itself runs on **Pine Labs' AgenticOrg platform** (built by the other teammate). This repo is **everything Janus calls**: one Next.js app on Vercel that exposes several **MCP servers** (one per connector) plus one webhook endpoint.

### Competition rules this server must follow
- **Delhivery** must be a mock server using Delhivery's real documented tool/endpoint names and request/response fields exactly.
- **Pine Labs**: real platform connector where one exists; otherwise mock it the same way. The platform already has real `pinelabs_plural` tools (orders, payment links, status, refunds). It does **not** have One-Time Mandate, Fixed Frequency Subscription or Payouts, so we mock those.
- **Up to 3 custom capabilities** that Gnani, Pine Labs or Delhivery don't offer today may live on the mock server. Each must be attributable to one of those partners and the data it already holds.
- **Mocks must behave like real services**: different responses for different inputs, including failures (timeout, insufficient balance, malformed reply, nothing found). Janus must be able to hit every failure.
- **Gnani** is real: register it as a connector and call its real speech-to-text and text-to-speech APIs.
- Everything else (WhatsApp via Twilio, Gmail) is the real tool. Outgoing WhatsApp messages are sent by the platform's own Twilio connector, not by this server. This server only receives incoming WhatsApp messages and forwards them.

## Stack
- **Next.js (App Router) + TypeScript**, deployed on **Vercel** (Hobby plan).
- **MCP**: Vercel's `mcp-handler` package (formerly `@vercel/mcp-adapter`) with `@modelcontextprotocol/sdk`. Use **Streamable HTTP** transport. Do not use SSE unless the platform refuses Streamable HTTP (SSE needs Redis).
- **Database**: Neon Postgres, added from the Vercel dashboard (Storage → Marketplace → Neon), which sets `DATABASE_URL` automatically. Use `@neondatabase/serverless` with plain SQL. Keep schema in `db/schema.sql` and seed data in `db/seed.sql`, plus a `scripts/reset.ts` that drops, recreates and reseeds.
- **Validation**: `zod` for every tool input.
- **Twilio**: `twilio` package only for verifying incoming webhook signatures and downloading media.
- **File hosting for generated audio** (text-to-speech): Vercel Blob.

## Endpoints (each MCP server is registered on AgenticOrg as a separate connector)
| Path | Connector name on AgenticOrg | What it is |
| --- | --- | --- |
| `/janus-core/mcp` | `janus_core_<team>` | Janus's own database + price-fairness logic + scheduler checks + scenario switches |
| `/delhivery/mcp` | `delhivery_janus` | Delhivery Maps mock |
| `/pinelabs/mcp` | `pinelabs_janus` | Pine Labs mock: One-Time Mandate, Fixed Frequency Subscription, Payouts |
| `/custom/mcp` | `janus_custom` | The 3 custom capabilities |
| `/gnani/mcp` | `gnani_janus` | Wrapper around the real Gnani API (only if registering Gnani directly on the platform doesn't produce callable tools) |
| `/api/twilio/inbound` | — (Twilio webhook) | Receives WhatsApp messages from Twilio, converts to clean JSON, forwards to the AgenticOrg workflow webhook |
| `/api/health` | — | Returns `{ok:true}` |

AgenticOrg connector names must be unique across the whole org, so suffix with the team name.

**Auth**: every `/…/mcp` route requires header `x-api-key` equal to env `MCP_API_KEY`. (AgenticOrg's custom connector form supports "Api Key" auth.) Return 401 otherwise.

## Environment variables
`DATABASE_URL` (from Neon), `MCP_API_KEY` (make up a long random string), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `AGENTICORG_WEBHOOK_URL` (from teammate, Track B), `GNANI_API_KEY` (+ any other Gnani credentials its docs require), `BLOB_READ_WRITE_TOKEN` (from Vercel Blob). Put placeholders in `.env.example`.

## Milestones (do them in order; stop after each)

### M1 — Gate 1: one tool, deployed, visible to the platform (deadline Friday 1 PM IST)
1. Check Node and Git are installed. Create the Next.js app in this folder. Initialise git, add `.gitignore` (include `.env*.local`).
2. Add `/janus-core/mcp` with a single tool `ping` → returns `{ok:true, server:"janus_core", time:<ISO>}`. Add the API-key check.
3. Run locally. Test with MCP Inspector (`npx @modelcontextprotocol/inspector`), connecting to `http://localhost:3000/janus-core/mcp` with the header.
4. Walk Shruti through creating a private GitHub repo on github.com, then give her the exact commands to connect it and make her first commit and push herself (see Git rule). Then walk her through importing the repo into Vercel, setting `MCP_API_KEY` in Vercel env, and deploying.
5. Give Shruti the live URL and the exact values to type into AgenticOrg → Connectors → Register Connector: tick **MCP**, Base URL = `https://<project>.vercel.app/janus-core/mcp`, Category = Ops, Auth Type = Api Key, the header name and key.
6. **Stop.** She registers it and confirms the platform discovered `ping`. If the platform can't connect, debug with her (transport, path, auth header) before anything else.

### M2 — Database
Add Neon from Vercel, pull env locally (`vercel env pull .env.local`). Write `db/schema.sql` (tables below), `db/seed.sql` (cast below), `scripts/reset.ts`. Run it. Show her the tables in Neon's dashboard.

### M3 — janus_core tools
Implement every tool in "janus_core tools" below against the database. Every tool returns JSON with `ok:true|false` and, on failure, `error_code` and a plain-English `message`. Redeploy and have her click "Health Check" / re-register so new tools are discovered.

### M4 — Twilio inbound
`/api/twilio/inbound` (POST, `application/x-www-form-urlencoded`):
1. Verify the `X-Twilio-Signature` using `TWILIO_AUTH_TOKEN`. Reject if invalid.
2. Convert to the event JSON below (`From` like `whatsapp:+91…` → `+91…`; `NumMedia`/`MediaUrl0`/`MediaContentType0`; `Latitude`/`Longitude` for shared locations).
3. Store a copy in `inbound_events` (useful for the run log).
4. POST it to `AGENTICORG_WEBHOOK_URL`. Reply to Twilio with empty TwiML (`<Response/>`) immediately so Twilio doesn't retry.
Then tell her where to paste the URL in Twilio: Console → Messaging → Try it out → WhatsApp sandbox settings → "When a message comes in".

Event JSON:
```json
{"channel":"whatsapp","from_phone":"+9198…","text":"…","media_url":null,"media_type":null,"latitude":null,"longitude":null,"received_at":"ISO","twilio_message_sid":"SM…"}
```
Twilio media URLs need Twilio basic auth to download. Gnani tools (M6) must download with `TWILIO_ACCOUNT_SID:TWILIO_AUTH_TOKEN`.

### M5 — Price fairness
`price_fairness_check` in janus_core (see logic below).

### M6 — Gnani
First ask Shruti for Gnani's API documentation link and what credentials she has. **Do not guess Gnani endpoints.** Try registering Gnani directly on AgenticOrg first (custom connector). Only if that gives no callable tools, build `/gnani/mcp` with:
- `gnani_speech_to_text {media_url, language_hint?}` → downloads the Twilio media, sends it to Gnani STT, returns `{text, language_detected, confidence}`. Supported language hints include `mr-IN`, `hi-IN`, `en-IN`, and code-mixed modes if Gnani offers them.
- `gnani_text_to_speech {text, language, voice?}` → calls Gnani TTS, uploads audio to Vercel Blob, returns `{audio_url}`.
Our Round 2 testing found Gnani pushed Marathi toward Hindi and broke on mid-sentence code-switching. Return Gnani's real output and confidence; never "fix" the transcript.

### M7 — Delhivery mock
1. Fetch `https://www.delhivery.com/maps/reference` (and `https://www.delhivery.com/maps/developer`) and copy the exact request and response fields for the tools below.
2. Delhivery's own MCP server exposes these exact tool names; use them unchanged: `validate_address`, `verify_address`, `geocode_address`, `reverse_geocode`, `compute_distance_matrix`, `auto_suggest`.
3. Behaviour must be deterministic and realistic, driven by a small table of known Pune addresses/coordinates in seed data: real-looking corrected addresses, pincodes, coordinates; distance matrix returns durations in seconds and distances in metres computed from coordinates (haversine × 1.3 road factor, motorcycle ~25 km/h in city).
4. Failures: address not found / incomplete (validation verdict "incomplete" with missing fields), unknown coordinates, upstream timeout (simulate with a delay then a 504-shaped error), malformed response. Triggered by input content and by the scenario switch.

### M8 — Pine Labs mock
1. Fetch Pine Labs docs and copy exact names and fields: One-Time Mandate (`https://www.pinelabs.com/docs/online-payments/one-time-mandate`), UPI AutoPay / Fixed Frequency Subscription (`https://www.pinelabs.com/fintech-infrastructure/upi-autopay` and linked docs), Payouts (`https://www.pinelabs.com/online-payments/instant-payouts` and linked docs). If a page is unreachable, tell Shruti and show what you could verify; never invent field names silently. Mark anything unverified in `MOCKS.md`.
2. Tools (rename to match the docs): create mandate, get mandate status, capture/execute mandate, revoke mandate; create subscription, get subscription status; create payout, get payout status; validate beneficiary (name ↔ UPI ID).
3. State lives in the database so status calls reflect earlier calls.
4. Rules: OTM max ₹1,00,000 and 60 days validity; payout fails with `INSUFFICIENT_BALANCE` if the seeded merchant balance is too low; beneficiary name mismatch; duplicate idempotency key returns the original result (never pays twice); timeout; malformed.

### M9 — Custom capabilities (`/custom/mcp`)
Each response includes a `partner` field naming the partner whose data makes it possible.
1. `proof_of_presence {job_id, technician_phone, latitude, longitude, timestamp}` — partner **Delhivery** (billions of delivery GPS pings and geocoded addresses). Compares the technician's shared location and time with the household's geocoded address and the job's scheduled slot. Returns `{present: true|false|unknown, distance_m, minutes_from_slot, reason}`. Failures: no location shared, stale location (>15 min old).
2. `technician_discovery {appliance_type, latitude, longitude, radius_m}` — partner **Delhivery** (POI/business data behind its Autosuggest API). Returns nearby technicians from a seeded directory table with name, phone, skills, distance, source `"delhivery_poi"`. Failures: none found in radius, timeout.
3. `technician_identity_check {name, phone, upi_id?}` — partner **Pine Labs** (KYC it holds on merchants it has onboarded for UPI/QR acceptance). Returns `{status: "verified"|"not_found"|"mismatch", matched_fields, checked_at}`. Failures: not a Pine Labs merchant, name mismatch, timeout.

### M10 — Scenario switches and reset
- Table `scenarios (key, value, uses_left)`. Tools `scenario_set {key, value, uses}` and `scenario_list`, `scenario_clear` in janus_core. Every mock checks this before answering, e.g. `pinelabs.next_payout = "timeout"`, `delhivery.next_matrix = "malformed"`, `custom.next_identity = "mismatch"`. This lets the team trigger any failure on demand during recordings.
- `reset_demo_data` tool (janus_core) and `npm run reset` script: restore seed data.

### M11 — Handoff
Write `TOOLS.md`: every tool on every connector with inputs, outputs, example call, and every failure code. The Track B teammate writes Janus's system prompt from it. Write `MOCKS.md`: for each mocked endpoint, the doc URL it was copied from and anything unverified.

## janus_core tools
All phone numbers in E.164 (`+91…`). All money in whole rupees (integers).
- `get_party_by_phone {phone}` → `{type: "member"|"technician"|"unknown", household_id?, member?, technician?}`
- `onboarding_get {household_id}` / `onboarding_save {household_id, step, data}`
- `household_create {phone, name, language}` / `household_get {household_id}` / `household_update {household_id, fields}`
- `member_add {household_id, phone, name, role: "notified"|"decider"|"both"}`
- `appliance_add` / `appliance_update` / `appliance_list {household_id}`
- `technician_add` / `technician_update` / `technician_list_for_appliance {household_id, appliance_type}` (household's own first, then society log, each with rating summary and price range)
- `society_log_add {society_id, technician, added_by_member_id}` / `society_log_search {society_id, appliance_type}` (merge duplicates by phone)
- `job_create` / `job_get` / `job_update {job_id, fields}` / `jobs_open_for_party {phone}`
- `ledger_get_history {household_id, appliance_type?, technician_id?}`
- `ledger_record_payment {job_id, parts, labour, total, method: "janus"|"direct_cash"|"direct_upi"|"partial", reported_by: "household"|"technician"|"system", confirmed: bool, note?}`
- `rating_save {job_id, on_time, fixed, fair_price, reachable, replaces_rating_id?}`
- `complaint_create` / `complaint_update`
- `notification_log {household_id, member_id?, kind, body}` / `notification_list {household_id}`
- `check_schedule {due_at, job_id?, household_id?, kind, payload}` / `checks_due {now?}` / `check_done {check_id, outcome}`
- `price_fairness_check {household_id, appliance_type, service_type, parts_amount?, labour_amount?, total_amount}`
- `scenario_set` / `scenario_list` / `scenario_clear` / `reset_demo_data`

## Database tables
households, members, societies, appliances (type, brand, model, serial, purchase_date, warranty_end, brand_only, amc_provider, amc_end, amc_visit_every_months, status), technicians (name, phone, skills[], contact_pref, opted_in, availability_status, availability_until, source), household_technicians, society_log, jobs (id, household_id, appliance_id, technician_id, route: local|brand, state, urgent, brand_complaint_no, timestamps: created, contacted, confirmed_slot, arrived, done), price_ledger, ratings, complaints, notifications, checks, reference_prices (appliance_type, service_type, city, parts_min, parts_max, labour_min, labour_max, source, as_of), inflation_buffers (kind: parts|labour, annual_pct — placeholder values, clearly labelled), technician_directory (for discovery), pine_merchants (for identity check), mock_mandates, mock_subscriptions, mock_payouts, merchant_balance, scenarios, inbound_events.

## Price fairness logic
1. Tier 3 (preferred): household's own history for the same appliance_type + service_type, adjusted forward by the inflation buffer for the years elapsed. Tier 2: same society/area average (only if ≥3 data points; never reveal individual households). Tier 1: reference_prices.
2. Compare parts and labour separately when given, each with its own buffer.
3. Return `{verdict: "fair"|"slightly_high"|"high"|"low"|"insufficient_data", tier_used, expected_min, expected_max, last_paid?, last_paid_date?, difference_pct, explanation_en}`. "slightly_high" = up to 15% above expected_max; "high" = more.
4. Never include neighbour names or individual neighbour amounts.

## Seed data (demo cast) — Shruti will give the real phone numbers; use placeholders until then
- Society: Sai Heights, Baner, Pune 411045.
- Household: **Priya** (decider, language mixed Marathi/Hindi/English), Flat 4B; husband **Rohan** (decider). Availability window: weekdays 4–8 PM, weekends 10 AM–6 PM. Grantex/spend limit ₹5,000.
- Appliances: Split AC (brand Voltas, bought 2021, out of warranty); RO purifier (Kent, AMC with Suresh, visit every 3 months, next due in 2 days); Washing machine (LG, bought 2025, under warranty, brand_only = true); Fridge (Whirlpool, out of warranty).
- Technicians: **Ramesh** (AC + fridge, known to Priya, prefers text, opted in, past jobs: AC gas refill ₹600 in Apr 2025, on time; fridge wire repair ₹350); **Suresh** (RO, society log + AMC); **Anil** (AC, society log, one unresolved dispute elsewhere); 3 entries in technician_directory near Baner for discovery.
- Reference prices (labelled "reference data, team-collected"; teammate will send the full list): AC gas refill ₹700–850 Pune; AC PCB/motherboard ₹3,500–4,500 parts; fridge gas refill ₹800–1,000; RO filter set ₹1,200–1,800.
- Merchant balance for payouts: ₹2,000 (so a ₹2,500 payout fails with insufficient balance).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
