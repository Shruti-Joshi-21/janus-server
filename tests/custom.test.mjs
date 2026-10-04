// Part of tests/run-all.mjs (npm test). Run alone: node --env-file=.env.local tests/custom.test.mjs [base-url]
const base = process.argv[2] ?? "http://localhost:3000";
const key = process.env.MCP_API_KEY;
let passed = 0, failed = 0;
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log("PASS", label); }
  else { failed++; console.log("FAIL", label, "\n     ", JSON.stringify(detail).slice(0, 600)); }
};
async function rpc(path, method, params) {
  const res = await fetch(`${base}${path}`, { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": key, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line.slice(6)).result;
}
const custom = async (name, args) => (await rpc("/custom/mcp", "tools/call", { name, arguments: args })).structuredContent;
const core = async (name, args) => (await rpc("/janus-core/mcp", "tools/call", { name, arguments: args })).structuredContent;
const RAMESH = "+918369502720", SURESH = "+918308407020";
const JOB = "job_priya_ac_gas_2025"; // Priya's AC job with Ramesh (seeded)
const nowIso = () => new Date().toISOString();
const minsAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

const list = await rpc("/custom/mcp", "tools/list", {});
check("3 custom tools", list.tools.map((t) => t.name).sort().join() === "proof_of_presence,technician_discovery,technician_identity_check", list.tools.map((t) => t.name));

// proof_of_presence
let r = await custom("proof_of_presence", { job_id: JOB, technician_phone: RAMESH, latitude: 18.5604, longitude: 73.7813, timestamp: nowIso() });
console.log("      ", r.explanation);
check("Ramesh at Sai Heights -> present true, ~15 m, partner Delhivery", r.ok && r.present === true && r.distance_m < 50 && r.partner === "Delhivery" && typeof r.minutes_from_slot === "number", r);
r = await custom("proof_of_presence", { job_id: JOB, technician_phone: "83695 02720", latitude: 18.5712, longitude: 73.7795, timestamp: nowIso() });
console.log("      ", r.explanation);
check("Ramesh at his shop (Balewadi) -> present false, ~1.2 km", r.present === false && r.distance_m > 1000 && r.distance_m < 1500 && r.reason === "too_far", r);
r = await custom("proof_of_presence", { job_id: JOB, technician_phone: RAMESH, timestamp: nowIso() });
check("no location shared -> unknown / no_location", r.present === "unknown" && r.reason === "no_location", r);
r = await custom("proof_of_presence", { job_id: JOB, technician_phone: RAMESH, latitude: 18.5604, longitude: 73.7813, timestamp: minsAgo(40) });
check("location 40 min old -> unknown / stale_location", r.present === "unknown" && r.reason === "stale_location" && r.location_age_minutes >= 39, r);
r = await custom("proof_of_presence", { job_id: JOB, technician_phone: SURESH, latitude: 18.5604, longitude: 73.7813, timestamp: nowIso() });
check("Suresh for Ramesh's job -> unknown / not_job_technician", r.present === "unknown" && r.reason === "not_job_technician", r);
r = await custom("proof_of_presence", { job_id: "job_nope", technician_phone: RAMESH, latitude: 18.56, longitude: 73.78, timestamp: nowIso() });
check("unknown job -> JOB_NOT_FOUND", r.error_code === "JOB_NOT_FOUND", r);

// technician_discovery (from Priya's home)
r = await custom("technician_discovery", { appliance_type: "ac", latitude: 18.5603, longitude: 73.7812, radius_m: 3000 });
console.log("      ", r.technicians?.map((t) => `${t.business_name} ${t.distance_m} m, ${t.eta_minutes_motorcycle} min`).join(" | "));
check("AC near Sai Heights -> 2 businesses, nearest first, delhivery_poi", r.ok && r.count === 2 && r.technicians[0].distance_m < r.technicians[1].distance_m && r.technicians.every((t) => t.source === "delhivery_poi") && r.partner === "Delhivery", r);
r = await custom("technician_discovery", { appliance_type: "ro_purifier", latitude: 18.5603, longitude: 73.7812, radius_m: 1000 });
check("RO within 1 km -> none_found + hint about nearest", r.count === 0 && r.reason === "none_found" && r.nearest_outside_radius_m > 1000, r);
r = await custom("technician_discovery", { appliance_type: "geyser", latitude: 18.5603, longitude: 73.7812, radius_m: 25000 });
check("geyser -> none_found, no hint (nobody fixes it)", r.count === 0 && r.nearest_outside_radius_m === undefined, r);

// technician_identity_check
r = await custom("technician_identity_check", { name: "Ramesh Patil", phone: RAMESH, upi_id: "ramesh.cooling@okaxis" });
check("Ramesh full name + UPI -> verified, phone/name/upi matched, partner Pine Labs", r.status === "verified" && r.matched_fields.join() === "phone,name,upi_id" && r.partner === "Pine Labs" && r.checked_at, r);
r = await custom("technician_identity_check", { name: "Ramesh", phone: RAMESH });
check("first name only -> verified", r.status === "verified", r);
r = await custom("technician_identity_check", { name: "Ramesh Patil", phone: RAMESH, upi_id: "someone@ybl" });
check("wrong UPI -> mismatch on upi_id", r.status === "mismatch" && r.mismatched_fields.join() === "upi_id", r);
r = await custom("technician_identity_check", { name: "Santosh Jadhav", phone: "+919000000023" });
console.log("      ", r.explanation);
check("Santosh's phone registered to someone else -> mismatch, masked name only", r.status === "mismatch" && r.registered_name_hint === "S**** J*****" && !JSON.stringify(r).includes("Sunil"), r);
r = await custom("technician_identity_check", { name: "Anil Kale", phone: "+919823562151", upi_id: "anil.kale@okicici" });
check("Anil (Samiksha's number) -> verified, phone/name/upi matched", r.status === "verified" && r.matched_fields.join() === "phone,name,upi_id", r);
r = await custom("technician_identity_check", { name: "Vikas Shinde", phone: "+919000000022" });
check("Vikas -> not_found (not a Pine Labs merchant)", r.status === "not_found", r);

// failure switches
await core("scenario_set", { key: "custom.next_presence", value: "not_present" });
r = await custom("proof_of_presence", { job_id: JOB, technician_phone: RAMESH, latitude: 18.5604, longitude: 73.7813, timestamp: nowIso() });
check("switch not_present -> false even at the door", r.present === false && r.simulated, r);
await core("scenario_set", { key: "custom.next_presence", value: "stale_location" });
r = await custom("proof_of_presence", { job_id: JOB, technician_phone: RAMESH, latitude: 18.5604, longitude: 73.7813, timestamp: nowIso() });
check("switch stale_location", r.reason === "stale_location", r);
await core("scenario_set", { key: "custom.next_discovery", value: "none_found" });
r = await custom("technician_discovery", { appliance_type: "ac", latitude: 18.5603, longitude: 73.7812 });
check("switch none_found", r.count === 0 && r.simulated, r);
await core("scenario_set", { key: "custom.next_identity", value: "mismatch" });
r = await custom("technician_identity_check", { name: "Ramesh Patil", phone: RAMESH });
check("switch mismatch -> Ramesh comes back mismatch", r.status === "mismatch" && r.simulated, r);
await core("scenario_set", { key: "custom.next_identity", value: "timeout" });
let t0 = Date.now();
r = await custom("technician_identity_check", { name: "Ramesh Patil", phone: RAMESH });
check(`switch timeout -> TIMEOUT after ${Date.now() - t0} ms`, r.error_code === "TIMEOUT" && r.partner === "Pine Labs" && Date.now() - t0 < 10000, r);
r = await custom("technician_identity_check", { name: "Ramesh Patil", phone: RAMESH });
check("switch used up -> verified again", r.status === "verified", r);

console.log(`\n${passed} passed, ${failed} failed`);
