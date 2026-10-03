// Part of tests/run-all.mjs (npm test). Run alone: node --env-file=.env.local tests/whatsapp.test.mjs [base-url]
// These checks NEVER send a real message: every case stops before Twilio (guard, input checks, failure switches).
// For a real end-to-end send use: npm run send:test -- <phone> "<text>"
const base = process.argv[2] ?? "http://localhost:3000";
const key = process.env.MCP_API_KEY;
const isLocal = base.includes("localhost");
let passed = 0, failed = 0;
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log("PASS", label); }
  else { failed++; console.log("FAIL", label, "\n     ", JSON.stringify(detail).slice(0, 500)); }
};
async function rpc(path, method, params, withKey = true) {
  const res = await fetch(`${base}${path}`, { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(withKey ? { "x-api-key": key } : {}), "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (res.status !== 200) return { status: res.status };
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line.slice(6)).result;
}
const wa = async (name, args) => (await rpc("/whatsapp/mcp", "tools/call", { name, arguments: args })).structuredContent;
const core = async (name, args) => (await rpc("/janus-core/mcp", "tools/call", { name, arguments: args })).structuredContent;
const PRIYA = "+918530921384";
const STRANGER = "+919812345678";

check("no key -> 401", (await rpc("/whatsapp/mcp", "tools/list", {}, false)).status === 401);
const list = await rpc("/whatsapp/mcp", "tools/list", {});
check("3 tools: send_whatsapp, make_call, get_message_status", list.tools?.map((t) => t.name).sort().join() === "get_message_status,make_call,send_whatsapp", list);

// Guard and input checks (all stop before Twilio)
let r = await wa("send_whatsapp", { to: STRANGER, body: "hello" });
check("stranger's number -> RECIPIENT_UNKNOWN", r.error_code === "RECIPIENT_UNKNOWN", r);
r = await wa("send_whatsapp", { to: "12", body: "hello" });
check("bad phone -> INVALID_INPUT/INVALID_PHONE", ["INVALID_INPUT", "INVALID_PHONE"].includes(r.error_code), r);
r = await wa("send_whatsapp", { to: "abcdefg", body: "hello" });
check("unparseable phone -> INVALID_PHONE", r.error_code === "INVALID_PHONE", r);
r = await wa("send_whatsapp", { to: PRIYA });
check("no body and no media -> INVALID_INPUT", r.error_code === "INVALID_INPUT", r);
r = await wa("send_whatsapp", { to: PRIYA, body: "x".repeat(1601) });
check("body over 1,600 chars -> INVALID_INPUT", r.error_code === "INVALID_INPUT", r);
r = await wa("send_whatsapp", { to: PRIYA, media_url: "http://example.com/a.ogg" });
check("non-https media_url -> INVALID_INPUT", r.error_code === "INVALID_INPUT", r);
r = await wa("make_call", { to: STRANGER, message: "hello" });
check("make_call to a stranger -> RECIPIENT_UNKNOWN", r.error_code === "RECIPIENT_UNKNOWN", r);
r = await wa("make_call", { to: PRIYA, message: "x".repeat(501) });
check("call message over 500 chars -> INVALID_INPUT", r.error_code === "INVALID_INPUT", r);
r = await wa("make_call", { to: PRIYA, message: "hello", language: "mr-IN" });
check("call language other than en-IN/hi-IN -> INVALID_INPUT", r.error_code === "INVALID_INPUT", r);
r = await wa("get_message_status", { message_sid: "not-a-sid" });
check("bad message_sid -> INVALID_INPUT", r.error_code === "INVALID_INPUT", r);
if (isLocal && !process.env.TWILIO_VOICE_FROM) {
  r = await wa("make_call", { to: PRIYA, message: "hello" });
  check("no voice number configured -> NO_VOICE_NUMBER", r.error_code === "NO_VOICE_NUMBER", r);
}

// Failure switches (answer without calling Twilio)
r = await core("scenario_set", { key: "whatsapp.next_send", value: "not_joined" });
check("whatsapp.next_send is in the switch catalogue", r.ok, r);
r = await wa("send_whatsapp", { to: PRIYA, body: "switch test" });
check("switch not_joined -> NOT_JOINED_SANDBOX with join instructions", r.error_code === "NOT_JOINED_SANDBOX" && r.simulated && r.message.includes("+1 415 523 8886"), r);
await core("scenario_set", { key: "whatsapp.next_send", value: "outside_window" });
r = await wa("send_whatsapp", { to: PRIYA, body: "switch test" });
check("switch outside_window -> OUTSIDE_24H_WINDOW", r.error_code === "OUTSIDE_24H_WINDOW" && r.simulated, r);
await core("scenario_set", { key: "whatsapp.next_send", value: "failed" });
r = await wa("send_whatsapp", { to: PRIYA, body: "switch test" });
check("switch failed -> TWILIO_ERROR with twilio_code", r.error_code === "TWILIO_ERROR" && r.twilio_code === 30008 && r.simulated, r);
await core("scenario_set", { key: "whatsapp.next_send", value: "timeout" });
const t0 = Date.now();
r = await wa("send_whatsapp", { to: PRIYA, body: "switch test" });
check(`switch timeout -> TWILIO_TIMEOUT after ${Date.now() - t0} ms (< 10000)`, r.error_code === "TWILIO_TIMEOUT" && r.simulated && Date.now() - t0 < 10000, r);
r = await wa("send_whatsapp", { to: STRANGER, body: "after switches" });
check("switches used up; guard still applies", r.error_code === "RECIPIENT_UNKNOWN", r);
r = await core("scenario_list", {});
check("no whatsapp switch left on", !r.active.some((s) => s.key === "whatsapp.next_send"), r.active);

console.log(`\n${passed} passed, ${failed} failed`);
