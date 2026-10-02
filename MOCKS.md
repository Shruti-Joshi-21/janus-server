# Mocks: where every field comes from

Competition rule: mocks must use the partner's real documented tool/endpoint names and request/response fields exactly, and behave like the real service (different answers for different inputs, including failures). This file records the source for each mock and anything we could **not** verify.

Common to all mocks:
- Every `/…/mcp` route needs the `x-api-key` header (our auth, not the partner's).
- Success → the partner's documented response body, unchanged (no extra fields added).
- Error → `isError: true`, and the text is `HTTP <status>: <partner's documented error body>` so the status is visible without changing the body.
- "Malformed" failures return deliberately truncated JSON.
- Timeouts wait about 6 seconds, then return the partner's 504 body (AgenticOrg cuts tools off at 10 seconds).
- Failure switches: see `scenario_set` in TOOLS.md.

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

## Pine Labs (`/pinelabs/mcp`)

Not built yet (M8).

## Custom capabilities (`/custom/mcp`)

Not built yet (M9).
