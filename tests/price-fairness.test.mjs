// Part of tests/run-all.mjs (npm test). Run alone: node --env-file=.env.local tests/price-fairness.test.mjs [base-url]
const base = process.argv[2] ?? "http://localhost:3000";
const key = process.env.MCP_API_KEY;
let passed = 0, failed = 0;
async function check(label, args, test) {
  const res = await fetch(`${base}/janus-core/mcp`, { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": key, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "price_fairness_check", arguments: { household_id: "hh_priya", ...args } } }) });
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  const r = JSON.parse(line.slice(6)).result.structuredContent;
  const ok = test(r);
  ok ? passed++ : failed++;
  console.log(ok ? "PASS" : "FAIL", label, `→ ${r.verdict ?? r.error_code} [${r.tier_used ?? ""}] ${r.expected_min ?? ""}–${r.expected_max ?? ""} (${r.difference_pct ?? ""}%)`);
  console.log("      ", r.explanation_en ?? r.message);
  return r;
}

await check("AC top-up ₹650 vs Priya's ₹600 last year", { appliance_type: "ac", service_type: "gas_top_up", total_amount: 650 },
  (r) => r.verdict === "fair" && r.tier_used === "household_history" && r.last_paid === 600);
await check("AC top-up ₹700 (a little more)", { appliance_type: "ac", service_type: "gas_top_up", total_amount: 700 },
  (r) => r.verdict === "slightly_high");
await check("AC top-up ₹900 (Ramesh overcharges)", { appliance_type: "ac", service_type: "gas_top_up", total_amount: 900 },
  (r) => r.verdict === "high");
await check("₹1,500 called a top-up → hints full_gas_charge", { appliance_type: "ac", service_type: "gas_top_up", total_amount: 1500 },
  (r) => r.verdict === "high" && r.alternative_service_types.some((x) => x.service_type === "full_gas_charge"));
await check("Honest full gas charge ₹2,000 (reference tier)", { appliance_type: "ac", service_type: "full_gas_charge", total_amount: 2000 },
  (r) => r.verdict === "fair" && r.tier_used === "reference_prices");
const soc = await check("RO filters ₹1,500 → society average (3 neighbours)", { appliance_type: "ro_purifier", service_type: "filter_replacement", total_amount: 1500 },
  (r) => r.verdict === "fair" && r.tier_used === "society_average");
const leak = /1,?350|1,?650|Mehta|Kulkarni|Deshpande/.test(JSON.stringify(soc));
leak ? failed++ : passed++;
console.log(leak ? "FAIL" : "PASS", "society answer reveals no neighbour names or amounts");
await check("Fridge repair: labour ₹400 vs ₹250 last time → labour decides", { appliance_type: "fridge", service_type: "wiring_repair", parts_amount: 100, labour_amount: 400, total_amount: 500 },
  (r) => r.compared === "labour" && r.verdict === "high" && r.components.parts?.verdict === "fair");
await check("Fridge gas ₹550 (way below ₹850–1,800) → low", { appliance_type: "fridge", service_type: "gas_refill", total_amount: 550 },
  (r) => r.verdict === "low" && r.tier_used === "reference_prices");
await check("Unknown job → insufficient_data", { appliance_type: "washing_machine", service_type: "drum_repair", total_amount: 2000 },
  (r) => r.verdict === "insufficient_data");
await check("Old name 'gas_refill' for AC → insufficient + lists known types", { appliance_type: "ac", service_type: "gas_refill", total_amount: 800 },
  (r) => r.verdict === "insufficient_data" && r.known_service_types.includes("gas_top_up"));
await check("parts + labour ≠ total → TOTAL_MISMATCH", { appliance_type: "ac", service_type: "gas_top_up", parts_amount: 100, labour_amount: 100, total_amount: 650 },
  (r) => r.error_code === "TOTAL_MISMATCH");
await check("Unknown household → HOUSEHOLD_NOT_FOUND", { household_id: "hh_nope", appliance_type: "ac", service_type: "gas_top_up", total_amount: 650 },
  (r) => r.error_code === "HOUSEHOLD_NOT_FOUND");
await check("AC PCB ₹7,500 (the interview overcharge) → high", { appliance_type: "ac", service_type: "pcb_replacement", total_amount: 7500 },
  (r) => r.verdict === "high" && r.tier_used === "reference_prices" && r.context.reference_note?.includes("7,500"));
await check("AC general service ₹649 → fair, shows starting-price note", { appliance_type: "ac", service_type: "general_service", total_amount: 649 },
  (r) => r.verdict === "fair" && r.explanation_en.includes("Starting prices"));
await check("Geyser heating element → insufficient (not found online)", { appliance_type: "geyser", service_type: "heating_element_replacement", total_amount: 900 },
  (r) => r.verdict === "insufficient_data" && r.known_service_types.includes("visit_checkup"));
console.log(`\n${passed} passed, ${failed} failed`);
