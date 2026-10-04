// Part of tests/run-all.mjs (npm test). Run alone: node --env-file=.env.local tests/janus-combined.test.mjs [base-url]
// The combined /janus/mcp route must serve exactly the union of the per-group routes, unchanged.
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(path.join(process.cwd(), "package.json"));
const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

const base = process.argv[2] ?? "http://localhost:3000";
const key = process.env.MCP_API_KEY;
const ROUTES = { janus_core: "/janus-core/mcp", gnani: "/gnani/mcp", delhivery: "/delhivery/mcp", pinelabs: "/pinelabs/mcp", custom: "/custom/mcp", whatsapp: "/whatsapp/mcp" };
let passed = 0, failed = 0;
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log("PASS", label); }
  else { failed++; console.log("FAIL", label, "\n     ", JSON.stringify(detail).slice(0, 600)); }
};
async function rpc(route, method, params, withKey = true) {
  const res = await fetch(`${base}${route}`, { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(withKey ? { "x-api-key": key } : {}), "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (res.status !== 200) return { status: res.status, body: await res.text() };
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line.slice(6)).result;
}
const callText = async (route, name, args) => (await rpc(route, "tools/call", { name, arguments: args })).content[0].text;
const strip = (text, ...fields) => { try { const j = JSON.parse(text.replace(/^HTTP \d+: /, "")); for (const f of fields) delete j[f]; return JSON.stringify(j); } catch { return text; } };

// Auth and identity
const noKey = await rpc("/janus/mcp", "tools/list", {}, false);
check("no key -> 401 UNAUTHORIZED", noKey.status === 401 && noKey.body.includes("UNAUTHORIZED"), noKey);
const names = {};
for (const [group, route] of Object.entries({ janus: "/janus/mcp", ...ROUTES })) {
  names[group] = (await rpc(route, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).serverInfo?.name;
}
console.log("      serverInfo names:", JSON.stringify(names));
check("/janus/mcp reports serverInfo.name 'janus'", names.janus === "janus", names);
check("all 7 routes report distinct serverInfo names", new Set(Object.values(names)).size === 7, names);

// tools/list: exact union, unchanged
const combined = (await rpc("/janus/mcp", "tools/list", {})).tools;
const byName = new Map(combined.map((t) => [t.name, t]));
check(`combined tools/list has ${combined.length} tools, no duplicate names`, byName.size === combined.length, combined.map((t) => t.name));
let expected = 0, identical = 0;
const differences = [];
for (const [group, route] of Object.entries(ROUTES)) {
  const tools = (await rpc(route, "tools/list", {})).tools;
  expected += tools.length;
  for (const t of tools) {
    const c = byName.get(t.name);
    if (c && c.description === t.description && JSON.stringify(c.inputSchema) === JSON.stringify(t.inputSchema)) identical++;
    else differences.push(`${group}:${t.name}`);
  }
}
console.log(`      union expected ${expected}, combined ${combined.length}`);
check(`combined = union of the 6 routes (${expected} tools)`, combined.length === expected, { expected, got: combined.length });
check("every tool's description and input schema are byte-identical to its own route", identical === expected && differences.length === 0, differences);
check("ping and the scenario/reset tools appear exactly once", ["ping", "scenario_set", "scenario_list", "scenario_clear", "reset_demo_data"].every((n) => combined.filter((t) => t.name === n).length === 1));

// Same results through both routes (one tool per group)
const same = async (label, group, name, args, ...volatile) => {
  const a = strip(await callText(ROUTES[group], name, args), ...volatile);
  const b = strip(await callText("/janus/mcp", name, args), ...volatile);
  check(`${label}: same answer via /janus/mcp and ${ROUTES[group]}`, a === b, { own_route: a.slice(0, 200), combined: b.slice(0, 200) });
  return JSON.parse(b.replace(/^HTTP \d+: /, ""));
};
let r = await same("janus_core get_party_by_phone", "janus_core", "get_party_by_phone", { phone: "+918530921384" });
check("  ...is hh_priya", r.household_id === "hh_priya", r);
r = await same("janus_core price_fairness_check", "janus_core", "price_fairness_check", { household_id: "hh_priya", appliance_type: "ac", service_type: "gas_top_up", total_amount: 900 });
check("  ...verdict high", r.verdict === "high", r);
r = await same("delhivery validate_address (partner format)", "delhivery", "validate_address", { address: "flat 4b sai heights baner pune" }, "request_id");
check("  ...Delhivery body, not {ok}", r.quality === "ok" && r.granularity_level === "PREMISE" && r.ok === undefined, r);
const err = await callText("/janus/mcp", "compute_distance_matrix", { sources: [[51.5, -0.12]], targets: [[18.56, 73.78]] });
check("  Delhivery errors keep 'HTTP 400:' prefix via /janus/mcp", err.startsWith("HTTP 400: ") && err.includes("outside India"), err);
r = await same("pinelabs get_payout_balance (partner format)", "pinelabs", "get_payout_balance", {});
check("  ...balance in paise", typeof r.balance?.value === "number" && r.ok === undefined, r);
r = await same("custom technician_identity_check", "custom", "technician_identity_check", { name: "Ramesh", phone: "+919823562151" }, "checked_at");
check("  ...verified", r.status === "verified", r);
r = await same("whatsapp guard", "whatsapp", "send_whatsapp", { to: "+919812345678", body: "hi" });
check("  ...RECIPIENT_UNKNOWN (no message sent)", r.error_code === "RECIPIENT_UNKNOWN", r);
const tts = JSON.parse(await callText("/janus/mcp", "gnani_text_to_speech", { text: "नमस्कार प्रिया", language: "mr-IN" }));
check("gnani_text_to_speech via /janus/mcp (real Gnani)", tts.ok && tts.voice === "Zahira" && tts.audio_url, tts);

// Failure switches work through the combined route
await callText("/janus/mcp", "scenario_set", { key: "whatsapp.next_send", value: "not_joined" });
r = JSON.parse(await callText("/janus/mcp", "send_whatsapp", { to: "+918530921384", body: "switch test" }));
check("switch set via /janus/mcp affects send_whatsapp via /janus/mcp (no real send)", r.error_code === "NOT_JOINED_SANDBOX" && r.simulated, r);
await callText("/janus/mcp", "scenario_set", { key: "pinelabs.next_payout", value: "insufficient_balance" });
r = JSON.parse(await callText("/janus/mcp", "create_payout", { clientReferenceId: `combined-${Date.now()}`, payeeName: "Ramesh Patil", vpa: "ramesh.cooling@okaxis", amount: { value: 1000, currency: "INR" }, mode: "UPI", remarks: "test" }));
check("Pine Labs switch via /janus/mcp -> PENDING", r.status === "PENDING", r);

// Call log labels each call with its group
await new Promise((res) => setTimeout(res, 2500));
const [logged] = await sql`SELECT connector FROM ops.tool_calls WHERE tool = ${"validate_address"} ORDER BY at DESC LIMIT 1`;
check("call log labels a /janus/mcp Delhivery call as 'delhivery'", logged?.connector === "delhivery", logged);
const [logged2] = await sql`SELECT connector FROM ops.tool_calls WHERE tool = ${"create_payout"} ORDER BY at DESC LIMIT 1`;
check("call log labels a /janus/mcp Pine Labs call as 'pinelabs'", logged2?.connector === "pinelabs", logged2);

// reset_demo_data needs the SQL files shipped with /janus/mcp
r = JSON.parse(await callText("/janus/mcp", "reset_demo_data", { confirm: "RESET" }));
check(`reset_demo_data via /janus/mcp works (${r.took_ms} ms)`, r.ok && r.reset, r);

console.log(`\nCombined /janus/mcp: ${combined.length} tools`);
console.log(`${passed} passed, ${failed} failed`);
