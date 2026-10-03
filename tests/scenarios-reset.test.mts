// Part of tests/run-all.mjs (npm test). Run alone: npx tsx --env-file=.env.local tests/scenarios-reset.test.mts [base-url]
import { takeScenario } from "../lib/scenarios.ts";

const base = process.argv[2] ?? "http://localhost:3000";
const key = process.env.MCP_API_KEY!;
let passed = 0, failed = 0;
const check = (label: string, cond: unknown, detail?: unknown) => {
  if (cond) { passed++; console.log("PASS", label); }
  else { failed++; console.log("FAIL", label, "\n     ", JSON.stringify(detail).slice(0, 500)); }
};
async function call(name: string, args: Record<string, unknown>) {
  const res = await fetch(`${base}/janus-core/mcp`, { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": key, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "))!;
  return JSON.parse(line.slice(6)).result.structuredContent;
}

for (let i = 0; i < 60; i++) { try { await fetch(`${base}/api/health`); break; } catch { await new Promise((r) => setTimeout(r, 2000)); } }

let r = await call("scenario_set", { key: "pinelab.next_payot", value: "timeout" });
check("typo key -> UNKNOWN_SCENARIO with known_keys", r.error_code === "UNKNOWN_SCENARIO" && r.known_keys.includes("pinelabs.next_payout"), r);
r = await call("scenario_set", { key: "pinelabs.next_payout", value: "explode" });
check("bad value -> INVALID_SCENARIO_VALUE with allowed_values", r.error_code === "INVALID_SCENARIO_VALUE" && r.allowed_values.includes("timeout"), r);
r = await call("scenario_set", { key: "pinelabs.next_payout", value: "timeout", uses: 2 });
check("set payout timeout x2", r.scenario?.uses_left === 2, r);
r = await call("scenario_set", { key: "custom.next_identity", value: "mismatch", uses: 0 });
check("set identity mismatch until cleared (uses 0 -> null)", r.scenario?.uses_left === null, r);
r = await call("scenario_list", {});
check("list shows both + catalog", r.active.length === 2 && r.catalog["gnani.next_stt"], r);

check("mock call 1 gets timeout", (await takeScenario("pinelabs.next_payout")) === "timeout");
check("mock call 2 gets timeout", (await takeScenario("pinelabs.next_payout")) === "timeout");
check("mock call 3 is normal (switch used up)", (await takeScenario("pinelabs.next_payout")) === null);
check("'until cleared' switch keeps firing", (await takeScenario("custom.next_identity")) === "mismatch" && (await takeScenario("custom.next_identity")) === "mismatch");
check("unset key -> null", (await takeScenario("delhivery.next_matrix")) === null);
r = await call("scenario_list", {});
check("used-up switch removed from list", r.active.length === 1 && r.active[0].key === "custom.next_identity", r.active);
r = await call("scenario_clear", { key: "custom.next_identity" });
check("clear one", r.cleared.length === 1, r);
await call("scenario_set", { key: "gnani.next_stt", value: "low_confidence" });
await call("scenario_set", { key: "delhivery.next_matrix", value: "malformed" });
r = await call("scenario_clear", {});
check("clear all", r.cleared.length === 2, r);

// Reset: refuses without confirmation, then really wipes test data.
const job = await call("job_create", { household_id: "hh_priya", appliance_id: "app_priya_ac", issue: "reset test" });
await call("scenario_set", { key: "pinelabs.next_payout", value: "failed" });
r = await call("reset_demo_data", { confirm: "yes" });
check("reset without RESET -> CONFIRMATION_REQUIRED", r.error_code === "CONFIRMATION_REQUIRED", r);
r = await call("job_get", { job_id: job.job.id });
check("...and nothing was wiped", r.ok === true, r);
r = await call("reset_demo_data", { confirm: "RESET" });
check(`reset with RESET works (took ${r.took_ms} ms, must be < 8000)`, r.reset === true && r.took_ms < 8000, r);
r = await call("job_get", { job_id: job.job.id });
check("test job is gone after reset", r.error_code === "JOB_NOT_FOUND", r);
r = await call("scenario_list", {});
check("switches are cleared by reset", r.active.length === 0, r.active);
r = await call("get_party_by_phone", { phone: "+918530921384" });
check("demo cast is back (Priya)", r.member?.name === "Priya", r);

console.log(`\n${passed} passed, ${failed} failed`);
