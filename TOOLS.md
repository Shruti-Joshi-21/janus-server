# Janus tools — the contract between Track A (server) and Track B (Janus prompt)

Tool names, inputs and outputs below are generated from the live server, so they match exactly what AgenticOrg discovers.
If a name here differs from the prompt, the prompt is wrong.

## Status

| Connector on AgenticOrg | What | Status |
| --- | --- | --- |
| `mcp_janus_core_pict` | Janus's database, people, jobs, payments, follow-up checks, price fairness, failure switches, demo reset | **Live, 35 tools** (re-register the connector to see the 4 scenario/reset tools) |
| Twilio inbound webhook `/api/twilio/inbound` | Incoming WhatsApp → JSON `{channel, from_phone, text, media_url, media_type, latitude, longitude, received_at, twilio_message_sid}` → Janus, either by AgenticOrg `POST /api/v1/workflows/{id}/run` (body `{payload: event}`, needs an admin API key) or by email to the Janus Gmail (subject `[janus-inbound] WhatsApp from +91…`, body = the JSON) | **Live** via Gmail: every message arrives at janus.pict.demo@gmail.com |
| `delhivery_janus` | Delhivery Maps mock | Planned (M7) |
| `pinelabs_janus` | Pine Labs mandate / subscription / payout mock | Planned (M8) |
| `janus_custom` | proof_of_presence, technician_discovery, technician_identity_check | Planned (M9) |
| Gnani | Speech-to-text / text-to-speech | Planned (M6) |

When new tools are added to a connector, AgenticOrg only sees them after the connector is archived and registered again (same name).

## Conventions (all tools)

- **Every answer is JSON.** Success: `{"ok": true, ...}`. Failure: `{"ok": false, "error_code": "JOB_NOT_FOUND", "message": "No job with id \"job_x\"."}` — some failures add extra fields (listed under Error codes). Janus should read `ok` first, never assume success.
- **Bad input** (missing field, wrong type, unknown key, bad date) → `error_code: "INVALID_INPUT"` with a message naming the field.
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

**Pine Labs payout balance** ₹2,000 (a ₹2,500 payout will fail with insufficient balance, once M8 is built).

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
| `delhivery.next_validate` | incomplete, not_found, timeout, malformed | validate_address / verify_address | M7 (not yet) |
| `delhivery.next_geocode` | not_found, timeout, malformed | geocode_address | M7 |
| `delhivery.next_reverse_geocode` | unknown_coordinates, timeout, malformed | reverse_geocode | M7 |
| `delhivery.next_matrix` | unknown_coordinates, timeout, malformed | compute_distance_matrix | M7 |
| `delhivery.next_autosuggest` | not_found, timeout, malformed | auto_suggest | M7 |
| `pinelabs.next_mandate` | declined, limit_exceeded, timeout, malformed | One-Time Mandate | M8 |
| `pinelabs.next_subscription` | declined, timeout, malformed | Fixed Frequency Subscription | M8 |
| `pinelabs.next_payout` | insufficient_balance, failed, timeout, malformed | Payouts | M8 |
| `pinelabs.next_beneficiary` | name_mismatch, not_found, timeout | Beneficiary validation | M8 |
| `custom.next_presence` | not_present, no_location, stale_location, timeout | proof_of_presence | M9 |
| `custom.next_discovery` | none_found, timeout | technician_discovery | M9 |
| `custom.next_identity` | verified, not_found, mismatch, timeout | technician_identity_check | M9 |
| `gnani.next_stt` | timeout, malformed, low_confidence | gnani_speech_to_text | M6 |
| `gnani.next_tts` | timeout, malformed | gnani_text_to_speech | M6 |

The switches exist now; each mock starts obeying its keys when that milestone is built. Mocks also fail on their own for realistic inputs (unknown address, ₹2,500 payout vs ₹2,000 balance, …) without any switch.

**Reset to the demo state**: `reset_demo_data {confirm: "RESET"}` (about 1 second). Wipes every job, payment, message and switch and restores the cast. For testers before an eval run or recording only, never inside a household conversation. Track A can also run `npm run reset`.

<!-- TOOLS:START (generated by `npm run docs:tools`, do not edit by hand) -->

## Connector `mcp_janus_core_pict` — 35 tools

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

Switch on a failure for testing: the next call(s) of that mock fail the way you choose. uses = how many calls it affects (default 1; 0 = until scenario_clear). Setting a key again replaces it. Keys and values: delhivery.next_validate = incomplete|not_found|timeout|malformed; delhivery.next_geocode = not_found|timeout|malformed; delhivery.next_reverse_geocode = unknown_coordinates|timeout|malformed; delhivery.next_matrix = unknown_coordinates|timeout|malformed; delhivery.next_autosuggest = not_found|timeout|malformed; pinelabs.next_mandate = declined|limit_exceeded|timeout|malformed; pinelabs.next_subscription = declined|timeout|malformed; pinelabs.next_payout = insufficient_balance|failed|timeout|malformed; pinelabs.next_beneficiary = name_mismatch|not_found|timeout; custom.next_presence = not_present|no_location|stale_location|timeout; custom.next_discovery = none_found|timeout; custom.next_identity = verified|not_found|mismatch|timeout; gnani.next_stt = timeout|malformed|low_confidence; gnani.next_tts = timeout|malformed.

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

<!-- TOOLS:END -->
