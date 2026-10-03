// Part of tests/run-all.mjs (npm test). Run alone: node --env-file=.env.local tests/delhivery.test.mjs [base-url]
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
// Returns { text, json (parsed or null), isError }
async function dl(name, args) {
  const r = await rpc("/delhivery/mcp", "tools/call", { name, arguments: args });
  const text = r.content[0].text;
  let json = null;
  try { json = JSON.parse(text.replace(/^HTTP \d+: /, "")); } catch {}
  return { text, json, isError: !!r.isError };
}
const core = async (name, args) => (await rpc("/janus-core/mcp", "tools/call", { name, arguments: args })).structuredContent;

const list = await rpc("/delhivery/mcp", "tools/list", {});
check("6 Delhivery tools with exact names", list.tools.map((t) => t.name).sort().join() === "auto_suggest,compute_distance_matrix,geocode_address,reverse_geocode,validate_address,verify_address", list.tools.map((t) => t.name));

let r = await dl("validate_address", { address: "flat 4b sai heights baner pune", req_id: "J-1" });
console.log("      ", r.json?.formatted_address, "|", r.json?.corrections);
check("validate Priya's flat -> ok / PREMISE / valid, req_id echoed", r.json?.quality === "ok" && r.json.granularity_level === "PREMISE" && r.json.reason === "valid" && r.json.formatted_address === "Flat 4B, Sai Heights, Baner Road, Baner, Pune, Maharashtra, 411045" && r.json.req_id === "J-1" && r.json.request_id, r.json);
check("only documented fields returned", Object.keys(r.json).sort().join() === "corrections,formatted_address,granularity_level,quality,reason,req_id,request_id", Object.keys(r.json));
r = await dl("validate_address", { address: "Sai Heights, Baner" });
check("no flat -> not_ok / STREET_LANDMARK / incomplete", r.json?.reason === "incomplete" && r.json.granularity_level === "STREET_LANDMARK" && r.json.quality === "not_ok", r.json);
r = await dl("validate_address", { address: "Flat 4B Sai Heights Baner 411001" });
check("wrong pincode -> correction_needed with <411001|411045>", r.json?.reason === "correction_needed" && r.json.corrections.includes("<411001|411045>"), r.json);
r = await dl("validate_address", { address: "Baner" });
check("locality only -> LOCALITY incomplete", r.json?.granularity_level === "LOCALITY" && r.json.reason === "incomplete", r.json);
r = await dl("validate_address", { address: "asdfgh qwerty" });
check("junk -> invalid_or_junk, empty formatted_address", r.json?.reason === "invalid_or_junk" && r.json.granularity_level === "NONE" && r.json.formatted_address === "", r.json);
r = await dl("validate_address", { address: "  " });
check("empty -> HTTP 400 No address provided", r.isError && r.text.startsWith("HTTP 400") && r.json?.error === "No address provided", r.text);

r = await dl("verify_address", { address: "flat 4b sai heights baner", months: 6, req_id: "V-1" });
check(`verify Priya's flat -> is_verified, last_visited_date ${r.json?.last_visited_date}`, r.json?.is_verified === true && /^\d{4}-\d{2}-\d{2}$/.test(r.json.last_visited_date) && r.json.verification_reasoning, r.json);
r = await dl("verify_address", { address: "flat 2 kumar paradise kothrud", months: 6 });
check("no delivery on record -> not verified, null date", r.json?.is_verified === false && r.json.last_visited_date === null, r.json);
r = await dl("verify_address", { address: "lotus residency balewadi flat 7c", months: 1 });
check("delivered 40 days ago, window 1 month -> not verified", r.json?.is_verified === false, r.json);
r = await dl("verify_address", { address: "flat 4b sai heights" });
check("months missing -> 400 exact message", r.isError && r.json?.error === "'months' is a required field.", r.text);
r = await dl("verify_address", { address: "flat 4b sai heights", months: 30 });
check("months 30 -> 400 exact message", r.isError && r.json?.error === "Invalid 'months' value. Must be integer between 1 and 24.", r.text);

r = await dl("geocode_address", { address: "flat 4b, sai heights, baner, pune 411045", req_id: "G-1" });
check("geocode flat -> lat/lng, error_radius 15, pincode", r.json?.lat === 18.5603 && r.json.lng === 73.7812 && r.json.error_radius === 15 && r.json.metadata.pincode === "411045" && r.json.req_id === "G-1", r.json);
r = await dl("geocode_address", { address: "Kothrud" });
check("geocode locality -> large error_radius", r.json?.error_radius === 900, r.json);
r = await dl("geocode_address", { address: "Narnia castle" });
check("geocode unknown -> nulls", r.json?.lat === null && r.json.metadata === null, r.json);
r = await dl("geocode_address", {});
check("geocode no address -> 400 'address field is required'", r.isError && r.json?.error === "address field is required", r.text);

r = await dl("reverse_geocode", { req_id: "R-1", lat: 18.5604, lng: 73.7813 });
check("rvg at Sai Heights -> ROOFTOP with premise + postal_code", r.json?.data?.status === "OK" && r.json.data.results[0].geometry.location_type === "ROOFTOP" && r.json.data.results[0].address_components.some((c) => c.types.includes("premise") && c.long_name === "Sai Heights"), r.json);
r = await dl("reverse_geocode", { req_id: "R-2", lat: 18.55, lng: 73.80 });
check("rvg in between -> APPROXIMATE results, descending", r.json?.data?.results.length === 2 && r.json.data.results.every((x) => x.geometry.location_type === "APPROXIMATE"), r.json);
r = await dl("reverse_geocode", { req_id: "R-3", lat: 28.61, lng: 77.21 });
check("rvg Delhi (unknown to mock) -> ZERO_RESULTS", r.json?.data?.status === "ZERO_RESULTS" && r.json.data.results.length === 0, r.json);
r = await dl("reverse_geocode", { lat: 18.56 });
check("rvg missing fields -> 400 validation error with errors[]", r.isError && r.json?.error === "validation error" && r.json.errors.some((e) => e.field === "req_id"), r.text);

const ramesh = [18.5712, 73.7795]; // near Balewadi High Street
const priya = [18.5603, 73.7812];
r = await dl("compute_distance_matrix", { sources: [ramesh], targets: [priya], travel_mode: "motorcycle" });
const cell = r.json?.sources_to_targets?.[0]?.[0];
console.log("       Balewadi -> Sai Heights by motorcycle:", cell);
check("matrix: km + seconds, indexes", r.json?.status === true && cell.distance > 1 && cell.distance < 2.5 && cell.time > 100 && cell.from_index === 0 && cell.to_index === 0, r.json);
r = await dl("compute_distance_matrix", { sources: [ramesh, priya], targets: [priya, [18.5074, 73.8077]] });
check("matrix 2x2", r.json?.sources_to_targets.length === 2 && r.json.sources_to_targets[1].length === 2 && r.json.sources_to_targets[1][0].distance === 0, r.json);
r = await dl("compute_distance_matrix", { sources: [[51.5, -0.12]], targets: [priya] });
check("London -> 400 outside India, error_code 1002", r.isError && r.json?.error_code === 1002 && r.json.error.includes("outside India"), r.text);
r = await dl("compute_distance_matrix", { sources: [priya], targets: [ramesh], travel_mode: "bicycle" });
check("bicycle -> 400 invalid travel mode", r.isError && r.json?.error.startsWith("Invalid travel mode: bicycle"), r.text);
r = await dl("compute_distance_matrix", { targets: [priya] });
check("missing sources -> 400 Missing required field: sources", r.isError && r.json?.error === "Missing required field: sources", r.text);

r = await dl("auto_suggest", { query: "sai hei" });
check("autosuggest 'sai hei' -> Sai Heights first", Array.isArray(r.json) && r.json[0]?.entity_name === "Sai Heights" && r.json[0].long !== undefined, r.json);
r = await dl("auto_suggest", { query: "cooling" });
check("autosuggest business POI (Shree Sai Cooling)", r.json?.some((x) => x.entity_name === "Shree Sai Cooling Services" && x.entity_type === "poi"), r.json);
r = await dl("auto_suggest", { query: "411045" });
check("autosuggest pincode -> one pincode entity", r.json?.length === 1 && r.json[0].entity_type === "pincode", r.json);
r = await dl("auto_suggest", { query: "18.56, 73.78" });
check("autosuggest lat,lng -> synthetic coordinate", r.json?.length === 1 && r.json[0].entity_type === "coordinate", r.json);
r = await dl("auto_suggest", { query: "zzzz" });
check("autosuggest nothing -> []", Array.isArray(r.json) && r.json.length === 0, r.json);

// Failure switches
await core("scenario_set", { key: "delhivery.next_validate", value: "incomplete" });
r = await dl("validate_address", { address: "flat 4b sai heights baner" });
check("switch incomplete -> Priya's flat comes back incomplete", r.json?.reason === "incomplete", r.json);
await core("scenario_set", { key: "delhivery.next_geocode", value: "malformed" });
r = await dl("geocode_address", { address: "sai heights" });
check("switch malformed -> broken JSON, not an error flag", r.json === null && !r.isError, r.text);
await core("scenario_set", { key: "delhivery.next_matrix", value: "timeout" });
let t0 = Date.now();
r = await dl("compute_distance_matrix", { sources: [ramesh], targets: [priya] });
const waited = Date.now() - t0;
check(`switch timeout -> HTTP 504 after ${waited} ms`, r.isError && r.text.startsWith("HTTP 504") && r.json?.detail === "Upstream service 'matrix' timed out" && waited < 10000, r.text);
await core("scenario_set", { key: "delhivery.next_reverse_geocode", value: "unknown_coordinates" });
r = await dl("reverse_geocode", { req_id: "R-9", lat: 18.5603, lng: 73.7812 });
check("switch unknown_coordinates -> ZERO_RESULTS even at Sai Heights", r.json?.data?.status === "ZERO_RESULTS", r.json);
await core("scenario_set", { key: "delhivery.next_autosuggest", value: "not_found" });
r = await dl("auto_suggest", { query: "sai" });
check("switch not_found -> []", Array.isArray(r.json) && r.json.length === 0, r.json);
r = await dl("auto_suggest", { query: "sai" });
check("switch used up -> results again", r.json?.length > 0, r.json);

console.log(`\n${passed} passed, ${failed} failed`);
