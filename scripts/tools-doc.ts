// `npm run docs:tools [base-url]` — asks a running server for its tool list and rewrites the
// generated part of TOOLS.md (between the TOOLS:START / TOOLS:END markers). Default base: http://localhost:3000
import { readFileSync, writeFileSync } from "node:fs";

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  format?: string;
  description?: string;
  default?: unknown;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
  additionalProperties?: unknown;
};
type Tool = { name: string; description?: string; inputSchema: JsonSchema };

// onlyNew: list only the tools no earlier route has (the step tools live only on /janus/mcp).
const CONNECTORS: Record<string, { path: string; connector: string; onlyNew?: boolean }> = {
  janus_core: { path: "/janus-core/mcp", connector: "mcp_janus_core_pict" },
  gnani_janus: { path: "/gnani/mcp", connector: "mcp_gnani_janus_pict" },
  delhivery_janus: { path: "/delhivery/mcp", connector: "mcp_delhivery_janus_pict" },
  pinelabs_janus: { path: "/pinelabs/mcp", connector: "mcp_pinelabs_janus_pict" },
  janus_custom: { path: "/custom/mcp", connector: "mcp_janus_custom_pict" },
  whatsapp_janus: { path: "/whatsapp/mcp", connector: "mcp_whatsapp_janus_pict" },
  janus: { path: "/janus/mcp", connector: "mcp_janus_pict", onlyNew: true },
};

// What each tool returns (besides ok:true) and one example call. Keep in step with lib/janus-core/.
const NOTES: Record<string, { returns: string; example: Record<string, unknown> }> = {
  ping: { returns: "`server`, `time`", example: {} },
  get_party_by_phone: {
    returns: "`type` ('member'|'technician'|'unknown'), `phone` (normalised); member → `household_id`, `member`, `household` {name, flat, language, spend_limit, onboarding_step, open_jobs}; technician → `technician` (+ open_jobs)",
    example: { phone: "+919000000001" },
  },
  household_create: { returns: "`household`, `member`", example: { phone: "+919811122233", name: "Asha", language: "hi-en", society_id: "soc_sai_heights", flat: "1A" } },
  household_get: { returns: "`household`, `society`, `members[]`, `appliances[]` (summary), `technicians[]` (household's own)", example: { household_id: "hh_priya" } },
  household_update: { returns: "`household`", example: { household_id: "hh_priya", fields: { spend_limit: 6000 } } },
  member_add: { returns: "`member`", example: { household_id: "hh_priya", phone: "+919000000003", name: "Aai", role: "notified" } },
  onboarding_get: { returns: "`household_id`, `step`, `data`", example: { household_id: "hh_priya" } },
  onboarding_save: { returns: "`household_id`, `step`, `data` (merged)", example: { household_id: "hh_priya", step: "appliances", data: { has_ac: true } } },
  appliance_add: { returns: "`appliance` (with under_warranty, amc_active, days_until_amc_due)", example: { household_id: "hh_priya", type: "fridge", brand: "Samsung", purchase_date: "2024-01-10", warranty_end: "2027-01-10" } },
  appliance_update: { returns: "`appliance`", example: { appliance_id: "app_priya_ac", fields: { status: "faulty" } } },
  appliance_list: { returns: "`household_id`, `appliances[]` each with under_warranty, amc_active, days_until_amc_due", example: { household_id: "hh_priya" } },
  technician_add: { returns: "`technician`, `already_existed`, `linked_to_household`", example: { name: "Prakash", phone: "+919822001122", skills: ["fridge"], household_id: "hh_priya" } },
  technician_update: { returns: "`technician`", example: { technician_id: "tech_ramesh", fields: { availability_status: "away", availability_until: "2026-10-06T09:00:00+05:30" } } },
  technician_list_for_appliance: {
    returns: "`technicians[]` (household's own first, then society) each with relationship, rating_summary {ratings, on_time_pct, fixed_pct, fair_price_pct, reachable_pct}, open_complaints, your_history {jobs_paid, last_paid, last_paid_at}, typical_price_range {min, max, data_points} (null under 3 data points); `brand_only_warning` (string or null)",
    example: { household_id: "hh_priya", appliance_type: "ac" },
  },
  society_log_add: { returns: "`technician`, `technician_already_known`, `log_entry`", example: { society_id: "soc_sai_heights", technician: { name: "Prakash", phone: "+919822001122", skills: ["fridge"] }, added_by_member_id: "mem_priya", note: "Quick and polite" } },
  society_log_search: { returns: "`technicians[]` each with recommendations, notes[], rating_summary, open_complaints, typical_price_range", example: { society_id: "soc_sai_heights", appliance_type: "ro_purifier" } },
  job_create: { returns: "`job` (with household, appliance, technician), `payments[]`, `ratings[]`, `complaints[]`, `warnings[]` (brand_only route, or an open job already exists for this appliance)", example: { household_id: "hh_priya", appliance_id: "app_priya_ac", technician_id: "tech_ramesh", service_type: "gas_top_up", issue: "AC not cooling", urgent: true } },
  job_get: { returns: "`job`, `payments[]`, `ratings[]`, `complaints[]`", example: { job_id: "job_priya_ac_gas_2025" } },
  job_update: { returns: "same as job_get", example: { job_id: "job_…", fields: { state: "slot_confirmed", confirmed_slot: "2026-10-03T17:00:00+05:30" } } },
  jobs_open_for_party: { returns: "`type`, `phone`, `household_id` or `technician_id`, `jobs[]` (urgent first, newest first)", example: { phone: "+919000000011" } },
  ledger_get_history: { returns: "`payments[]` (newest first, with technician_name), `summary` {count, confirmed_count, confirmed_total}", example: { household_id: "hh_priya", appliance_type: "ac" } },
  ledger_record_payment: { returns: "`payment`, `job_entries`, `job_confirmed_total`", example: { job_id: "job_…", parts: 350, labour: 300, total: 650, method: "janus", reported_by: "household", confirmed: true } },
  rating_save: { returns: "`rating`", example: { job_id: "job_…", on_time: true, fixed: true, fair_price: true, reachable: true } },
  complaint_create: { returns: "`complaint`", example: { job_id: "job_…", kind: "repeat_fault", description: "Stopped cooling after 3 days" } },
  complaint_update: { returns: "`complaint`", example: { complaint_id: "cmp_…", fields: { status: "resolved", resolution: "Free revisit done" } } },
  notification_log: { returns: "`notification`", example: { household_id: "hh_priya", member_id: "mem_rohan", kind: "job_update", body: "Ramesh confirmed 5 PM today" } },
  notification_list: { returns: "`notifications[]` (newest first, with member_name)", example: { household_id: "hh_priya" } },
  check_schedule: { returns: "`check`", example: { kind: "technician_reply", job_id: "job_…", due_in_minutes: 120, payload: { ask: "Has Ramesh replied?" } } },
  price_fairness_check: {
    returns:
      "`verdict` ('fair'|'slightly_high'|'high'|'low'|'insufficient_data'), `tier_used` ('household_history'|'society_average'|'reference_prices'|null), `expected_min`, `expected_max`, `last_paid`?, `last_paid_date`?, `difference_pct`, `explanation_en` (ready to paraphrase to the household), `compared` ('total'|'parts'|'labour' — which part decided), `components` {total?, parts?, labour?} each with amount/expected_min/expected_max/verdict/difference_pct, `alternative_service_types[]` (other jobs whose price range the bill fits), `known_service_types[]` (only when insufficient_data), `context` {inflation_buffer_pct, reference_range, reference_source, society_data_points}",
    example: { household_id: "hh_priya", appliance_type: "ac", service_type: "gas_top_up", total_amount: 900 },
  },
  scenario_set: { returns: "`scenario` {key, value, uses_left (null = until cleared)}, `affects` (which mock tool)", example: { key: "pinelabs.next_payout", value: "timeout", uses: 1 } },
  scenario_list: { returns: "`active[]` {key, value, uses_left, created_at}, `catalog` {key: {values[], description}}", example: {} },
  scenario_clear: { returns: "`cleared[]` (keys removed)", example: { key: "pinelabs.next_payout" } },
  reset_demo_data: { returns: "`reset: true`, `took_ms`", example: { confirm: "RESET" } },
  gnani_speech_to_text: {
    returns:
      "`text` (Gnani's transcript, unedited), `language_detected` (always null: Gnani doesn't report it), `confidence` (null; 0.31 only under the low_confidence switch), `empty`, `language_used`, `gnani_request_id`, `gnani_model`, `audio_bytes`, `took_ms`, `partner: \"Gnani\"`",
    example: { media_url: "https://api.twilio.com/2010-04-01/Accounts/AC…/Messages/MM…/Media/ME…", language_hint: "mr-IN" },
  },
  gnani_text_to_speech: {
    returns: "`audio_url` (public OGG/Opus link, send it as WhatsApp media), `content_type`, `bytes`, `language`, `voice`, `took_ms`, `partner: \"Gnani\"`",
    example: { text: "नमस्कार प्रिया, रमेश उद्या संध्याकाळी पाच वाजता येईल.", language: "mr-IN" },
  },
  validate_address: {
    returns: "Delhivery body: `quality`, `granularity_level`, `reason`, `formatted_address`, `corrections`, `request_id`, `req_id`. Errors: `HTTP 400 {error}`, `HTTP 504 {error, detail}`",
    example: { address: "flat 4b sai heights baner pune", req_id: "job-123" },
  },
  verify_address: {
    returns: "Delhivery body: validation fields + `is_verified`, `last_visited_date`, `verification_reasoning`, `request_id`, `req_id`",
    example: { address: "Flat 4B, Sai Heights, Baner, Pune 411045", months: 6 },
  },
  geocode_address: {
    returns: "Delhivery body: `req_id`, `lat`, `lng`, `error_radius` (m), `metadata.pincode` (lat/lng null when not found)",
    example: { address: "Flat 4B, Sai Heights, Baner, Pune 411045", req_id: "job-123" },
  },
  reverse_geocode: {
    returns: "Delhivery body: `status`, `req_id`, `data` {status ('OK'|'ZERO_RESULTS'), results[]} (Google geocoding format)",
    example: { req_id: "loc-1", lat: 18.5603, lng: 73.7812 },
  },
  compute_distance_matrix: {
    returns: "Delhivery body: `status`, `sources_to_targets[i][j]` = {distance (km), time (seconds), from_index, to_index}",
    example: { sources: [[18.5712, 73.7795]], targets: [[18.5603, 73.7812]], travel_mode: "motorcycle" },
  },
  auto_suggest: {
    returns: "Delhivery body: array of {entity_id, entity_name, display_text, full_address, shape, lat, long, entity_type, score} (may be empty)",
    example: { query: "sai heights", lat: 18.56, lng: 73.78 },
  },
  create_customer: { returns: "Pine Labs customer: `customer_id`, `merchant_customer_reference`, names, `mobile_number`, `status`, timestamps", example: { merchant_customer_reference: "hh_mehta", first_name: "Neha", last_name: "Mehta", mobile_number: "9000000031" } },
  create_ot_subscription: { returns: "`subscription_id`, `order_id`, `status: CREATED`, `execution_mode: DIRECT_EXECUTION`, `plan_details`, `start_date`, `end_date`", example: { merchant_subscription_reference: "job-123-otm", customer_id: "cust-v1-250901101500-aa-PRIYA1", plan_details: { amount: 250000, currency: "INR", validity_days: 30, description: "AC repair" } } },
  get_ot_subscription: { returns: "The One-Time Mandate with its current `status` (CREATED / ACTIVE / COMPLETED / CANCELLED / EXPIRED)", example: { subscription_id: "v1-sub-…" } },
  create_mandate_payment: { returns: "`data` {order_id, status (AUTHORIZED | FAILED), order_amount, payments[{id, status, payment_amount, error_detail?}]}", example: { order_id: "v1-…", payments: [{ merchant_payment_reference: "job-123-mandate", payment_method: "UPI", payment_amount: { value: 250000, currency: "INR" }, payment_option: { upi_details: { txn_mode: "INTENT" } }, mandate_info: { request_type: "CREATE_MANDATE" } }] } },
  create_presentation: { returns: "`presentation_id`, `subscription_id`, `amount`, `due_date`, `status: CREATED`, `merchant_presentation_reference`", example: { subscription_id: "v1-sub-…", amount: { value: 220000, currency: "INR" }, merchant_presentation_reference: "job-123-debit" } },
  get_presentation: { returns: "`presentation_id`, `status` (COMPLETED in the mock), `pdn_status`, `failure_count`, `amount`, `order_id`", example: { presentation_id: "v1-bil-…" } },
  cancel_subscription: { returns: "The subscription with `status: CANCELLED`", example: { subscription_id: "v1-sub-…" } },
  create_plan: { returns: "`plan_id`, `status`, `frequency`, `amount`, `max_limit_amount`, …", example: { plan_name: "Fridge AMC monthly", frequency: "Month", amount: { value: 30000, currency: "INR" }, max_limit_amount: { value: 40000, currency: "INR" }, end_date: "2027-10-01T00:00:00Z", merchant_plan_reference: "fridge-amc-monthly" } },
  create_subscription: { returns: "`subscription_id`, `order_id`, `status: CREATED`, `plan_details`, `order_amount` (use it in create_mandate_payment)", example: { merchant_subscription_reference: "priya-ro-amc", plan_id: "v1-pla-250901101600-aa-ROAMC1", customer_id: "cust-v1-250901101500-aa-PRIYA1", start_date: "2026-10-05T00:00:00Z", end_date: "2027-10-04T00:00:00Z", integration_mode: "SEAMLESS" } },
  get_subscription: { returns: "The UPI AutoPay subscription with `status` and `plan_details`", example: { subscription_id: "v1-sub-…" } },
  create_payout: { returns: "`clientReferenceId`, `paymentReferenceId`, `requestReferenceId`, `status` (SCHEDULED | PENDING = insufficient balance | FAILED), `message`, `amount`, `scheduledAt`, `_links`", example: { clientReferenceId: "job-123-payout", payeeName: "Ramesh Patil", vpa: "ramesh.cooling@okaxis", amount: { value: 120000, currency: "INR" }, mode: "UPI", remarks: "AC repair" } },
  get_payouts: { returns: "`payments[]` {status, message, bankTransactionReferenceId (UTR) when SUCCESS, amount, fees, tax, …}, `totalRecords`, `totalPages`, `nextPage`, `_links`", example: { clientReferenceId: "job-123-payout" } },
  get_payout_balance: { returns: "`accountNumber`, `branchCode`, `balance` {value (paise), currency}", example: {} },
  proof_of_presence: {
    returns: "`partner: \"Delhivery\"`, `present` (true | false | \"unknown\"), `distance_m`, `minutes_from_slot`, `location_age_minutes`, `reason` (at_household | too_far | no_location | stale_location | not_job_technician | household_not_geocoded), `explanation`, `technician`, `household_location`, `confirmed_slot`",
    example: { job_id: "job_…", technician_phone: "+919823562151", latitude: 18.5604, longitude: 73.7813, timestamp: "2026-10-03T17:05:00+05:30" },
  },
  technician_discovery: {
    returns: "`partner: \"Delhivery\"`, `count`, `technicians[]` {name, business_name, phone, skills, rating, address, distance_m, eta_minutes_motorcycle, already_known_technician_id, source}, `reason` (found | none_found), `nearest_outside_radius_m` + `hint` when none found",
    example: { appliance_type: "ac", latitude: 18.5603, longitude: 73.7812, radius_m: 3000 },
  },
  technician_identity_check: {
    returns: "`partner: \"Pine Labs\"`, `status` (verified | mismatch | not_found), `matched_fields[]`, `mismatched_fields[]`, `merchant` {display_name, city, onboarded_at}, `registered_name_hint` (masked, on mismatch), `checked_at`, `explanation`",
    example: { name: "Ramesh Patil", phone: "+919823562151", upi_id: "ramesh.cooling@okaxis" },
  },
  send_whatsapp: {
    returns: "`message_sid`, `status` (Twilio's, usually queued), `to`, `recipient` {name, type, household_id}, `notification_id` (auto-logged for household members; null for technicians), `sent_at` (ISO UTC), `partner`. Errors (all with `twilio_code`, plus `twilio_message`): RECIPIENT_UNKNOWN, NOT_JOINED_SANDBOX (63015), OUTSIDE_24H_WINDOW (63016), DAILY_LIMIT_REACHED (63038, never retried), TWILIO_RATE_LIMITED (429, after one retry 3.5 s later; `retried`), INVALID_PHONE, TWILIO_TIMEOUT, TWILIO_AUTH_FAILED, TWILIO_ERROR, TEST_NUMBER (test-suite phones +917000000…, never sent)",
    example: { to: "+918530921384", body: "Ramesh confirmed: he'll come today at 5 PM." },
  },
  make_call: {
    returns: "`call_sid`, `status`, `to`, `recipient`, `partner`. Errors: RECIPIENT_UNKNOWN, NO_VOICE_NUMBER, TWILIO_* as above",
    example: { to: "+919823562151", message: "Priya in Sai Heights, Baner needs her AC repaired. Please reply on WhatsApp if you can come.", language: "hi-IN" },
  },
  get_message_status: {
    returns: "`message_sid`, `status` (queued | sent | delivered | read | failed | undelivered), `error_code_twilio` (also as `twilio_error_code`), `error_hint` (when failed), `to`, `date_sent`, `partner`",
    example: { message_sid: "SM…" },
  },
  inbound_pending: {
    returns: "`count`, `messages[]` {event_id, from_phone, party {type: member (member_id, name, role, household_id, household_name, language) | technician (technician_id, name) | unknown}, text, media_url, media_type, latitude, longitude, received_at, twilio_message_sid, attempt}, `still_waiting`",
    example: { limit: 5 },
  },
  inbound_mark_done: {
    returns: "`event_id`, `status: done`, `already_done`, `outcome`, `handled_at`. Errors: EVENT_NOT_FOUND",
    example: { event_id: "evt_…", outcome: "replied; job job_… created for the AC" },
  },
  technician_proposed_time: {
    returns: "`decision` (confirmed | asked_household), `job_id`, `slot` (ISO UTC), `slot_ist` (e.g. \"Tomorrow 5 PM\"), `inside_availability`, `availability` (when asked), `checks_closed`, `messages_sent[]` {to_name, body, sent, error_code?}, `steps[]` {tool, connector, ok, status, error_code}. Errors: SLOT_UNPARSEABLE, TECHNICIAN_NOT_FOUND, NO_OPEN_JOB, INVALID_INPUT",
    example: { technician_phone: "+919823562151", slot_text: "I can come tomorrow at 5 pm", received_at: "2026-10-04T15:30:00+05:30" },
  },
  technician_location_update: {
    returns: "`decision` (arrived | on_the_way | eta_unavailable), `job_id`, `distance_m` (arrived), `eta_minutes` + `distance_km` (on_the_way), `presence` (reason), `messages_sent[]`, `steps[]`. Errors: TECHNICIAN_NOT_FOUND, NO_OPEN_JOB",
    example: { technician_phone: "+919823562151", latitude: 18.5603, longitude: 73.7812, received_at: "2026-10-05T17:02:00+05:30" },
  },
  bill_reported: {
    returns: "`decision` (fair | slightly_high | high | low | insufficient_data), `job_id`, `amount`, `expected_min`, `expected_max`, `difference_pct`, `alternative_service_types[]`, `messages_sent[]`, `steps[]`. Errors: HOUSEHOLD_NOT_FOUND, NO_OPEN_JOB, MISSING_APPLIANCE",
    example: { household_phone: "+918530921384", amount: 900, service_type: "gas_top_up" },
  },
  pay_through_janus: {
    returns: "`outcome` (paid | on_hold | declined | failed | unknown), `job_id`, `amount`, `references` {mandate, mandate_payment, debit, payout}, `payout_status`, `payment_reference`, `reason` (failed/unknown), `messages_sent[]`, `steps[]`. Errors: SPEND_LIMIT_EXCEEDED (decider already asked; carries messages_sent), ALREADY_PAID, NOTHING_TO_PAY, NO_TECHNICIAN, NO_TECHNICIAN_UPI, NO_PINE_LABS_CUSTOMER, HOUSEHOLD_NOT_FOUND",
    example: { household_phone: "+918530921384" },
  },
  assign_alternate_technician: {
    returns: "`decision` (contacted | not_verified), `job_id`, `technician` {id, name} (contacted), `identity_status` (not_verified), `checks_closed`, `messages_sent[]`, `steps[]`. Errors: HOUSEHOLD_NOT_FOUND, NO_OPEN_JOB, TECHNICIAN_NOT_FOUND",
    example: { household_phone: "+918530921384", technician_name: "Anil" },
  },
  checks_due: { returns: "`now`, `count`, `checks[]` (with job_state, technician_id)", example: {} },
  check_done: { returns: "`check`", example: { check_id: "chk_…", outcome: "Ramesh replied, slot 5 PM" } },
};

function typeOf(s: JsonSchema): string {
  if (s.anyOf) return s.anyOf.map(typeOf).join(" \\| ");
  if (s.enum) return s.enum.map((v) => `\`${JSON.stringify(v)}\``).join(" \\| ");
  if (s.type === "array") return `${typeOf(s.items ?? {})}[]`;
  if (s.type === "object" && !s.properties) return "object";
  if (s.format === "date") return "date (YYYY-MM-DD)";
  if (s.format === "date-time") return "datetime (ISO, with offset)";
  if (s.type === "integer") return "integer";
  return Array.isArray(s.type) ? s.type.join(" \\| ") : (s.type ?? "any");
}

// Flatten nested objects into rows like `fields.state`.
function rows(schema: JsonSchema, prefix = "", parentRequired = true): string[] {
  const out: string[] = [];
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const key = prefix + name;
    const required = parentRequired && (schema.required ?? []).includes(name) && prop.default === undefined;
    const notes = [prop.description, prop.default !== undefined ? `default \`${JSON.stringify(prop.default)}\`` : ""]
      .filter(Boolean)
      .join("; ")
      .replace(/\|/g, "\\|");
    if (prop.type === "object" && prop.properties) {
      out.push(`| \`${key}\` | object | ${required ? "yes" : "no"} | ${notes || "Pass only the keys you want to change."} |`);
      out.push(...rows(prop, key + ".", false));
    } else {
      out.push(`| \`${key}\` | ${typeOf(prop)} | ${required ? "yes" : "no"} | ${notes} |`);
    }
  }
  return out;
}

async function listTools(base: string, path: string, key: string): Promise<Tool[]> {
  const res = await fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-api-key": key,
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  const json = JSON.parse(data ? data.slice(6) : text);
  if (!json.result) throw new Error(`tools/list failed (${res.status}): ${text.slice(0, 200)}`);
  return json.result.tools;
}

async function main() {
  const base = process.argv[2] ?? "http://localhost:3000";
  const key = process.env.MCP_API_KEY;
  if (!key) throw new Error("MCP_API_KEY is not set (.env.local)");

  const parts: string[] = [];
  const seen = new Set<string>();
  for (const [server, { path, connector, onlyNew }] of Object.entries(CONNECTORS)) {
    const all = await listTools(base, path, key);
    const tools = onlyNew ? all.filter((t) => !seen.has(t.name)) : all;
    for (const t of all) seen.add(t.name);
    parts.push(
      onlyNew
        ? `## Step tools — only on \`${connector}\` (${tools.length} tools; the combined connector has ${all.length})\n\nURL: \`https://janus-server.vercel.app${path}\` (server name \`${server}\`). See "Step tools" above.\n`
        : `## Connector \`${connector}\` — ${tools.length} tools\n\nURL: \`https://janus-server.vercel.app${path}\` (server name \`${server}\`)\n`,
    );
    for (const tool of tools) {
      const note = NOTES[tool.name];
      const inputRows = rows(tool.inputSchema);
      parts.push(
        [
          `### \`${tool.name}\``,
          "",
          tool.description ?? "",
          "",
          inputRows.length ? ["| Input | Type | Required | Notes |", "| --- | --- | --- | --- |", ...inputRows].join("\n") : "_No inputs._",
          "",
          `**Returns** (besides \`ok: true\`): ${note?.returns ?? "_not documented yet_"}`,
          "",
          "Example:",
          "```json",
          JSON.stringify({ tool: tool.name, arguments: note?.example ?? {} }),
          "```",
          "",
        ].join("\n"),
      );
    }
    const undocumented = tools.filter((t) => !NOTES[t.name]).map((t) => t.name);
    if (undocumented.length) console.warn(`No NOTES entry for: ${undocumented.join(", ")}`);
  }

  const file = "TOOLS.md";
  const doc = readFileSync(file, "utf8");
  const start = "<!-- TOOLS:START (generated by `npm run docs:tools`, do not edit by hand) -->";
  const end = "<!-- TOOLS:END -->";
  const before = doc.slice(0, doc.indexOf(start));
  const after = doc.slice(doc.indexOf(end) + end.length);
  if (doc.indexOf(start) < 0 || doc.indexOf(end) < 0) throw new Error("TOOLS.md is missing the TOOLS:START / TOOLS:END markers");
  writeFileSync(file, `${before}${start}\n\n${parts.join("\n")}\n${end}${after}`);
  console.log(`Wrote ${file} from ${base}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
