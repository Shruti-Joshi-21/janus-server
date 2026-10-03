// Part of tests/run-all.mjs (npm test). Run alone: node --env-file=.env.local tests/null-optional.test.mjs [base-url]
// Real tools through /janus/mcp, sending null for optional fields exactly like AgenticOrg does.
// No real WhatsApp message is sent (stranger guard / failure switch stop before Twilio).
const base = process.argv[2] ?? "http://localhost:3000";
const key = process.env.MCP_API_KEY;
let passed = 0, failed = 0;
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log("PASS", label); }
  else { failed++; console.log("FAIL", label, "\n     ", JSON.stringify(detail).slice(0, 500)); }
};
async function call(name, args) {
  const res = await fetch(`${base}/janus/mcp`, { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": key, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  const result = JSON.parse(line.slice(6)).result;
  const text = result.content[0].text;
  try { return JSON.parse(text.replace(/^HTTP \d+: /, "")); } catch { return { raw: text }; }
}

// The exact failure Aarya hit: send_whatsapp with media_url: null
let r = await call("send_whatsapp", { to: "+919812345678", body: "Test from Janus", media_url: null });
check("send_whatsapp {body, media_url: null} passes validation (reaches the guard)", r.error_code === "RECIPIENT_UNKNOWN", r);
await call("scenario_set", { key: "whatsapp.next_send", value: "not_joined", uses: 1 });
r = await call("send_whatsapp", { to: "+918530921384", body: "Test from Janus", media_url: null });
check("send_whatsapp to Priya with media_url: null gets past validation to the send step (switch answers, no real send)", r.error_code === "NOT_JOINED_SANDBOX" && r.simulated, r);

// Other tools, other kinds of fields
r = await call("ledger_get_history", { household_id: "hh_priya", appliance_type: null, technician_id: null });
check("janus_core: optional filters null -> ok, all of Priya's payments", r.ok && r.payments.length >= 2, r);
r = await call("inbound_pending", { limit: null });
check("field with a default: limit null -> default used", r.ok && typeof r.count === "number", r);
r = await call("get_party_by_phone", { phone: null });
check("required field null still -> INVALID_INPUT", r.error_code === "INVALID_INPUT", r);
r = await call("geocode_address", { address: "flat 4b sai heights baner", req_id: null });
check("Delhivery: req_id is nullable by spec -> kept, echoed back as null", r.req_id === null && r.lat === 18.5603, r);
r = await call("reverse_geocode", { req_id: "R-1", lat: null, lng: 73.78 });
check("Delhivery: required lat null still -> 400 validation error", r.error === "validation error", r);
r = await call("technician_discovery", { appliance_type: "ac", latitude: 18.5603, longitude: 73.7812, radius_m: null });
check("custom: radius_m null -> default 3 km", r.ok && r.radius_m === 3000 && r.count === 2, r);
r = await call("create_ot_subscription", { merchant_subscription_reference: `null-test-${Date.now()}`, customer_id: "cust-v1-250901101500-aa-PRIYA1", plan_details: { amount: 50000, validity_days: 7, description: null }, callback_url: null, merchant_metadata: null });
check("Pine Labs: nested plan_details.description null and top-level optionals null -> created", r.status === "CREATED" && r.plan_details.description === null, r);

console.log(`\n${passed} passed, ${failed} failed`);
