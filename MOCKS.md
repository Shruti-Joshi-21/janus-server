# Mocks: where every field comes from

Competition rule: mocks must use the partner's real documented tool/endpoint names and request/response fields exactly, and behave like the real service (different answers for different inputs, including failures). This file records the source for each mock and anything we could **not** verify.

Common to all mocks:
- Every `/…/mcp` route needs the `x-api-key` header (our auth, not the partner's).
- Success → the partner's documented response body, unchanged (no extra fields added).
- Error → `isError: true`, and the text is `HTTP <status>: <partner's documented error body>` so the status is visible without changing the body.
- "Malformed" failures return deliberately truncated JSON.
- Timeouts wait about 6 seconds, then return the partner's 504 body (AgenticOrg cuts tools off at 10 seconds).
- Failure switches: see `scenario_set` in TOOLS.md.

## Real APIs we wrap (not mocks)

- **Gnani** (`/gnani/mcp`): real Gnani Vachana speech-to-text and text-to-speech.
- **WhatsApp** (`/whatsapp/mcp`): real Twilio API (WhatsApp sandbox +1 415 523 8886; calls from `TWILIO_VOICE_FROM` if set). AgenticOrg's native Twilio connector failed its connection test with valid credentials, and an unhealthy connector blocks the whole Janus agent, so Janus sends through our server instead. Only known household members and technicians can be messaged or called (`RECIPIENT_UNKNOWN` otherwise). The `whatsapp.next_send` failure switch answers without calling Twilio.

## Delhivery Maps (`/delhivery/mcp`, connector `delhivery_janus_pict`)

**Sources (checked 2026-10-03):**
- Tool names: Delhivery's MCP server listing on https://www.delhivery.com/maps/developer (server `https://gateway-maps-pub-int.delhivery.com/mcp`): `validate_address`, `verify_address`, `geocode_address`, `reverse_geocode`, `compute_distance_matrix`, `auto_suggest`. (Their server also has `standardize_address`, `route`, `calculate_tolls`, which we don't mock.)
- Fields: Delhivery's OpenAPI spec https://www.delhivery.com/maps/openapi.json (the data behind https://www.delhivery.com/maps/reference), version 1.0.0.

| Our tool | Delhivery REST endpoint | Request fields | Response fields |
| --- | --- | --- | --- |
| `validate_address` | `POST /validate` | `address`, `req_id`? | `quality`, `granularity_level`, `reason`, `formatted_address`, `corrections`, `request_id`, `req_id` |
| `verify_address` | `POST /verify` | `address`, `months` (1–24), `req_id`? | validation fields + `is_verified`, `last_visited_date`, `verification_reasoning`, `request_id`, `req_id` |
| `geocode_address` | `POST /geocode` | `address`, `req_id`? | `req_id`, `lat`, `lng`, `error_radius`, `metadata.pincode` |
| `reverse_geocode` | `POST /rvg` | `req_id`, `lat`, `lng` | `status`, `req_id`, `data.status`, `data.results[]` (`formatted_address`, `types`, `geometry.location`, `geometry.location_type`, `address_components[]`) |
| `compute_distance_matrix` | `POST /matrix` | `sources`, `targets` ([lat,lng] pairs), `travel_mode`, `route_modifiers` | `status`, `sources_to_targets[i][j]` = `distance` (km), `time` (s), `from_index`, `to_index` |
| `auto_suggest` | `GET /search` | `query`, `lat`?, `lng`? | array of `entity_id`, `entity_name`, `display_text`, `full_address`, `shape`, `lat`, `long`, `entity_type`, `score` |

Error bodies copied from the spec: `{"error": "No address provided", "request_id"}`, `{"error": "'months' is a required field."}`, `{"error": "Invalid 'months' value. Must be integer between 1 and 24."}`, `{"error": "address field is required"}`, `{"error": "query parameter is required"}`, `/rvg` 400 `{"status":"error","req_id":null,"data":null,"error":"validation error","errors":[{field,message}]}`, `/matrix` 400 `{"error": "Missing required field: sources"}` / `Invalid travel mode: …` / `Coordinate at index N is outside India boundary: (lat, lng)` + `error_code: 1002` / pair-limit message, 504 `{"detail": "Upstream service '<name>' timed out"}` and `/validate` 504 `{"error":"Request timed out","detail":"OpenSearch search timed out (10.0s budget)"}`.

**Not verified / our assumptions:**
- **MCP input names.** Delhivery's MCP server needs their login (HTTP 401 without it), so we couldn't see its tool input schemas. We used the REST request field names above; their MCP tools are likely thin wrappers but this is unconfirmed.
- **Distance unit.** CLAUDE.md asked for metres, but Delhivery's spec says `distance` is **km** (`"Distance in km."`). We follow Delhivery.
- **Distances and times are computed, not routed**: straight-line × 1.3 road factor; city speeds motorcycle 25 km/h, auto 22, truck 18, pedestrian 4.5.
- **No "missing fields" list.** CLAUDE.md mentioned one, but Delhivery's validate response has none; incompleteness is shown by `reason: "incomplete"` + `granularity_level`.
- `reverse_geocode` with no match returns `data.status: "ZERO_RESULTS"` and `results: []` (Google format, which the spec says it follows; not shown in the spec's examples).
- `compute_distance_matrix` "unknown coordinates" switch returns `{"error": "Unable to find a route between source 0 and target 0", "error_code": 1003}`. Code 1003 = ROUTING_API_ERROR is documented; the message text is ours.
- `auto_suggest`: `entity_type` values `building`, `street`, `poi`, `locality`, `pincode`, `coordinate` and the `score` scale are ours (the spec shows only `"building"` and `5210.332`). `shape` is always null. Local repair businesses (technician_directory) appear as `poi`.
- `verify_address` `last_visited_date` comes from a seeded "delivered N days ago" per place (Sai Heights: 9 days before each reset).
- `rvg`'s optional `steps` query parameter is ignored.

**Behaviour (from seed data `delhivery_places`, 15 Pune places):** building + flat number → `PREMISE`; building without flat → `STREET_LANDMARK` + `incomplete`; street/landmark → `STREET_LANDMARK`; locality → `LOCALITY`; only "Pune" or a known pincode → `CITY_PINCODE`; nothing recognisable → `NONE` + `invalid_or_junk`; wrong pincode on a premise → `correction_needed`.

## Pine Labs (`/pinelabs/mcp`, connector `pinelabs_janus_pict`)

Only the products AgenticOrg's real `pinelabs_plural` connector lacks are mocked: One-Time Mandate, Fixed Frequency Subscription (UPI AutoPay) and Payouts.

**Sources (checked 2026-10-03):**
- Pine Labs Online OpenAPI spec, version 3.0: https://www.pinelabs.com/docs/online-payments/api/downloads/openapi-spec (servers `https://pluraluat.v2.pinepg.in` UAT, `https://api.pluralpay.in` production).
- One-Time Mandate guide: https://www.pinelabs.com/docs/online-payments/one-time-mandate and its "Integration Steps" page (flow: create customer → create OT subscription → register mandate → wait for ACTIVE → create presentation). Limits from the overview page: up to ₹1 lakh, up to 60 days, one successful capture, then the mandate closes.

| Our tool | Pine Labs endpoint | Source |
| --- | --- | --- |
| `create_customer` | `POST /api/v1/customer` | OpenAPI |
| `create_ot_subscription` | `POST /api/v1/public/subscriptions/ot` | OTM integration steps (not in the OpenAPI file) |
| `get_ot_subscription` | `GET /api/v1/subscriptions/ot/{subscription_id}` | OTM integration steps |
| `create_mandate_payment` | `POST /api/pay/v1/orders/{order_id}/payments` with `mandate_info.request_type: CREATE_MANDATE` | OpenAPI (payments) + OTM integration steps (`mandate_info`) |
| `create_presentation` | `POST /ps/api/v1/public/subscriptions/{subscription_id}/presentations` | OpenAPI |
| `get_presentation` | `GET /ps/api/v1/public/presentations/{presentation_id}` | OpenAPI |
| `cancel_subscription` | `POST /ps/api/v1/public/subscriptions/{subscription_id}/cancel` | OpenAPI |
| `create_plan` | `POST /ps/api/v1/public/plans` | OpenAPI |
| `create_subscription` | `POST /ps/api/v1/public/subscriptions` | OpenAPI |
| `get_subscription` | `GET /ps/api/v1/public/subscriptions/{subscription_id}` | OpenAPI |
| `create_payout` | `POST /payouts/v3/payments/banks` | OpenAPI |
| `get_payouts` | `GET /payouts/v3/payments` | OpenAPI |
| `get_payout_balance` | `GET /payouts/v3/payments/funding-account` | OpenAPI |

Copied exactly: amounts as `{value, currency}` in **paise** (min ₹1 = 100, max ₹10 lakh = 100000000); idempotency keys `merchant_subscription_reference` (duplicate → 422 `DUPLICATE_REQUEST`) and payout `clientReferenceId` (duplicate → 409 `DUPLICATE_REQUEST`, "will not create a new payout"); subscription, presentation, payment and payout status values; payout validation (`payeeName` letters and spaces only, `remarks` A–Z/0–9/hyphen/space, 10-digit `phone`, IFSC pattern for `branchCode`, `vpa` for UPI); id formats (`v1-sub-…`, `v1-bil-…`, `txn-<32 hex>`, `req-<32 hex>`, `cust-v1-…`); error body shape `{code, message, additional_error_details: {source, step, reason}}` with documented codes `INVALID_REQUEST`, `DUPLICATE_REQUEST`, `ORDER_NOT_FOUND`, `INTERNAL_ERROR`.

**Differences from CLAUDE.md (we follow Pine Labs):**
- **Insufficient balance doesn't fail a payout.** Pine Labs documents payout status `PENDING` = "Funding account has insufficient balance". So a ₹2,500 payout against the ₹2,000 balance is accepted as `PENDING` with that message and no money moves, instead of an `INSUFFICIENT_BALANCE` error.
- **Duplicate idempotency keys return Pine Labs' `DUPLICATE_REQUEST` error**, not the original result. Either way nothing is paid twice; use `get_payouts {clientReferenceId}` / `get_ot_subscription` to see the original.
- **No beneficiary name ↔ UPI validation tool.** Pine Labs' API has no such endpoint (searched the spec for beneficiary, VPA validation, name match). That check is covered by our custom capability `technician_identity_check` (M9), which is labelled as a custom capability built on Pine Labs' merchant KYC.
- **"Mandate" tables**: a One-Time Mandate is stored as a subscription of kind `OT` (that's how Pine Labs models it), not a separate `mock_mandates` table.

**Not verified / our assumptions:**
- The full response bodies of `create_ot_subscription` / `get_ot_subscription`: the guide only names `subscription_id`, `order_id`, `status: CREATED`, `execution_mode: DIRECT_EXECUTION`; other fields (`plan_details` echo, `start_date`, `end_date`, `frequency: OT`, timestamps) are ours.
- **Customer approval is instant.** Real UPI mandate registration returns a pending payment and the customer approves in their UPI app (then a webhook fires). The mock approves immediately: `AUTHORIZED` and the subscription becomes `ACTIVE`. The `declined` switch simulates the customer rejecting (`PAYMENT_DECLINED` is our code).
- **Debits and payouts complete immediately.** A presentation is returned `CREATED`; fetching it shows `COMPLETED` (pdn `NOTIFIED`). A payout is returned `SCHEDULED`; `get_payouts` shows `SUCCESS` with a random 12-digit UTR.
- Error codes not in the spec: `CUSTOMER_NOT_FOUND`, `SUBSCRIPTION_NOT_FOUND`, `PLAN_NOT_FOUND`, `GATEWAY_TIMEOUT` (504 body), `PAYMENT_DECLINED`, and the `reason` values `amount_exceeds_limit`, `invalid_validity`, `amount_mismatch`, `subscription_not_active`, `amount_exceeds_mandate`, `subscription_not_cancellable`, `mandate_already_processed`, `invalid_branch_code`, `invalid_payee_name`, etc. (Spec examples show `INVALID_REQUEST` / `missing_required_fields`.)
- `vpa` on payouts: the spec's description says "For UPI, provide vpa instead" but the field isn't in its request schema; we accept `vpa`.
- An unused mandate past `end_date` shows `EXPIRED` (Pine Labs lists the status; the timing rule is ours).
- Authentication headers (`Authorization: Bearer`, `Merchant-ID`, `Request-ID`, `Request-Timestamp`) are not modelled; our `x-api-key` replaces them.

**Seed data:** Priya is customer `cust-v1-250901101500-aa-PRIYA1`; plan `v1-pla-250901101600-aa-ROAMC1` = Kent RO AMC, ₹500 quarterly (max ₹750); funding account `0995300992429` / `UTIB0001111` with **₹2,000** (200000 paise).

## Custom capabilities (`/custom/mcp`, connector `janus_custom_pict`)

Competition rule: up to 3 capabilities that Gnani, Pine Labs or Delhivery don't offer today, each attributable to one partner and the data it already holds. These are **our designs**, not copies of a partner API, so they answer in our normal `{ok, …}` format and every answer carries a `partner` field.

| Tool | Partner | Data the partner already holds | Our seed data standing in for it |
| --- | --- | --- | --- |
| `proof_of_presence` | **Delhivery** | Billions of delivery GPS pings and geocoded doorstep addresses | The household's coordinates (`households.latitude/longitude`) and the job's `confirmed_slot` |
| `technician_discovery` | **Delhivery** | POI / business listings behind its Autosuggest search | `technician_directory` (3 Pune repair businesses near Baner, `source: "delhivery_poi"`) |
| `technician_identity_check` | **Pine Labs** | KYC on merchants it onboarded for UPI/QR acceptance | `pine_merchants` (4 merchants: Ramesh and Suresh verified; Mahesh verified; Santosh's phone registered to "Sunil Jadhav"; Anil absent) |

Rules (ours):
- **proof_of_presence**: present if within **200 m** of the household (straight-line); `unknown` if no location was shared, if the location is older than **15 minutes**, if the phone isn't the job's technician, or if the household has no coordinates. `minutes_from_slot` = location time minus the agreed slot.
- **technician_discovery**: businesses whose skills include the appliance, within `radius_m` (default 3 km, max 25 km), nearest first; ETA assumes 25 km/h motorcycle on roads (straight-line × 1.3). When nothing is in range it reports the nearest one outside it.
- **technician_identity_check**: `verified` if every word of the given name is in the KYC legal name (so "Ramesh" matches "Ramesh Patil") and the UPI ID matches when given; `mismatch` otherwise, showing only a **masked** registered name (e.g. `S**** J*****`) so KYC data isn't exposed; `not_found` if the phone isn't a verified Pine Labs merchant. This also covers the "beneficiary name ↔ UPI ID" check that Pine Labs' real API doesn't offer.

Failure switches: `custom.next_presence` (not_present, no_location, stale_location, timeout), `custom.next_discovery` (none_found, timeout), `custom.next_identity` (verified, not_found, mismatch, timeout). Simulated answers carry `simulated: true`. Timeouts return `{ok:false, error_code:"TIMEOUT", partner, http_status: 504}` after about 6 seconds.
