**yes** |**yes** |**yes** |# Janus tools — the contract between Track A (server) and Track B (Janus prompt)

Tool names, inputs and outputs below are generated from the live server, so they match exactly what AgenticOrg discovers.
If a name here differs from the prompt, the prompt is wrong.

## Status

> **Register only ONE connector on AgenticOrg: `janus_pict` → `https://janus-server.vercel.app/janus/mcp` (all 64 tools).** On the platform every tool is then named `mcp_janus_pict__<tool>`, e.g. `mcp_janus_pict__get_party_by_phone`, `mcp_janus_pict__validate_address`, `mcp_janus_pict__send_whatsapp`. Reason: AgenticOrg validates an agent's MCP tools against a single connector's catalogue, so two or more MCP connectors can't be attached together. The per-group routes below still exist for testing; the tables further down are grouped by them, but the tool names, inputs and answers are identical on `/janus/mcp`. Don't attach `ping`, `scenario_set`, `scenario_list`, `scenario_clear` or `reset_demo_data` to Janus (testers call them directly).

Per-group routes (all live and tested; 268 checks) (204 checks on the live server, 3 Oct 2026). Base URL `https://janus-server.vercel.app`.

| Connector on AgenticOrg (register as) | What | Tools |
| --- | --- | --- |
| `mcp_janus_core_pict` (`janus_core_pict`) | Janus's database: people, appliances, technicians, jobs, payments, ratings, complaints, follow-up checks, price fairness, failure switches, demo reset + the WhatsApp inbox (`inbound_pending`, `inbound_mark_done`) | 37 |
| `mcp_gnani_janus_pict` (`gnani_janus_pict`) | **Real** Gnani speech-to-text (WhatsApp voice notes) and text-to-speech (voice replies) | 2 |
| `mcp_delhivery_janus_pict` (`delhivery_janus_pict`) | Delhivery Maps **mock**: validate / verify / geocode / reverse-geocode addresses, distance matrix, autosuggest. Delhivery's exact response bodies (not our `{ok}` shape) | 6 |
| `mcp_pinelabs_janus_pict` (`pinelabs_janus_pict`) | Pine Labs **mock**: One-Time Mandate, UPI AutoPay subscriptions, Payouts. Pine Labs' exact bodies; **amounts in paise** | 13 |
| `mcp_janus_custom_pict` (`janus_custom_pict`) | Custom capabilities: `proof_of_presence` and `technician_discovery` (partner Delhivery), `technician_identity_check` (partner Pine Labs). Our `{ok}` format plus a `partner` field | 3 |
| `mcp_whatsapp_janus_pict` (`whatsapp_janus_pict`) | **Real** Twilio: `send_whatsapp`, `make_call` (AI-disclosed), `get_message_status`. Only to known members / technicians. Our `{ok}` format | 3 |
| Twilio webhook `/api/twilio/inbound` | Incoming WhatsApp → saved in Janus's inbox (read it with `inbound_pending`); a copy is also emailed to janus.pict.demo@gmail.com | — |

When new tools are added to a connector, AgenticOrg only sees them after the connector is archived and registered again (same name).

**Every call is logged on the server** (time, connector, tool, inputs, result), and resets don't erase the log. To check whether Janus really called a tool during a test, tell Track A the time; they run `npm run calls` and see within seconds.

## Conventions (all tools)

- **Every answer is JSON.** Success: `{"ok": true, ...}`. Failure: `{"ok": false, "error_code": "JOB_NOT_FOUND", "message": "No job with id \"job_x\"."}` — some failures add extra fields (listed under Error codes). Janus should read `ok` first, never assume success.
- **Bad input** (missing field, wrong type, unknown key, bad date) → `error_code: "INVALID_INPUT"` with a message naming the field.
- **Exception: partner mocks (Delhivery and Pine Labs)** answer with the partner's **real** response body, not `{ok: …}`. Success = the documented JSON. Failure = the tool result is flagged as an error and its text starts with `HTTP <status>:` followed by the partner's error body (e.g. `HTTP 504: {"detail": "Upstream service 'matrix' timed out"}`). A "malformed" reply is broken JSON that can't be parsed; Janus should treat it like an error and retry or fall back.
- **Phone numbers**: E.164 (`+918530921384`). Tools also accept `9000000001`, `+91 90000 00001`, `whatsapp:+918530921384` and always return the normalised form.
- **Money**: whole rupees, integers (`650`, not `"₹650"` or `650.00`).
- **Ids** are readable strings with a prefix: `hh_` household, `mem_` member, `app_` appliance, `tech_` technician, `job_`, `pay_`, `rate_`, `cmp_` complaint, `chk_` check, `ntf_` notification, `soc_` society.
- **Times** come back as ISO in UTC (`2026-10-03T11:30:00.000Z` = 5:00 PM IST). Send times as ISO **with offset**, e.g. `2026-10-03T17:00:00+05:30`. Dates are `YYYY-MM-DD`. "Today" (warranty, AMC due) is worked out in India time.
- **Update tools** (`*_update`) take `fields`: only the keys you pass are changed; unknown keys are rejected.

## Job states

The server stores whatever state Janus sets (it does not enforce the order). Suggested flow:

`new` → `contacting` → `slot_confirmed` → `in_progress` → `awaiting_payment` → `paid` → `closed`

Side states: `technician_silent` (no reply in time), `escalated` (complaint / dispute), `cancelled`.

| State | Meaning | Timestamp stamped automatically by `job_update` |
| --- | --- | --- |
| `new` | Job opened, nobody contacted yet | `created_at` (on create) |
| `contacting` | Janus has messaged the technician / brand | `contacted_at` |
| `technician_silent` | Technician did not reply in time | — |
| `slot_confirmed` | Visit time agreed (`confirmed_slot`) | `slot_confirmed_at` |
| `in_progress` | Technician arrived / working | `arrived_at` |
| `awaiting_payment` | Work done, bill to settle | `done_at` |
| `paid` | Payment recorded | — |
| `closed` | Finished (rating asked) | — |
| `escalated` | Complaint or dispute open | — |
| `cancelled` | Not going ahead | — |

If your eval cases use other words: requested → `new`, assigned → `contacting` / `slot_confirmed`, completed → `awaiting_payment` → `paid` → `closed`.

`route` is `local` (neighbourhood technician) or `brand` (brand service centre — required for `brand_only` appliances; `job_create` returns a warning otherwise).

## Error codes

| error_code | When | Extra fields |
| --- | --- | --- |
| `INVALID_INPUT` | Input doesn't match the tool's schema | — |
| `INVALID_PHONE` | Phone can't be understood | — |
| `HOUSEHOLD_NOT_FOUND`, `MEMBER_NOT_FOUND`, `APPLIANCE_NOT_FOUND`, `TECHNICIAN_NOT_FOUND`, `JOB_NOT_FOUND`, `RATING_NOT_FOUND`, `COMPLAINT_NOT_FOUND`, `CHECK_NOT_FOUND`, `SOCIETY_NOT_FOUND` | Id doesn't exist | — |
| `PHONE_ALREADY_REGISTERED` | `household_create` / `member_add` with a phone that is already a member | `household_id`, `member_id` |
| `APPLIANCE_NOT_IN_HOUSEHOLD` | `job_create` with another household's appliance | — |
| `MEMBER_NOT_IN_HOUSEHOLD` | `notification_log` with another household's member | — |
| `NO_FIELDS` | `*_update` with empty `fields` | — |
| `TOTAL_MISMATCH` | `ledger_record_payment`: parts + labour ≠ total | — |
| `MISSING_APPLIANCE_TYPE`, `MISSING_SERVICE_TYPE` | `ledger_record_payment` on a job without appliance / service_type — pass them explicitly | — |
| `MISSING_HOUSEHOLD` | `complaint_create` / `check_schedule` with neither job_id nor household_id | — |
| `RATING_ALREADY_EXISTS` | `rating_save` on an already-rated job | `existing_rating_id` (pass it as `replaces_rating_id` to correct) |
| `RATING_JOB_MISMATCH` | `replaces_rating_id` belongs to another job | — |
| `INVALID_DUE_TIME` | `check_schedule` needs exactly one of `due_at` / `due_in_minutes` | — |
| `CHECK_NOT_PENDING` | `check_done` on a check already done/cancelled | `check` |
| `INVALID_REFERENCE`, `DUPLICATE`, `INVALID_VALUE` | Database refused the value (e.g. unknown technician id inside `fields`) | — |
| `INTERNAL_ERROR` | Bug on our side — tell Track A | — |

## How `price_fairness_check` decides

1. **Where "expected" comes from** (first that has data wins → `tier_used`):
   - `household_history`: this household's confirmed past payments for the same appliance + service, grown forward by the inflation buffer (parts 6%/yr, labour 8%/yr, compounded; placeholder rates). No parts/labour split → the higher rate.
   - `society_average`: other households in the same society, only with **3+ payments**. Range = average ± 15%. Never names a household or shows one household's amount.
   - `reference_prices`: the reference table (see Demo data).
2. **Verdict**: above `expected_max` by up to 15% → `slightly_high`; more → `high`; more than 25% below `expected_min` → `low` (suspiciously cheap); otherwise `fair`. No data → `insufficient_data` (with `known_service_types`).
3. **Parts and labour** are judged separately when given; the worst one decides (`compared`), naming parts/labour over the total on a tie.
4. **Wrong job type**: if a high bill fits another job's reference range, `alternative_service_types` lists it. Janus should ask which job was done (e.g. a ₹1,500 "top-up" may really be a full gas charge) before calling it a rip-off.
5. `explanation_en` is safe to paraphrase to the household in their language.

6. Reference prices carry a note (e.g. "Starting price", "GST extra"); it is added to `explanation_en` and returned as `context.reference_note`. Elapsed time for price rises is counted in whole months.

Worked examples (demo data): AC `gas_top_up` ₹650 → fair (Priya paid ₹600 in Apr 2025 ≈ ₹669 today); ₹900 → high (+35%); ₹1,500 → high + hint `full_gas_charge`; AC `full_gas_charge` ₹2,000 → fair (reference); AC `pcb_replacement` ₹7,500 → high (+67%); RO `filter_replacement` ₹1,500 → fair (society average); fridge `gas_refill` ₹550 → low; geyser heating element → insufficient_data.

## Voice notes with Gnani

- **Incoming voice note**: the WhatsApp event has `media_url` and `media_type` (e.g. `audio/ogg`). Call `gnani_speech_to_text {media_url, language_hint}` with the **household's language**. Tested on the same Marathi clip: `mr-IN` → "नमस्कार प्रिया रमेश उद्या संध्याकाळी पाच वाजता येई" (near perfect); `hi-IN` → "…संध्याकाली पाच वाजता ही।" (pushed toward Hindi). So the hint matters.
- The transcript is Gnani's real output, never corrected. Gnani returns no detected language or confidence (both `null`), so if the text looks wrong or `empty` is true, Janus should ask the household to confirm or type.
- **Voice reply**: `gnani_text_to_speech {text, language}` returns `audio_url`; send it as media with the Twilio connector. Languages: mr-IN, hi-IN, en-IN, `hi-en` (Hinglish), `auto`, and other Indian languages. Default voices: Zahira (Marathi), Nalini (Hindi), Kaveri (English), Poorvi (Hinglish).
- Limits: audio up to 60 seconds; text up to 1,000 characters. Gnani rate-limits bursts (`GNANI_RATE_LIMITED`); wait a few seconds and retry.
- Errors: `GNANI_TIMEOUT`, `GNANI_RATE_LIMITED`, `GNANI_AUTH_FAILED`, `GNANI_ERROR`, `GNANI_MALFORMED_RESPONSE`, `GNANI_UNREACHABLE`, `MEDIA_DOWNLOAD_FAILED`, `UNSUPPORTED_MEDIA_TYPE` (e.g. a photo), `MEDIA_TOO_LARGE`, `INVALID_MEDIA_URL`, `INVALID_VOICE` (+ `voices_for_language`).

## Paying with Pine Labs (mock)

**All Pine Labs amounts are in paise**: ₹2,500 → `{"value": 250000, "currency": "INR"}`. janus_core tools use whole rupees, so multiply by 100 going in and divide coming out.

**One-Time Mandate** (block money before the job, debit once after):
1. `create_ot_subscription {merchant_subscription_reference, customer_id: "cust-v1-250901101500-aa-PRIYA1", plan_details: {amount: 250000, currency: "INR", validity_days: 30}}` → `subscription_id`, `order_id`, status `CREATED`. Max ₹1,00,000 and 60 days.
2. `create_mandate_payment {order_id, payments: [{merchant_payment_reference, payment_method: "UPI", payment_amount: {value: 250000, currency: "INR"}, payment_option: {upi_details: {txn_mode: "INTENT"}}, mandate_info: {request_type: "CREATE_MANDATE"}}]}` → Priya approves (instant in the mock) → `AUTHORIZED`; mandate becomes `ACTIVE`. The amount must equal the mandate amount.
3. After the job: `create_presentation {subscription_id, amount: {value: 220000, currency: "INR"}, merchant_presentation_reference}` debits the real bill (≤ the mandate). Then the mandate is `COMPLETED`; it can't be debited again.
4. Not needed? `cancel_subscription {subscription_id}` revokes it.

**UPI AutoPay** (e.g. Suresh's quarterly RO AMC): `create_subscription {plan_id: "v1-pla-250901101600-aa-ROAMC1", customer_id, start_date, end_date, integration_mode: "SEAMLESS", merchant_subscription_reference}` → `create_mandate_payment` with its `order_id` and `order_amount.value` (50000) → `ACTIVE` → `create_presentation` each quarter.

**Payouts** (paying the technician): `create_payout {clientReferenceId, payeeName: "Ramesh Patil", vpa: "ramesh.cooling@okaxis", amount: {value: 120000, currency: "INR"}, mode: "UPI", remarks: "AC repair"}`. Check with `get_payouts {clientReferenceId}` and `get_payout_balance`.
- The funding account starts at **₹2,000**. A bigger payout is accepted as **`PENDING`** with message "Funding account has insufficient balance" and **nothing is paid**. Janus should tell the household the payout is on hold, not that it failed or succeeded.
- Reusing a `clientReferenceId` or `merchant_*_reference` returns `DUPLICATE_REQUEST`: nothing is paid twice. Use a fresh reference per new payment, e.g. based on the job id.

**Is this technician who he says he is (name ↔ UPI ID)?** Pine Labs has no such API. Use the custom capability `technician_identity_check` on `mcp_janus_custom_pict` (see below).

## Custom capabilities (partner data Janus can use)

- **Is the technician really here?** When he shares his WhatsApp location, call `proof_of_presence {job_id, technician_phone, latitude, longitude, timestamp: received_at}` → `present` true (within 200 m) / false / "unknown" (no location, older than 15 min, or not this job's technician), with `distance_m` and `minutes_from_slot`. Use it before marking the job `in_progress` or when the household says he never came.
- **Nobody available?** `technician_discovery {appliance_type, latitude, longitude, radius_m}` lists nearby businesses (from Delhivery POI data) with phone, rating, distance and ETA. From Priya's home: AC → Shree Sai Cooling (1.2 km, ~4 min), Om Electricals (2.7 km).
- **Is he who he says?** `technician_identity_check {name, phone, upi_id?}` → `verified` / `mismatch` (registered name shown masked) / `not_found`. Check before paying a technician the household doesn't know. Demo: Ramesh and Suresh verify; Santosh's number is registered to someone else (mismatch); Anil isn't a Pine Labs merchant (not_found).

## Receiving WhatsApp messages (Janus's inbox)

AgenticOrg's Gmail "Email Received" trigger needs an org admin (`Missing scope: agenticorg:admin`), so Janus **checks its inbox on a schedule** instead of being woken by email. Every incoming WhatsApp message is stored by the server the moment it arrives.

**Each scheduled run (e.g. every minute):**
1. `inbound_pending {limit: 5}` → the oldest new messages, each with `event_id`, `text`, `media_url`/`media_type` (voice note → `gnani_speech_to_text`), `latitude`/`longitude` (shared location → `proof_of_presence`), and **`party`**: who sent it, already looked up (member with `household_id` and `language`, technician with `technician_id`, or `unknown`). No need to call `get_party_by_phone` first.
2. Handle each message (reply with `send_whatsapp`, create/update jobs, …).
3. `inbound_mark_done {event_id, outcome}` for each, with one line on what was done (e.g. "replied; job job_… created").
4. Also call `checks_due` in the same run (technician-silent follow-ups, AMC reminders).

Guarantees: `inbound_pending` **claims** what it returns, so an overlapping run never gets the same message. If a run dies before marking a message done, it comes back after **5 minutes** (with `attempt: 2`), so nothing is lost; check `attempt` > 1 to avoid repeating a reply that may already have been sent. Marking done twice is harmless. An empty list means nothing new.

## Sending WhatsApp messages and calls

AgenticOrg's native Twilio connector failed its connection test, so Janus sends through `mcp_whatsapp_janus_pict` (real Twilio, sandbox +1 415 523 8886).
- `send_whatsapp {to, body?, media_url?}` → `message_sid`, `status` (usually `queued`). Body max 1,600 characters; media_url must be public https (e.g. a `gnani_text_to_speech` `audio_url` for a voice reply).
- **Guard:** only phones that are a household member or technician in janus_core; anyone else → `RECIPIENT_UNKNOWN`. Add a technician found by discovery with `technician_add` first.
- If WhatsApp rejects the message within a few seconds you get the reason instead of "queued": `NOT_JOINED_SANDBOX` (they must send the join code to +1 415 523 8886), `OUTSIDE_24H_WINDOW` (no message from them in 24 h → use Gmail).
- `get_message_status {message_sid}` → queued / sent / delivered / read / failed / undelivered (+ `error_hint`). Confirm delivery before telling someone "sent". After `TWILIO_TIMEOUT`, check status before resending; the tool never resends by itself.
- `make_call {to, message, language: "en-IN" | "hi-IN"}` → one voice call that always begins "Hello, this is Janus, an AI assistant." Returns `NO_VOICE_NUMBER` if the Twilio account has no voice number configured.
- Errors: RECIPIENT_UNKNOWN, INVALID_INPUT, INVALID_PHONE, NOT_JOINED_SANDBOX, OUTSIDE_24H_WINDOW, TWILIO_AUTH_FAILED (tell Track A), TWILIO_RATE_LIMITED (wait and retry), TWILIO_TIMEOUT, TWILIO_ERROR (+ `twilio_code`, `twilio_message`), NO_VOICE_NUMBER, MESSAGE_NOT_FOUND.

## Demo data (after a reset)

Real phones: **Priya = Shruti** (+918530921384), **Ramesh = Aarya** (+918369502720), **Suresh = Gayatri** (+918308407020). Rohan and Anil are still **placeholders** (+9190000000xx); ids stay the same.

**Society** `soc_sai_heights` — Sai Heights, Baner, Pune 411045.

**Household** `hh_priya` — "Priya & Rohan", Flat 4B. Language `mr-hi-en` (mixed Marathi/Hindi/English). Spend limit (Grantex) ₹5,000. Home: weekdays 4–8 PM, weekends 10 AM–6 PM (IST).

| Member | Id | Phone | Role |
| --- | --- | --- | --- |
| Priya | `mem_priya` | +918530921384 | decider |
| Rohan (husband) | `mem_rohan` | +919000000002 | decider |

**Appliances** (4)

| Id | Appliance | Bought | Warranty end | Notes |
| --- | --- | --- | --- | --- |
| `app_priya_ac` | Voltas split AC 1.5 t | 2021-04-20 | 2022-04-20 | Out of warranty |
| `app_priya_ro` | Kent Grand Plus RO | 2022-08-02 | 2023-08-02 | AMC with Suresh, visit every 3 months, **next visit due 2 days after reset**, AMC ends ~6 months after reset |
| `app_priya_wm` | LG 8 kg front-load washing machine | 2025-03-15 | 2027-03-15 | Under warranty, `brand_only: true` → must go to LG |
| `app_priya_fridge` | Whirlpool double-door fridge | 2017-06-10 | 2018-06-10 | Out of warranty |

**Technicians**

| Id | Name | Phone | Fixes | Contact | Opted in | Where from |
| --- | --- | --- | --- | --- | --- | --- |
| `tech_ramesh` | Ramesh Patil | +918369502720 | AC, fridge | text | yes | Priya's own technician (also recommended in society) |
| `tech_suresh` | Suresh More | +918308407020 | RO | voice note | yes | Priya's RO AMC + society log (2 recommendations) |
| `tech_anil` | Anil Kale | +919000000013 | AC | call | no | Society log; **1 open complaint** from another flat (gas top-up failed again, not answering) |

**Past jobs and prices (Priya)**

| Job | What | Technician | Paid | When | Rating |
| --- | --- | --- | --- | --- | --- |
| `job_priya_ac_gas_2025` | AC gas top-up (`gas_top_up`) | Ramesh | ₹600 (UPI) | 12 Apr 2025 | on time, fixed, fair, reachable |
| `job_priya_fridge_wire` | Fridge wiring repair | Ramesh | ₹350 (₹100 parts + ₹250 labour, cash) | 8 Nov 2025 | on time, fixed, fair, reachable |

Neighbours (3 other flats, never named to Priya) add AC gas top-up payments of ₹750 / ₹800 / ₹900 and RO filter payments of ₹1,350 / ₹1,500 / ₹1,650 — enough for the society-average price tier.

**Service types matter for prices.** An AC **gas top-up** by a local technician (`gas_top_up`) and a **full gas charge** (`full_gas_charge`) are different jobs. Janus must pick the right one when opening a job or recording a bill, or an honest ₹1,500 full charge will look like a rip-off against top-up prices. Use these exact `service_type` names (the price check only finds prices for exact names; `appliance_type` is `ac`, `ro_purifier`, `fridge`, `washing_machine`, `geyser`, `tv`).

**Reference prices** (Pune; team-collected S1 list, every row traceable in `db/reference_prices_sources.csv`). Whole job unless marked *parts*.

| Appliance | service_type | Range | Source | Note |
| --- | --- | --- | --- | --- |
| AC | `gas_top_up` | ₹700–900 | Household interview ₹900; **₹700 is a placeholder** | Local top-up, not full charging; to be replaced from technician calls |
| AC | `full_gas_charge` | ₹1,500–2,800 | LG ₹1,500 (R22), ₹2,750 (inverter); Urban Company ₹2,800 | GST extra on LG |
| AC | `pcb_replacement` | ₹1,500–4,500 | Urban Company non-inverter ₹1,500, inverter ₹4,500; interview ₹4,000 | A ₹7,500 quote was reported as overcharging |
| AC | `capacitor_replacement` | ₹599–749 | Urban Company | |
| AC | `visit_checkup` | ₹299–750 | Urban Company ₹299; LG ₹750 | Parts extra |
| AC | `general_service` | ₹549–649 | Urban Company | Starting prices |
| RO | `filter_replacement` | ₹1,300–1,825 *parts* | Kent: sediment ₹650, carbon ₹650, post-carbon ₹525 | 2–3 filter set |
| RO | `complete_filter_replacement` | ₹4,199 | Urban Company | Native spares, 1-yr warranty |
| RO | `membrane_replacement` | ₹3,100–3,675 *parts* | Kent | |
| RO | `uf_membrane_replacement` | ₹1,225 *parts* | Kent | |
| RO | `visit_checkup` | ₹299–550 | Urban Company ₹299; Kent ₹350; LG ₹550 | |
| RO | `amc_annual` | ₹2,000 | Kent non-comprehensive AMC | Confirm Grand Plus is in this range |
| Fridge | `gas_refill` | ₹850–1,800 | LG ₹850; NoBroker ₹1,400 (single door), ₹1,800 (double door) | |
| Fridge | `compressor_replacement` | ₹5,350–5,800 | NoBroker | Incl. relay, OLP, capacitor |
| Fridge | `thermostat_replacement` | ₹690–780 | NoBroker | |
| Fridge | `visit_checkup` | ₹199–800 | Urban Company / NoBroker ₹199; LG ₹650–800 | |
| Fridge | `wiring_repair` | — | (only Priya's own history) | |
| Washing machine | `drain_motor_replacement` | ₹1,300–2,150 | NoBroker | Starting prices |
| Washing machine | `pcb_replacement` | ₹1,575–2,600 | NoBroker (top load / front load) | Starting prices |
| Washing machine | `main_motor_replacement` | ₹1,950 | NoBroker | Starting price |
| Washing machine | `general_service` | ₹1,099 | Urban Company | Starting price |
| Washing machine | `visit_checkup` | ₹199–750 | Urban Company; LG | |
| Geyser | `visit_checkup` / `general_service` | ₹249 / ₹599 | Urban Company | Heating element & thermostat: not found online yet |
| TV | `general_repair` | ₹300 | Household interview | Single figure |

**Scheduled** `chk_priya_ro_amc` — reminder due the day after reset, 10:00 IST, about Suresh's RO visit.

**Pine Labs (mock)**: payout balance ₹2,000 (a ₹2,500 payout is held as `PENDING`, insufficient balance); Priya is customer `cust-v1-250901101500-aa-PRIYA1`; UPI AutoPay plan `v1-pla-250901101600-aa-ROAMC1` = Kent RO AMC, ₹500 every quarter.

## How to trigger failures in tests

**Available now** — through inputs:

| To test | Do this | Expect |
| --- | --- | --- |
| Unknown sender | `get_party_by_phone {phone: "+919999999999"}` | `type: "unknown"` |
| Wrong ids | any `*_get` with a made-up id | `*_NOT_FOUND` |
| Bill doesn't add up | `ledger_record_payment` with parts + labour ≠ total | `TOTAL_MISMATCH` |
| Double rating | `rating_save` twice on one job | `RATING_ALREADY_EXISTS` |
| Warranty trap | `job_create` for `app_priya_wm` with route `local` | ok, plus a warning |
| Technician away | `technician_update {technician_id: "tech_ramesh", fields: {availability_status: "away", availability_until: "…"}}` | his availability shows in lists and `job_get` |

**Technician silent** — this is Janus's own logic, not a mock switch, and can be tested now without waiting:
1. `job_create` → `job_update {state: "contacting"}` (stamps `contacted_at`).
2. `check_schedule {kind: "technician_reply", job_id, due_in_minutes: 120}`.
3. Pretend time has passed: `checks_due {now: "<a time 3 hours later, ISO with +05:30>"}` — the check is returned with `job_state: "contacting"`.
4. Janus sees no reply → `job_update {state: "technician_silent"}`, tells the household, tries the next technician, then `check_done`.

**Mock failures (failure switches)** — live in janus_core. Set a switch, then the next call(s) of that mock fail the way you chose:

- `scenario_set {key: "pinelabs.next_payout", value: "timeout", uses: 1}` → the next payout times out. `uses: 2` → the next two calls; `uses: 0` → every call until cleared.
- `scenario_list` shows what's switched on (`uses_left`, null = until cleared) and the full catalogue. `scenario_clear {key}` turns one off; `scenario_clear {}` turns all off. A reset also clears them.
- Unknown keys or values are rejected (`UNKNOWN_SCENARIO`, `INVALID_SCENARIO_VALUE`) with the list of valid ones, so typos can't silently do nothing.
- A `timeout` waits about 6 seconds, then returns a 504-style error (under AgenticOrg's 10-second tool limit).

| Key | Values | Affects | Mock built? |
| --- | --- | --- | --- |
| `delhivery.next_validate` | incomplete, not_found, timeout, malformed | validate_address / verify_address | **yes** |
| `delhivery.next_geocode` | not_found, timeout, malformed | geocode_address | **yes** |
| `delhivery.next_reverse_geocode` | unknown_coordinates, timeout, malformed | reverse_geocode | **yes** |
| `delhivery.next_matrix` | unknown_coordinates, timeout, malformed | compute_distance_matrix | **yes** |
| `delhivery.next_autosuggest` | not_found, timeout, malformed | auto_suggest | **yes** |
| `pinelabs.next_mandate` | declined, limit_exceeded, timeout, malformed | One-Time Mandate (`declined` hits `create_mandate_payment`; the others hit `create_ot_subscription`) | **yes** |
| `pinelabs.next_subscription` | declined, timeout, malformed | UPI AutoPay (`declined` hits `create_mandate_payment`; the others hit `create_subscription`) | **yes** |
| `pinelabs.next_payout` | insufficient_balance, failed, timeout, malformed | `create_payout` | **yes** |
| `custom.next_presence` | not_present, no_location, stale_location, timeout | proof_of_presence | **yes** |
| `custom.next_discovery` | none_found, timeout | technician_discovery | **yes** |
| `custom.next_identity` | verified, not_found, mismatch, timeout | technician_identity_check | **yes** |
| `whatsapp.next_send` | timeout, not_joined, outside_window, failed | send_whatsapp (answers without calling Twilio) | **yes** |
| `gnani.next_stt` | timeout, malformed, low_confidence | gnani_speech_to_text | **yes** |
| `gnani.next_tts` | timeout, malformed | gnani_text_to_speech | **yes** |

The switches exist now; each mock starts obeying its keys when that milestone is built. Mocks also fail on their own for realistic inputs (unknown address, ₹2,500 payout vs ₹2,000 balance, …) without any switch.

**Reset to the demo state**: `reset_demo_data {confirm: "RESET"}` (about 1 second). Wipes every job, payment, message and switch and restores the cast. For testers before an eval run or recording only, never inside a household conversation. Track A can also run `npm run reset`.

<!-- TOOLS:START (generated by `npm run docs:tools`, do not edit by hand) -->

## Connector `mcp_janus_core_pict` — 37 tools

URL: `https://janus-server.vercel.app/janus-core/mcp` (server name `janus_core`)

### `ping`

Health check for the janus_core connector. Returns ok:true and the server time.

_No inputs._

**Returns** (besides `ok: true`): `server`, `time`

Example:
```json
{"tool":"ping","arguments":{}}
```

### `get_party_by_phone`

Who is this phone number? Returns type 'member' (with household), 'technician', or 'unknown'. Call this first for every incoming message.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `phone` | string | yes | Phone number, E.164 preferred (+919876543210). Also accepts spaces/dashes, a 10-digit Indian number or a 'whatsapp:' prefix. |

**Returns** (besides `ok: true`): `type` ('member'|'technician'|'unknown'), `phone` (normalised); member → `household_id`, `member`, `household` {name, flat, language, spend_limit, onboarding_step, open_jobs}; technician → `technician` (+ open_jobs)

Example:
```json
{"tool":"get_party_by_phone","arguments":{"phone":"+919000000001"}}
```

### `household_create`

Create a new household and its first member (role 'both'). `name` is the person's name; it is also used as the household name unless household_name is given.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `phone` | string | yes | Phone number, E.164 preferred (+919876543210). Also accepts spaces/dashes, a 10-digit Indian number or a 'whatsapp:' prefix. |
| `name` | string | yes |  |
| `language` | string | yes | e.g. 'en', 'hi', 'mr', or mixed like 'mr-hi-en' |
| `household_name` | string | no |  |
| `society_id` | string | no |  |
| `flat` | string | no |  |
| `address` | string | no |  |

**Returns** (besides `ok: true`): `household`, `member`

Example:
```json
{"tool":"household_create","arguments":{"phone":"+919811122233","name":"Asha","language":"hi-en","society_id":"soc_sai_heights","flat":"1A"}}
```

### `household_get`

Everything about a household: details, society, members, appliances and the technicians it already knows.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `household_id` | string | yes |  |

**Returns** (besides `ok: true`): `household`, `society`, `members[]`, `appliances[]` (summary), `technicians[]` (household's own)

Example:
```json
{"tool":"household_get","arguments":{"household_id":"hh_priya"}}
```

### `household_update`

Change household details. Only the fields you pass are changed.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `household_id` | string | yes |  |
| `fields` | object | yes | Pass only the keys you want to change. |
| `fields.name` | string | no |  |
| `fields.flat` | string | no |  |
| `fields.address` | string | no |  |
| `fields.latitude` | number | no |  |
| `fields.longitude` | number | no |  |
| `fields.primary_phone` | string | no | Phone number, E.164 preferred (+919876543210). Also accepts spaces/dashes, a 10-digit Indian number or a 'whatsapp:' prefix. |
| `fields.language` | string | no |  |
| `fields.availability` | object | no | When someone is home, e.g. {"tz":"Asia/Kolkata","weekdays":[{"from":"16:00","to":"20:00"}],"weekends":[{"from":"10:00","to":"18:00"}]} |
| `fields.spend_limit` | integer | no | Rupees Janus may approve without asking |
| `fields.society_id` | string | no |  |

**Returns** (besides `ok: true`): `household`

Example:
```json
{"tool":"household_update","arguments":{"household_id":"hh_priya","fields":{"spend_limit":6000}}}
```

### `member_add`

Add a family member to a household. role: 'notified' (kept informed), 'decider' (approves spending) or 'both'.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `household_id` | string | yes |  |
| `phone` | string | yes | Phone number, E.164 preferred (+919876543210). Also accepts spaces/dashes, a 10-digit Indian number or a 'whatsapp:' prefix. |
| `name` | string | yes |  |
| `role` | `"notified"` \| `"decider"` \| `"both"` | yes |  |
| `language` | string | no |  |

**Returns** (besides `ok: true`): `member`

Example:
```json
{"tool":"member_add","arguments":{"household_id":"hh_priya","phone":"+919000000003","name":"Aai","role":"notified"}}
```

### `onboarding_get`

Where a household is in onboarding: current step and everything collected so far.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `household_id` | string | yes |  |

**Returns** (besides `ok: true`): `household_id`, `step`, `data`

Example:
```json
{"tool":"onboarding_get","arguments":{"household_id":"hh_priya"}}
```

### `onboarding_save`

Save onboarding progress. Sets the current step and MERGES `data` into what was saved before (existing keys are overwritten). Use step 'done' when finished.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `household_id` | string | yes |  |
| `step` | string | yes |  |
| `data` | object | no | default `{}` |

**Returns** (besides `ok: true`): `household_id`, `step`, `data` (merged)

Example:
```json
{"tool":"onboarding_save","arguments":{"household_id":"hh_priya","step":"appliances","data":{"has_ac":true}}}
```

### `appliance_add`

Add an appliance to a household. Dates are YYYY-MM-DD.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `household_id` | string | yes |  |
| `type` | string | yes | 'ac', 'fridge', 'ro_purifier', 'washing_machine', … |
| `brand` | string | no |  |
| `model` | string | no |  |
| `serial` | string | no |  |
| `purchase_date` | date (YYYY-MM-DD) | no |  |
| `warranty_end` | date (YYYY-MM-DD) | no |  |
| `brand_only` | boolean | no | true = repairs must go through the brand's service centre (e.g. under warranty); default `false` |
| `amc_provider` | string | no |  |
| `amc_technician_id` | string | no |  |
| `amc_end` | date (YYYY-MM-DD) | no |  |
| `amc_visit_every_months` | integer | no |  |
| `amc_next_due` | date (YYYY-MM-DD) | no |  |
| `status` | `"working"` \| `"faulty"` \| `"under_repair"` \| `"retired"` | no | default `"working"` |
| `note` | string | no |  |

**Returns** (besides `ok: true`): `appliance` (with under_warranty, amc_active, days_until_amc_due)

Example:
```json
{"tool":"appliance_add","arguments":{"household_id":"hh_priya","type":"fridge","brand":"Samsung","purchase_date":"2024-01-10","warranty_end":"2027-01-10"}}
```

### `appliance_update`

Change an appliance. Only the fields you pass are changed (e.g. status 'faulty', or the next AMC due date after a visit).

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `appliance_id` | string | yes |  |
| `fields` | object | yes | Pass only the keys you want to change. |
| `fields.type` | string | no | 'ac', 'fridge', 'ro_purifier', 'washing_machine', … |
| `fields.brand` | string | no |  |
| `fields.model` | string | no |  |
| `fields.serial` | string | no |  |
| `fields.purchase_date` | date (YYYY-MM-DD) | no |  |
| `fields.warranty_end` | date (YYYY-MM-DD) | no |  |
| `fields.brand_only` | boolean | no | true = repairs must go through the brand's service centre (e.g. under warranty) |
| `fields.amc_provider` | string | no |  |
| `fields.amc_technician_id` | string | no |  |
| `fields.amc_end` | date (YYYY-MM-DD) | no |  |
| `fields.amc_visit_every_months` | integer | no |  |
| `fields.amc_next_due` | date (YYYY-MM-DD) | no |  |
| `fields.status` | `"working"` \| `"faulty"` \| `"under_repair"` \| `"retired"` | no |  |
| `fields.note` | string | no |  |

**Returns** (besides `ok: true`): `appliance`

Example:
```json
{"tool":"appliance_update","arguments":{"appliance_id":"app_priya_ac","fields":{"status":"faulty"}}}
```

### `appliance_list`

All appliances of a household, each with under_warranty, amc_active and days_until_amc_due worked out for today (India time).

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `household_id` | string | yes |  |

**Returns** (besides `ok: true`): `household_id`, `appliances[]` each with under_warranty, amc_active, days_until_amc_due

Example:
```json
{"tool":"appliance_list","arguments":{"household_id":"hh_priya"}}
```

### `technician_add`

Add a technician. If the phone is already known, returns the existing technician (already_existed:true) and merges skills. Pass household_id to also add him to that household's own list.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `phone` | string | yes | Phone number, E.164 preferred (+919876543210). Also accepts spaces/dashes, a 10-digit Indian number or a 'whatsapp:' prefix. |
| `skills` | string[] | yes | Appliance types he repairs, e.g. ['ac','fridge'] |
| `contact_pref` | `"text"` \| `"call"` \| `"voice_note"` | no |  |
| `languages` | string[] | no |  |
| `opted_in` | boolean | no | Has he agreed to receive WhatsApp messages from Janus? |
| `upi_id` | string | no |  |
| `area` | string | no |  |
| `household_id` | string | no |  |
| `appliance_types` | string[] | no | Which of the household's appliances he handles (defaults to skills) |
| `relationship` | `"known"` \| `"amc"` | no | default `"known"` |

**Returns** (besides `ok: true`): `technician`, `already_existed`, `linked_to_household`

Example:
```json
{"tool":"technician_add","arguments":{"name":"Prakash","phone":"+919822001122","skills":["fridge"],"household_id":"hh_priya"}}
```

### `technician_update`

Change a technician. Use availability_status + availability_until when he says he is busy or away (e.g. 'at my village till Monday').

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `technician_id` | string | yes |  |
| `fields` | object | yes | Pass only the keys you want to change. |
| `fields.name` | string | no |  |
| `fields.skills` | string[] | no |  |
| `fields.contact_pref` | `"text"` \| `"call"` \| `"voice_note"` | no |  |
| `fields.languages` | string[] | no |  |
| `fields.opted_in` | boolean | no |  |
| `fields.availability_status` | `"available"` \| `"busy"` \| `"away"` \| `"unknown"` | no |  |
| `fields.availability_until` | datetime (ISO, with offset) \| null | no |  |
| `fields.upi_id` | string | no |  |
| `fields.area` | string | no |  |

**Returns** (besides `ok: true`): `technician`

Example:
```json
{"tool":"technician_update","arguments":{"technician_id":"tech_ramesh","fields":{"availability_status":"away","availability_until":"2026-10-06T09:00:00+05:30"}}}
```

### `technician_list_for_appliance`

Who can fix this appliance for this household? The household's own technicians come first, then ones recommended in its society. Each has rating_summary, open_complaints, your_history and typical_price_range. Warns if the household's appliance of this type must go to the brand.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `household_id` | string | yes |  |
| `appliance_type` | string | yes |  |

**Returns** (besides `ok: true`): `technicians[]` (household's own first, then society) each with relationship, rating_summary {ratings, on_time_pct, fixed_pct, fair_price_pct, reachable_pct}, open_complaints, your_history {jobs_paid, last_paid, last_paid_at}, typical_price_range {min, max, data_points} (null under 3 data points); `brand_only_warning` (string or null)

Example:
```json
{"tool":"technician_list_for_appliance","arguments":{"household_id":"hh_priya","appliance_type":"ac"}}
```

### `society_log_add`

Record a technician recommended inside a society. Creates the technician if his phone is new (source 'society_log').

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `society_id` | string | yes |  |
| `technician` | object | yes | Pass only the keys you want to change. |
| `technician.name` | string | no |  |
| `technician.phone` | string | no | Phone number, E.164 preferred (+919876543210). Also accepts spaces/dashes, a 10-digit Indian number or a 'whatsapp:' prefix. |
| `technician.skills` | string[] | no |  |
| `technician.contact_pref` | `"text"` \| `"call"` \| `"voice_note"` | no |  |
| `appliance_types` | string[] | no | Defaults to the technician's skills |
| `added_by_member_id` | string | yes |  |
| `note` | string | no |  |

**Returns** (besides `ok: true`): `technician`, `technician_already_known`, `log_entry`

Example:
```json
{"tool":"society_log_add","arguments":{"society_id":"soc_sai_heights","technician":{"name":"Prakash","phone":"+919822001122","skills":["fridge"]},"added_by_member_id":"mem_priya","note":"Quick and polite"}}
```

### `society_log_search`

Technicians recommended in a society for an appliance type. Duplicate entries for the same phone are merged (see recommendations count). Each has rating_summary, open_complaints and typical_price_range.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `society_id` | string | yes |  |
| `appliance_type` | string | yes |  |

**Returns** (besides `ok: true`): `technicians[]` each with recommendations, notes[], rating_summary, open_complaints, typical_price_range

Example:
```json
{"tool":"society_log_search","arguments":{"society_id":"soc_sai_heights","appliance_type":"ro_purifier"}}
```

### `job_create`

Open a repair job. Use route 'brand' for appliances that must go to the brand's service centre; a warning is returned if you pick 'local' for one.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `household_id` | string | yes |  |
| `appliance_id` | string | no |  |
| `technician_id` | string | no |  |
| `route` | `"local"` \| `"brand"` | no | default `"local"` |
| `urgent` | boolean | no | default `false` |
| `service_type` | string | no | e.g. AC: 'gas_top_up' (local top-up) or 'full_gas_charge' (full charging, much costlier), 'pcb_replacement'; fridge: 'gas_refill', 'wiring_repair'; RO: 'filter_replacement' |
| `issue` | string | no | The problem in the household's words |
| `brand_complaint_no` | string | no |  |

**Returns** (besides `ok: true`): `job` (with household, appliance, technician), `payments[]`, `ratings[]`, `complaints[]`, `warnings[]`

Example:
```json
{"tool":"job_create","arguments":{"household_id":"hh_priya","appliance_id":"app_priya_ac","technician_id":"tech_ramesh","service_type":"gas_top_up","issue":"AC not cooling","urgent":true}}
```

### `job_get`

A job with its household, appliance, technician, payments, ratings and complaints.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `job_id` | string | yes |  |

**Returns** (besides `ok: true`): `job`, `payments[]`, `ratings[]`, `complaints[]`

Example:
```json
{"tool":"job_get","arguments":{"job_id":"job_priya_ac_gas_2025"}}
```

### `job_update`

Change a job. Only the fields you pass are changed. Moving state to contacting / slot_confirmed / in_progress / awaiting_payment also stamps contacted_at / slot_confirmed_at / arrived_at / done_at (if not already set). States: new, contacting, technician_silent, slot_confirmed, in_progress, awaiting_payment, paid, closed, escalated, cancelled.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `job_id` | string | yes |  |
| `fields` | object | yes | Pass only the keys you want to change. |
| `fields.state` | `"new"` \| `"contacting"` \| `"technician_silent"` \| `"slot_confirmed"` \| `"in_progress"` \| `"awaiting_payment"` \| `"paid"` \| `"closed"` \| `"escalated"` \| `"cancelled"` | no |  |
| `fields.technician_id` | string \| null | no |  |
| `fields.route` | `"local"` \| `"brand"` | no |  |
| `fields.urgent` | boolean | no |  |
| `fields.service_type` | string | no |  |
| `fields.issue` | string | no |  |
| `fields.brand_complaint_no` | string | no |  |
| `fields.confirmed_slot` | datetime (ISO, with offset) \| null | no | Agreed visit time, ISO with offset, e.g. 2026-10-03T17:00:00+05:30 |
| `fields.contacted_at` | datetime (ISO, with offset) | no |  |
| `fields.slot_confirmed_at` | datetime (ISO, with offset) | no |  |
| `fields.arrived_at` | datetime (ISO, with offset) | no |  |
| `fields.done_at` | datetime (ISO, with offset) | no |  |

**Returns** (besides `ok: true`): same as job_get

Example:
```json
{"tool":"job_update","arguments":{"job_id":"job_…","fields":{"state":"slot_confirmed","confirmed_slot":"2026-10-03T17:00:00+05:30"}}}
```

### `jobs_open_for_party`

Open jobs (not closed or cancelled) for a phone number: the household's jobs if it is a member, or jobs assigned to him if it is a technician. Use this to work out which job an incoming message is about.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `phone` | string | yes | Phone number, E.164 preferred (+919876543210). Also accepts spaces/dashes, a 10-digit Indian number or a 'whatsapp:' prefix. |

**Returns** (besides `ok: true`): `type`, `phone`, `household_id` or `technician_id`, `jobs[]` (urgent first, newest first)

Example:
```json
{"tool":"jobs_open_for_party","arguments":{"phone":"+919000000011"}}
```

### `ledger_get_history`

What this household has paid before (newest first), optionally only for one appliance type or technician. Only this household's own payments.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `household_id` | string | yes |  |
| `appliance_type` | string | no |  |
| `technician_id` | string | no |  |

**Returns** (besides `ok: true`): `payments[]` (newest first, with technician_name), `summary` {count, confirmed_count, confirmed_total}

Example:
```json
{"tool":"ledger_get_history","arguments":{"household_id":"hh_priya","appliance_type":"ac"}}
```

### `ledger_record_payment`

Record what was paid for a job. If both parts and labour are given they must add up to total. Household, technician, appliance type and service type are taken from the job (pass appliance_type/service_type if the job has none). confirmed:false means someone reported it but it is not yet agreed.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `job_id` | string | yes |  |
| `parts` | integer | no | Whole rupees |
| `labour` | integer | no | Whole rupees |
| `total` | integer | yes | Whole rupees |
| `method` | `"janus"` \| `"direct_cash"` \| `"direct_upi"` \| `"partial"` | yes |  |
| `reported_by` | `"household"` \| `"technician"` \| `"system"` | yes |  |
| `confirmed` | boolean | yes |  |
| `note` | string | no |  |
| `appliance_type` | string | no |  |
| `service_type` | string | no |  |

**Returns** (besides `ok: true`): `payment`, `job_entries`, `job_confirmed_total`

Example:
```json
{"tool":"ledger_record_payment","arguments":{"job_id":"job_…","parts":350,"labour":300,"total":650,"method":"janus","reported_by":"household","confirmed":true}}
```

### `rating_save`

Save the household's rating of a job (four yes/no questions). If the job was already rated, pass replaces_rating_id to correct it; the old rating then stops counting.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `job_id` | string | yes |  |
| `on_time` | boolean \| null | yes |  |
| `fixed` | boolean \| null | yes |  |
| `fair_price` | boolean \| null | yes |  |
| `reachable` | boolean \| null | yes |  |
| `replaces_rating_id` | string | no |  |

**Returns** (besides `ok: true`): `rating`

Example:
```json
{"tool":"rating_save","arguments":{"job_id":"job_…","on_time":true,"fixed":true,"fair_price":true,"reachable":true}}
```

### `complaint_create`

Open a complaint after bad work, e.g. kind 'repeat_fault', 'overcharge', 'no_show', 'damage'. Pass job_id when there is one (household and technician are taken from it), otherwise household_id.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `kind` | string | yes |  |
| `description` | string | yes |  |
| `job_id` | string | no |  |
| `household_id` | string | no |  |
| `technician_id` | string | no |  |

**Returns** (besides `ok: true`): `complaint`

Example:
```json
{"tool":"complaint_create","arguments":{"job_id":"job_…","kind":"repeat_fault","description":"Stopped cooling after 3 days"}}
```

### `complaint_update`

Change a complaint's status (open, in_progress, resolved, closed), resolution or description.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `complaint_id` | string | yes |  |
| `fields` | object | yes | Pass only the keys you want to change. |
| `fields.status` | `"open"` \| `"in_progress"` \| `"resolved"` \| `"closed"` | no |  |
| `fields.resolution` | string | no |  |
| `fields.description` | string | no |  |
| `fields.kind` | string | no |  |

**Returns** (besides `ok: true`): `complaint`

Example:
```json
{"tool":"complaint_update","arguments":{"complaint_id":"cmp_…","fields":{"status":"resolved","resolution":"Free revisit done"}}}
```

### `price_fairness_check`

Is this bill fair? Compares it with (1) this household's own past payments for the same job, adjusted for price rises, else (2) the society average (needs 3+ payments; only the average is used, never a neighbour's bill), else (3) reference prices. Parts and labour are judged separately when given. Verdict: fair, slightly_high (up to 15% above expected), high, low (25%+ below, suspiciously cheap) or insufficient_data. Use the exact service_type (AC 'gas_top_up' vs 'full_gas_charge' are different jobs); if a bill fits another job's range, alternative_service_types says so.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `household_id` | string | yes |  |
| `appliance_type` | string | yes |  |
| `service_type` | string | yes |  |
| `total_amount` | integer | yes | Whole rupees |
| `parts_amount` | integer | no |  |
| `labour_amount` | integer | no |  |

**Returns** (besides `ok: true`): `verdict` ('fair'|'slightly_high'|'high'|'low'|'insufficient_data'), `tier_used` ('household_history'|'society_average'|'reference_prices'|null), `expected_min`, `expected_max`, `last_paid`?, `last_paid_date`?, `difference_pct`, `explanation_en` (ready to paraphrase to the household), `compared` ('total'|'parts'|'labour' — which part decided), `components` {total?, parts?, labour?} each with amount/expected_min/expected_max/verdict/difference_pct, `alternative_service_types[]` (other jobs whose price range the bill fits), `known_service_types[]` (only when insufficient_data), `context` {inflation_buffer_pct, reference_range, reference_source, society_data_points}

Example:
```json
{"tool":"price_fairness_check","arguments":{"household_id":"hh_priya","appliance_type":"ac","service_type":"gas_top_up","total_amount":900}}
```

### `notification_log`

Record a message Janus sent (or should send) to a household or one member, e.g. kind 'job_update', 'price_alert', 'amc_reminder'.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `household_id` | string | yes |  |
| `member_id` | string | no |  |
| `kind` | string | yes |  |
| `body` | string | yes |  |

**Returns** (besides `ok: true`): `notification`

Example:
```json
{"tool":"notification_log","arguments":{"household_id":"hh_priya","member_id":"mem_rohan","kind":"job_update","body":"Ramesh confirmed 5 PM today"}}
```

### `notification_list`

Recent notifications for a household, newest first.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `household_id` | string | yes |  |
| `limit` | integer | no | default `20` |

**Returns** (besides `ok: true`): `notifications[]` (newest first, with member_name)

Example:
```json
{"tool":"notification_list","arguments":{"household_id":"hh_priya"}}
```

### `check_schedule`

Ask to be reminded to look at something later, e.g. kind 'technician_reply' (did he answer?), 'arrival', 'payment_followup', 'amc_visit_reminder'. Give due_at (ISO with offset) OR due_in_minutes. Pass job_id and/or household_id.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `kind` | string | yes |  |
| `due_at` | datetime (ISO, with offset) | no | e.g. 2026-10-03T10:00:00+05:30 |
| `due_in_minutes` | integer | no |  |
| `job_id` | string | no |  |
| `household_id` | string | no |  |
| `payload` | object | no | Anything Janus will need when the check comes due; default `{}` |

**Returns** (besides `ok: true`): `check`

Example:
```json
{"tool":"check_schedule","arguments":{"kind":"technician_reply","job_id":"job_…","due_in_minutes":120,"payload":{"ask":"Has Ramesh replied?"}}}
```

### `checks_due`

Pending checks whose time has come (due_at <= now), oldest first. The scheduler calls this regularly; handle each one, then call check_done.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `now` | datetime (ISO, with offset) | no | Pretend it is this time (for testing). Defaults to the real time. |
| `limit` | integer | no | default `50` |

**Returns** (besides `ok: true`): `now`, `count`, `checks[]` (with job_state, technician_id)

Example:
```json
{"tool":"checks_due","arguments":{}}
```

### `check_done`

Close a check with what happened (e.g. 'technician replied', 'escalated to Rohan'). Use status 'cancelled' if it no longer matters.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `check_id` | string | yes |  |
| `outcome` | string | yes |  |
| `status` | `"done"` \| `"cancelled"` | no | default `"done"` |

**Returns** (besides `ok: true`): `check`

Example:
```json
{"tool":"check_done","arguments":{"check_id":"chk_…","outcome":"Ramesh replied, slot 5 PM"}}
```

### `scenario_set`

Switch on a failure for testing: the next call(s) of that mock fail the way you choose. uses = how many calls it affects (default 1; 0 = until scenario_clear). Setting a key again replaces it. Keys and values: delhivery.next_validate = incomplete|not_found|timeout|malformed; delhivery.next_geocode = not_found|timeout|malformed; delhivery.next_reverse_geocode = unknown_coordinates|timeout|malformed; delhivery.next_matrix = unknown_coordinates|timeout|malformed; delhivery.next_autosuggest = not_found|timeout|malformed; pinelabs.next_mandate = declined|limit_exceeded|timeout|malformed; pinelabs.next_subscription = declined|timeout|malformed; pinelabs.next_payout = insufficient_balance|failed|timeout|malformed; custom.next_presence = not_present|no_location|stale_location|timeout; custom.next_discovery = none_found|timeout; custom.next_identity = verified|not_found|mismatch|timeout; whatsapp.next_send = timeout|not_joined|outside_window|failed; gnani.next_stt = timeout|malformed|low_confidence; gnani.next_tts = timeout|malformed.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `key` | string | yes |  |
| `value` | string | yes |  |
| `uses` | integer | no | default `1` |

**Returns** (besides `ok: true`): `scenario` {key, value, uses_left (null = until cleared)}, `affects` (which mock tool)

Example:
```json
{"tool":"scenario_set","arguments":{"key":"pinelabs.next_payout","value":"timeout","uses":1}}
```

### `scenario_list`

Active failure switches (with uses_left; null = until cleared), plus the catalogue of every key and allowed value.

_No inputs._

**Returns** (besides `ok: true`): `active[]` {key, value, uses_left, created_at}, `catalog` {key: {values[], description}}

Example:
```json
{"tool":"scenario_list","arguments":{}}
```

### `scenario_clear`

Switch failures off. Pass key to clear one, or nothing to clear all.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `key` | string | no |  |

**Returns** (besides `ok: true`): `cleared[]` (keys removed)

Example:
```json
{"tool":"scenario_clear","arguments":{"key":"pinelabs.next_payout"}}
```

### `reset_demo_data`

DANGER: wipes ALL data (jobs, payments, messages, scenario switches) and restores the original demo cast. Only for testers before an eval run or recording, never during a conversation with a household. Requires confirm: "RESET".

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `confirm` | string | yes | Must be exactly "RESET" |

**Returns** (besides `ok: true`): `reset: true`, `took_ms`

Example:
```json
{"tool":"reset_demo_data","arguments":{"confirm":"RESET"}}
```

### `inbound_pending`

New incoming WhatsApp messages to handle, oldest first (call this at the start of every scheduled run). Each message comes with who sent it (party: member with household, technician, or unknown) and is CLAIMED for this run, so another run won't get it. Handle each one, then call inbound_mark_done. A message not marked done within 5 minutes comes back (attempt goes up). Empty list = nothing new.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `limit` | integer | no | default `5` |

**Returns** (besides `ok: true`): `count`, `messages[]` {event_id, from_phone, party {type: member (member_id, name, role, household_id, household_name, language) | technician (technician_id, name) | unknown}, text, media_url, media_type, latitude, longitude, received_at, twilio_message_sid, attempt}, `still_waiting`

Example:
```json
{"tool":"inbound_pending","arguments":{"limit":5}}
```

### `inbound_mark_done`

Close an incoming message after handling it (event_id from inbound_pending), with a short outcome, e.g. 'replied, job job_… created' or 'ignored: spam'. Safe to call twice.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `event_id` | string | yes |  |
| `outcome` | string | yes |  |

**Returns** (besides `ok: true`): `event_id`, `status: done`, `already_done`, `outcome`, `handled_at`. Errors: EVENT_NOT_FOUND

Example:
```json
{"tool":"inbound_mark_done","arguments":{"event_id":"evt_…","outcome":"replied; job job_… created for the AC"}}
```

## Connector `mcp_gnani_janus_pict` — 2 tools

URL: `https://janus-server.vercel.app/gnani/mcp` (server name `gnani_janus`)

### `gnani_speech_to_text`

Transcribe a WhatsApp voice note with Gnani. Pass the media_url from the incoming message and the household's language. Returns Gnani's transcript exactly as given (never corrected). Gnani does not report the detected language or a confidence score, so those are null. Max 60 seconds of audio. Note: Gnani may push Marathi toward Hindi and can stumble on mid-sentence code-switching; if the text looks wrong, ask the household to confirm.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `media_url` | string | yes | MediaUrl0 from the incoming WhatsApp message (Twilio), or a janus-audio Blob URL |
| `language_hint` | `"mr-IN"` \| `"hi-IN"` \| `"en-IN"` \| `"bn-IN"` \| `"gu-IN"` \| `"kn-IN"` \| `"ml-IN"` \| `"pa-IN"` \| `"ta-IN"` \| `"te-IN"` | no | Language spoken. Pune households: mr-IN (Marathi), hi-IN (Hindi), en-IN (English); default `"mr-IN"` |

**Returns** (besides `ok: true`): `text` (Gnani's transcript, unedited), `language_detected` (always null: Gnani doesn't report it), `confidence` (null; 0.31 only under the low_confidence switch), `empty`, `language_used`, `gnani_request_id`, `gnani_model`, `audio_bytes`, `took_ms`, `partner: "Gnani"`

Example:
```json
{"tool":"gnani_speech_to_text","arguments":{"media_url":"https://api.twilio.com/2010-04-01/Accounts/AC…/Messages/MM…/Media/ME…","language_hint":"mr-IN"}}
```

### `gnani_text_to_speech`

Turn text into a WhatsApp voice note with Gnani (OGG/Opus) and return a public audio_url to send as media. language: mr-IN, hi-IN, en-IN, bn-IN, gu-IN, kn-IN, ml-IN, pa-IN, ta-IN, te-IN, hi-en, auto ('hi-en' = Hinglish). Default voices: Marathi Zahira, Hindi Nalini, English Kaveri, Hinglish Poorvi.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `text` | string | yes |  |
| `language` | `"mr-IN"` \| `"hi-IN"` \| `"en-IN"` \| `"bn-IN"` \| `"gu-IN"` \| `"kn-IN"` \| `"ml-IN"` \| `"pa-IN"` \| `"ta-IN"` \| `"te-IN"` \| `"hi-en"` \| `"auto"` | yes |  |
| `voice` | string | no | A Gnani voice for that language, e.g. mr-IN: Zahira (f), Ishaan (m) |
| `speed` | number | no | default `1` |

**Returns** (besides `ok: true`): `audio_url` (public OGG/Opus link, send it as WhatsApp media), `content_type`, `bytes`, `language`, `voice`, `took_ms`, `partner: "Gnani"`

Example:
```json
{"tool":"gnani_text_to_speech","arguments":{"text":"नमस्कार प्रिया, रमेश उद्या संध्याकाळी पाच वाजता येईल.","language":"mr-IN"}}
```

## Connector `mcp_delhivery_janus_pict` — 6 tools

URL: `https://janus-server.vercel.app/delhivery/mcp` (server name `delhivery_janus`)

### `validate_address`

Delhivery: identifies address errors or missing details and returns a corrected version. Response: quality (ok|not_ok), granularity_level (PREMISE…NONE), reason (valid|incomplete|correction_needed|invalid_or_junk), formatted_address, corrections (inline diff: <old|new>, <|added>), request_id, req_id.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `address` | string | no |  |
| `req_id` | string | no |  |

**Returns** (besides `ok: true`): Delhivery body: `quality`, `granularity_level`, `reason`, `formatted_address`, `corrections`, `request_id`, `req_id`. Errors: `HTTP 400 {error}`, `HTTP 504 {error, detail}`

Example:
```json
{"tool":"validate_address","arguments":{"address":"flat 4b sai heights baner pune","req_id":"job-123"}}
```

### `verify_address`

Delhivery: confirms if an address is valid and checks if Delhivery has delivered there within the last `months` (1–24). Validation runs first; is_verified needs a PREMISE-level match. Response: validation fields + is_verified, last_visited_date (YYYY-MM-DD or null), verification_reasoning, request_id, req_id.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `address` | string | no |  |
| `months` | any | no |  |
| `req_id` | string | no |  |

**Returns** (besides `ok: true`): Delhivery body: validation fields + `is_verified`, `last_visited_date`, `verification_reasoning`, `request_id`, `req_id`

Example:
```json
{"tool":"verify_address","arguments":{"address":"Flat 4B, Sai Heights, Baner, Pune 411045","months":6}}
```

### `geocode_address`

Delhivery: converts an address into latitude and longitude. Response: req_id, lat, lng, error_radius (metres; lower = more confident), metadata.pincode. lat/lng are null when nothing is found.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `address` | string | no |  |
| `req_id` | string \| null | no |  |

**Returns** (besides `ok: true`): Delhivery body: `req_id`, `lat`, `lng`, `error_radius` (m), `metadata.pincode` (lat/lng null when not found)

Example:
```json
{"tool":"geocode_address","arguments":{"address":"Flat 4B, Sai Heights, Baner, Pune 411045","req_id":"job-123"}}
```

### `reverse_geocode`

Delhivery: converts latitude and longitude into an address (Google Geocoding format). A precise match returns one ROOFTOP result; otherwise APPROXIMATE results at descending granularity. Response: status, req_id, data {status, results[{formatted_address, types, geometry{location{lat,lng}, location_type}, address_components[]}]}.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `req_id` | string | yes |  |
| `lat` | number | yes |  |
| `lng` | number | yes |  |

**Returns** (besides `ok: true`): Delhivery body: `status`, `req_id`, `data` {status ('OK'|'ZERO_RESULTS'), results[]} (Google geocoding format)

Example:
```json
{"tool":"reverse_geocode","arguments":{"req_id":"loc-1","lat":18.5603,"lng":73.7812}}
```

### `compute_distance_matrix`

Delhivery: travel distance (km) and time (seconds) for every source→target pair. sources/targets are [lat, lng] pairs in India; travel_mode: motorcycle, auto (default), truck, pedestrian. Response: status, sources_to_targets[source][target] = {distance, time, from_index, to_index}.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `sources` | number[][] | yes |  |
| `targets` | number[][] | yes |  |
| `travel_mode` | string | no | default `"auto"` |
| `route_modifiers` | object \| null | no |  |

**Returns** (besides `ok: true`): Delhivery body: `status`, `sources_to_targets[i][j]` = {distance (km), time (seconds), from_index, to_index}

Example:
```json
{"tool":"compute_distance_matrix","arguments":{"sources":[[18.5712,73.7795]],"targets":[[18.5603,73.7812]],"travel_mode":"motorcycle"}}
```

### `auto_suggest`

Delhivery: finds places and addresses as you type. query can be text, a 6-digit pin code, or a 'lat,lng' pair; optional lat/lng bias results toward the user. Response: array of {entity_id, entity_name, display_text, full_address, shape, lat, long, entity_type, score} (may be empty).

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `query` | string | no |  |
| `lat` | number | no |  |
| `lng` | number | no |  |

**Returns** (besides `ok: true`): Delhivery body: array of {entity_id, entity_name, display_text, full_address, shape, lat, long, entity_type, score} (may be empty)

Example:
```json
{"tool":"auto_suggest","arguments":{"query":"sai heights","lat":18.56,"lng":73.78}}
```

## Connector `mcp_pinelabs_janus_pict` — 13 tools

URL: `https://janus-server.vercel.app/pinelabs/mcp` (server name `pinelabs_janus`)

### `create_customer`

Pine Labs POST /api/v1/customer. Creates the customer a mandate or subscription is set up for. Returns customer_id. (Priya already exists: cust-v1-250901101500-aa-PRIYA1, merchant_customer_reference 'hh_priya'.)

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `merchant_customer_reference` | string | yes |  |
| `first_name` | string | yes |  |
| `last_name` | string | no |  |
| `country_code` | string | no | default `"91"` |
| `mobile_number` | string | yes |  |
| `email_id` | string | no |  |
| `merchant_metadata` | object | no |  |

**Returns** (besides `ok: true`): Pine Labs customer: `customer_id`, `merchant_customer_reference`, names, `mobile_number`, `status`, timestamps

Example:
```json
{"tool":"create_customer","arguments":{"merchant_customer_reference":"hh_mehta","first_name":"Neha","last_name":"Mehta","mobile_number":"9000000031"}}
```

### `create_ot_subscription`

Pine Labs One-Time Mandate, step 1: POST /api/v1/public/subscriptions/ot. Blocks up to plan_details.amount (PAISE: ₹2,500 = 250000) on the customer's UPI for validity_days, to be debited once later. Limits: max ₹1,00,000 (10000000 paise), max 60 days. merchant_subscription_reference is the idempotency key. Returns subscription_id, order_id, status CREATED; next call create_mandate_payment with the order_id.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `merchant_subscription_reference` | string | yes |  |
| `customer_id` | string | yes |  |
| `plan_details` | object | yes | Pass only the keys you want to change. |
| `plan_details.amount` | integer | no |  |
| `plan_details.currency` | string | no | default `"INR"` |
| `plan_details.validity_days` | integer | no |  |
| `plan_details.description` | string | no |  |
| `callback_url` | string | no |  |
| `merchant_metadata` | object | no |  |

**Returns** (besides `ok: true`): `subscription_id`, `order_id`, `status: CREATED`, `execution_mode: DIRECT_EXECUTION`, `plan_details`, `start_date`, `end_date`

Example:
```json
{"tool":"create_ot_subscription","arguments":{"merchant_subscription_reference":"job-123-otm","customer_id":"cust-v1-250901101500-aa-PRIYA1","plan_details":{"amount":250000,"currency":"INR","validity_days":30,"description":"AC repair"}}}
```

### `get_ot_subscription`

Pine Labs GET /api/v1/subscriptions/ot/{subscription_id}. Status of a One-Time Mandate: CREATED (waiting for the customer to approve), ACTIVE (approved, can be debited once), COMPLETED (debited), CANCELLED, EXPIRED.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `subscription_id` | string | yes |  |

**Returns** (besides `ok: true`): The One-Time Mandate with its current `status` (CREATED / ACTIVE / COMPLETED / CANCELLED / EXPIRED)

Example:
```json
{"tool":"get_ot_subscription","arguments":{"subscription_id":"v1-sub-…"}}
```

### `create_mandate_payment`

Pine Labs POST /api/pay/v1/orders/{order_id}/payments with mandate_info.request_type CREATE_MANDATE. Registers the UPI mandate for a One-Time Mandate or a UPI AutoPay subscription (use its order_id). payment_amount.value (paise) must equal the mandate amount. In this mock the customer approves in their UPI app immediately: the mandate/subscription becomes ACTIVE (unless the 'declined' failure switch is on).

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `order_id` | string | yes |  |
| `payments` | object[] | yes |  |

**Returns** (besides `ok: true`): `data` {order_id, status (AUTHORIZED | FAILED), order_amount, payments[{id, status, payment_amount, error_detail?}]}

Example:
```json
{"tool":"create_mandate_payment","arguments":{"order_id":"v1-…","payments":[{"merchant_payment_reference":"job-123-mandate","payment_method":"UPI","payment_amount":{"value":250000,"currency":"INR"},"payment_option":{"upi_details":{"txn_mode":"INTENT"}},"mandate_info":{"request_type":"CREATE_MANDATE"}}]}}
```

### `create_presentation`

Pine Labs POST /ps/api/v1/public/subscriptions/{subscription_id}/presentations. Debits the customer against an ACTIVE mandate/subscription (the 'capture'). amount.value in PAISE must be ≤ the mandate amount. A One-Time Mandate can be debited only once and then becomes COMPLETED. merchant_presentation_reference must be unique (a repeat returns DUPLICATE_REQUEST, never a second debit).

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `subscription_id` | string | yes |  |
| `amount` | object | yes | Pass only the keys you want to change. |
| `amount.value` | integer | no |  |
| `amount.currency` | string | no |  |
| `merchant_presentation_reference` | string | yes |  |
| `due_date` | string | no |  |

**Returns** (besides `ok: true`): `presentation_id`, `subscription_id`, `amount`, `due_date`, `status: CREATED`, `merchant_presentation_reference`

Example:
```json
{"tool":"create_presentation","arguments":{"subscription_id":"v1-sub-…","amount":{"value":220000,"currency":"INR"},"merchant_presentation_reference":"job-123-debit"}}
```

### `get_presentation`

Pine Labs GET /ps/api/v1/public/presentations/{presentation_id}. Debit status: CREATED, PENDING, COMPLETED, FAILED, CANCELLED…, plus pdn_status (pre-debit notification) and failure_count.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `presentation_id` | string | yes |  |

**Returns** (besides `ok: true`): `presentation_id`, `status` (COMPLETED in the mock), `pdn_status`, `failure_count`, `amount`, `order_id`

Example:
```json
{"tool":"get_presentation","arguments":{"presentation_id":"v1-bil-…"}}
```

### `cancel_subscription`

Pine Labs POST /ps/api/v1/public/subscriptions/{subscription_id}/cancel. Revokes a One-Time Mandate or cancels a UPI AutoPay subscription; it can no longer be debited. Returns the subscription with status CANCELLED.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `subscription_id` | string | yes |  |

**Returns** (besides `ok: true`): The subscription with `status: CANCELLED`

Example:
```json
{"tool":"cancel_subscription","arguments":{"subscription_id":"v1-sub-…"}}
```

### `create_plan`

Pine Labs POST /ps/api/v1/public/plans. A recurring plan (frequency Month, Quarterly, …) with amount and max_limit_amount in PAISE. (Seeded: v1-pla-250901101600-aa-ROAMC1 = Kent RO AMC, ₹500 quarterly.)

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `plan_name` | string | yes |  |
| `plan_description` | string | no |  |
| `frequency` | `"Day"` \| `"Week"` \| `"Month"` \| `"Year"` \| `"Bi-Monthly"` \| `"Quarterly"` \| `"Half-Yearly"` \| `"AS"` \| `"OT"` \| `"Not Applicable"` | yes |  |
| `amount` | object | yes | Pass only the keys you want to change. |
| `amount.value` | integer | no |  |
| `amount.currency` | string | no |  |
| `max_limit_amount` | object | yes | Pass only the keys you want to change. |
| `max_limit_amount.value` | integer | no |  |
| `max_limit_amount.currency` | string | no |  |
| `initial_debit_amount` | object | no | Pass only the keys you want to change. |
| `initial_debit_amount.value` | integer | no |  |
| `initial_debit_amount.currency` | string | no |  |
| `trial_period_in_days` | integer | no |  |
| `start_date` | string | no |  |
| `end_date` | string | yes |  |
| `merchant_plan_reference` | string | yes |  |
| `merchant_metadata` | object | no |  |
| `auto_debit_ot` | string | no |  |

**Returns** (besides `ok: true`): `plan_id`, `status`, `frequency`, `amount`, `max_limit_amount`, …

Example:
```json
{"tool":"create_plan","arguments":{"plan_name":"Fridge AMC monthly","frequency":"Month","amount":{"value":30000,"currency":"INR"},"max_limit_amount":{"value":40000,"currency":"INR"},"end_date":"2027-10-01T00:00:00Z","merchant_plan_reference":"fridge-amc-monthly"}}
```

### `create_subscription`

Pine Labs POST /ps/api/v1/public/subscriptions (UPI AutoPay / fixed frequency). Subscribes a customer to a plan; merchant_subscription_reference is the idempotency key. Returns subscription_id and order_id with status CREATED; then call create_mandate_payment with that order_id and order_amount.value to activate it.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `merchant_subscription_reference` | string | yes |  |
| `plan_id` | string | yes |  |
| `customer_id` | string | yes |  |
| `start_date` | string | yes |  |
| `end_date` | string | yes |  |
| `integration_mode` | `"SEAMLESS"` \| `"REDIRECT"` | yes |  |
| `enable_notification` | boolean | no |  |
| `allowed_payment_methods` | string[] | no |  |
| `merchant_metadata` | object | no |  |
| `callback_url` | string | no |  |
| `failure_callback_url` | string | no |  |

**Returns** (besides `ok: true`): `subscription_id`, `order_id`, `status: CREATED`, `plan_details`, `order_amount` (use it in create_mandate_payment)

Example:
```json
{"tool":"create_subscription","arguments":{"merchant_subscription_reference":"priya-ro-amc","plan_id":"v1-pla-250901101600-aa-ROAMC1","customer_id":"cust-v1-250901101500-aa-PRIYA1","start_date":"2026-10-05T00:00:00Z","end_date":"2027-10-04T00:00:00Z","integration_mode":"SEAMLESS"}}
```

### `get_subscription`

Pine Labs GET /ps/api/v1/public/subscriptions/{subscription_id}. A UPI AutoPay subscription with its plan_details and status (CREATED, ACTIVE, CANCELLED, EXPIRED, …).

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `subscription_id` | string | yes |  |

**Returns** (besides `ok: true`): The UPI AutoPay subscription with `status` and `plan_details`

Example:
```json
{"tool":"get_subscription","arguments":{"subscription_id":"v1-sub-…"}}
```

### `create_payout`

Pine Labs POST /payouts/v3/payments/banks. Pays a beneficiary (e.g. the technician) from the merchant funding account. mode UPI needs vpa; IMPS/NEFT/RTGS need accountNumber + branchCode (IFSC). amount.value in PAISE. clientReferenceId is the idempotency key: a repeat returns 409 DUPLICATE_REQUEST and never pays twice. If the funding account balance is too low, the payout is accepted with status PENDING ('Funding account has insufficient balance') and no money moves. Check progress with get_payouts.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `clientReferenceId` | string | yes |  |
| `payeeName` | string | yes |  |
| `email` | string | no |  |
| `phone` | string | no |  |
| `accountNumber` | string | no |  |
| `branchCode` | string | no |  |
| `vpa` | string | no |  |
| `amount` | object | yes | Pass only the keys you want to change. |
| `amount.value` | integer | no |  |
| `amount.currency` | string | no |  |
| `mode` | `"UPI"` \| `"IMPS"` \| `"NEFT"` \| `"RTGS"` | yes |  |
| `remarks` | string | yes |  |

**Returns** (besides `ok: true`): `clientReferenceId`, `paymentReferenceId`, `requestReferenceId`, `status` (SCHEDULED | PENDING = insufficient balance | FAILED), `message`, `amount`, `scheduledAt`, `_links`

Example:
```json
{"tool":"create_payout","arguments":{"clientReferenceId":"job-123-payout","payeeName":"Ramesh Patil","vpa":"ramesh.cooling@okaxis","amount":{"value":120000,"currency":"INR"},"mode":"UPI","remarks":"AC repair"}}
```

### `get_payouts`

Pine Labs GET /payouts/v3/payments. Look up payouts by paymentReferenceId or clientReferenceId (or list by status). Status: SCHEDULED, PENDING (insufficient balance), PROCESSING, PROCESSED, SUCCESS (with bankTransactionReferenceId = UTR), FAILED.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `paymentReferenceId` | string | no |  |
| `clientReferenceId` | string | no |  |
| `status` | `"SCHEDULED"` \| `"PENDING"` \| `"PROCESSING"` \| `"PROCESSED"` \| `"SUCCESS"` \| `"FAILED"` | no |  |
| `page` | integer | no | default `1` |
| `count` | integer | no | default `500` |

**Returns** (besides `ok: true`): `payments[]` {status, message, bankTransactionReferenceId (UTR) when SUCCESS, amount, fees, tax, …}, `totalRecords`, `totalPages`, `nextPage`, `_links`

Example:
```json
{"tool":"get_payouts","arguments":{"clientReferenceId":"job-123-payout"}}
```

### `get_payout_balance`

Pine Labs GET /payouts/v3/payments/funding-account. The merchant funding account payouts are paid from: accountNumber, branchCode, balance.value in PAISE (₹2,000 at reset = 200000).

_No inputs._

**Returns** (besides `ok: true`): `accountNumber`, `branchCode`, `balance` {value (paise), currency}

Example:
```json
{"tool":"get_payout_balance","arguments":{}}
```

## Connector `mcp_janus_custom_pict` — 3 tools

URL: `https://janus-server.vercel.app/custom/mcp` (server name `janus_custom`)

### `proof_of_presence`

Is the technician really at the household? Compares the location he shared (latitude/longitude + when it was taken) with the household's geocoded address and the job's agreed slot. present: true (within 200 m), false (farther away), or unknown (no location shared, location older than 15 minutes, or he isn't this job's technician). Partner: Delhivery (GPS pings and geocoded addresses).

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `job_id` | string | yes |  |
| `technician_phone` | string | yes | Phone number, E.164 preferred (+919876543210). Also accepts spaces/dashes, a 10-digit Indian number or a 'whatsapp:' prefix. |
| `latitude` | number \| null | no | From the WhatsApp location he shared; omit or null if he shared none |
| `longitude` | number \| null | no |  |
| `timestamp` | datetime (ISO, with offset) | yes | When the location was taken (ISO with offset), e.g. the message's received_at |

**Returns** (besides `ok: true`): `partner: "Delhivery"`, `present` (true | false | "unknown"), `distance_m`, `minutes_from_slot`, `location_age_minutes`, `reason` (at_household | too_far | no_location | stale_location | not_job_technician | household_not_geocoded), `explanation`, `technician`, `household_location`, `confirmed_slot`

Example:
```json
{"tool":"proof_of_presence","arguments":{"job_id":"job_…","technician_phone":"+918369502720","latitude":18.5604,"longitude":73.7813,"timestamp":"2026-10-03T17:05:00+05:30"}}
```

### `technician_discovery`

Find repair businesses near a location that fix this appliance, nearest first: name, business, phone, skills, rating, distance_m and motorcycle ETA, source 'delhivery_poi'. Use when the household's own and society technicians are unavailable. Partner: Delhivery (POI / business data behind its Autosuggest).

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `appliance_type` | string | yes |  |
| `latitude` | number | yes |  |
| `longitude` | number | yes |  |
| `radius_m` | integer | no | default `3000` |

**Returns** (besides `ok: true`): `partner: "Delhivery"`, `count`, `technicians[]` {name, business_name, phone, skills, rating, address, distance_m, eta_minutes_motorcycle, already_known_technician_id, source}, `reason` (found | none_found), `nearest_outside_radius_m` + `hint` when none found

Example:
```json
{"tool":"technician_discovery","arguments":{"appliance_type":"ac","latitude":18.5603,"longitude":73.7812,"radius_m":3000}}
```

### `technician_identity_check`

Is this technician who he says he is? Checks his name, phone and (optionally) UPI ID against the KYC Pine Labs holds for merchants it onboarded for UPI/QR acceptance. status: verified (name matches; UPI too if given), mismatch (phone is a Pine Labs merchant but the name or UPI ID differs; registered name is masked), not_found (not a Pine Labs merchant). Use before paying a new technician. Partner: Pine Labs (merchant KYC).

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes |  |
| `phone` | string | yes | Phone number, E.164 preferred (+919876543210). Also accepts spaces/dashes, a 10-digit Indian number or a 'whatsapp:' prefix. |
| `upi_id` | string | no |  |

**Returns** (besides `ok: true`): `partner: "Pine Labs"`, `status` (verified | mismatch | not_found), `matched_fields[]`, `mismatched_fields[]`, `merchant` {display_name, city, onboarded_at}, `registered_name_hint` (masked, on mismatch), `checked_at`, `explanation`

Example:
```json
{"tool":"technician_identity_check","arguments":{"name":"Ramesh Patil","phone":"+918369502720","upi_id":"ramesh.cooling@okaxis"}}
```

## Connector `mcp_whatsapp_janus_pict` — 3 tools

URL: `https://janus-server.vercel.app/whatsapp/mcp` (server name `whatsapp_janus`)

### `send_whatsapp`

Send one real WhatsApp message from the Twilio sandbox number to a known household member or technician (anyone else is refused: RECIPIENT_UNKNOWN). Give body (max 1600 characters) and/or media_url (public https link, e.g. a gnani_text_to_speech audio_url for a voice reply). Returns message_sid and Twilio's status (usually queued). If WhatsApp rejects it within a few seconds (not joined the sandbox, outside the 24-hour window) you get that error instead. Never resend after TWILIO_TIMEOUT without checking get_message_status first.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `to` | string | yes | Phone number, E.164 preferred (+919876543210). Also accepts spaces/dashes, a 10-digit Indian number or a 'whatsapp:' prefix. |
| `body` | string | no |  |
| `media_url` | string | no | Public https URL of the media to attach |

**Returns** (besides `ok: true`): `message_sid`, `status` (Twilio's, usually queued), `to`, `recipient` {name, type}, `sent_at` (ISO UTC), `partner`. Errors: RECIPIENT_UNKNOWN, NOT_JOINED_SANDBOX, OUTSIDE_24H_WINDOW, INVALID_PHONE, TWILIO_TIMEOUT, TWILIO_RATE_LIMITED, TWILIO_AUTH_FAILED, TWILIO_ERROR (+ twilio_code, twilio_message)

Example:
```json
{"tool":"send_whatsapp","arguments":{"to":"+918530921384","body":"Ramesh confirmed: he'll come today at 5 PM."}}
```

### `make_call`

Place one real voice call to a known household member or technician (anyone else is refused). Use only when allowed by the prompt rules (e.g. a technician who hasn't opted in to WhatsApp). The call always starts with "Hello, this is Janus, an AI assistant." and then reads your message (max 500 characters) in en-IN (default) or hi-IN. Returns call_sid and status.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `to` | string | yes | Phone number, E.164 preferred (+919876543210). Also accepts spaces/dashes, a 10-digit Indian number or a 'whatsapp:' prefix. |
| `message` | string | yes |  |
| `language` | `"en-IN"` \| `"hi-IN"` | no | default `"en-IN"` |

**Returns** (besides `ok: true`): `call_sid`, `status`, `to`, `recipient`, `partner`. Errors: RECIPIENT_UNKNOWN, NO_VOICE_NUMBER, TWILIO_* as above

Example:
```json
{"tool":"make_call","arguments":{"to":"+918369502720","message":"Priya in Sai Heights, Baner needs her AC repaired. Please reply on WhatsApp if you can come.","language":"hi-IN"}}
```

### `get_message_status`

Has a WhatsApp message been delivered? status: queued, sent, delivered, read, failed or undelivered. When it failed, error_code_twilio says why (63015 = not joined the sandbox, 63016 = outside the 24-hour window) and error_hint explains what to do.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `message_sid` | string | yes |  |

**Returns** (besides `ok: true`): `message_sid`, `status` (queued | sent | delivered | read | failed | undelivered), `error_code_twilio` (also as `twilio_error_code`), `error_hint` (when failed), `to`, `date_sent`, `partner`

Example:
```json
{"tool":"get_message_status","arguments":{"message_sid":"SM…"}}
```

<!-- TOOLS:END -->
