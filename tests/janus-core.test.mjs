// Part of tests/run-all.mjs (npm test). Run alone: node --env-file=.env.local tests/janus-core.test.mjs [base-url]

const base = process.argv[2] ?? "http://localhost:3000";
const key = process.env.MCP_API_KEY;
let id = 0, passed = 0, failed = 0;

async function rpc(method, params) {
  const res = await fetch(`${base}/janus-core/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
               "x-api-key": key, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : text);
}
async function call(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) return { rpc_error: r.error };
  const sc = r.result.structuredContent;
  return sc ?? { raw: r.result };
}
function check(label, cond, detail) {
  if (cond) { passed++; console.log("PASS", label); }
  else { failed++; console.log("FAIL", label, "\n     ", JSON.stringify(detail).slice(0, 600)); }
}

const list = await rpc("tools/list", {});
const names = list.result.tools.map((t) => t.name);
console.log(`tools (${names.length}):`, names.join(", "));
const ju = list.result.tools.find((t) => t.name === "job_update").inputSchema;
check("tool list keeps field rules (job_update.fields.state enum)", ju.required?.includes("job_id") && Array.isArray(ju.properties.fields.properties.state.enum), ju);
let v = await call("get_party_by_phone", { phone: "1" });
check("too-short phone -> INVALID_INPUT", v.error_code === "INVALID_INPUT", v);
v = await call("job_get", {});
check("missing required field -> INVALID_INPUT", v.error_code === "INVALID_INPUT", v);

let r = await call("get_party_by_phone", { phone: "85309 21384" });
check("party: Priya by 10-digit phone", r.type === "member" && r.household_id === "hh_priya" && r.member.name === "Priya", r);
r = await call("get_party_by_phone", { phone: "whatsapp:+919823562151" });
check("party: Ramesh is technician", r.type === "technician" && r.technician.name === "Ramesh Patil", r);
r = await call("get_party_by_phone", { phone: "+919999999999" });
check("party: unknown", r.ok && r.type === "unknown", r);
r = await call("get_party_by_phone", { phone: "abcdef" });
check("party: invalid phone -> INVALID_PHONE", r.ok === false && r.error_code === "INVALID_PHONE", r);

r = await call("household_get", { household_id: "hh_priya" });
check("household_get: 2 members, 4 appliances, 3 techs (Ramesh, Suresh, Anil)", r.members?.length === 2 && r.appliances?.length === 4 && r.technicians?.length === 3, r);
r = await call("household_get", { household_id: "hh_nope" });
check("household_get: missing -> HOUSEHOLD_NOT_FOUND", r.error_code === "HOUSEHOLD_NOT_FOUND", r);

r = await call("appliance_list", { household_id: "hh_priya" });
const ro = r.appliances?.find((a) => a.type === "ro_purifier");
const wm = r.appliances?.find((a) => a.type === "washing_machine");
check("appliance_list: RO AMC due in 2 days, WM under warranty", ro?.days_until_amc_due === 2 && ro?.amc_active && wm?.under_warranty === true, r);

r = await call("technician_list_for_appliance", { household_id: "hh_priya", appliance_type: "ac" });
const [first, ...rest] = r.technicians ?? [];
const anil = rest.find((t) => t.name === "Anil Kale");
check("tech list AC: Ramesh first (household)", first?.name === "Ramesh Patil" && first?.relationship === "known", r);
check("tech list AC: Ramesh history ₹600, typical range from 3 points", first?.your_history?.last_paid === 600 && first?.typical_price_range?.data_points === 3, first);
check("tech list AC: Anil is Priya's own (known) AC technician, after Ramesh, available, 1 open complaint", rest[0]?.name === "Anil Kale" && anil?.relationship === "known" && anil?.availability_status === "available" && anil?.opted_in === true && anil?.phone === "+918308407020" && anil?.open_complaints === 1, rest);
check("tech list AC: no brand warning", r.brand_only_warning === null, r.brand_only_warning);
r = await call("technician_list_for_appliance", { household_id: "hh_priya", appliance_type: "washing_machine" });
check("tech list WM: brand_only warning", typeof r.brand_only_warning === "string", r);

r = await call("society_log_search", { society_id: "soc_sai_heights", appliance_type: "ro_purifier" });
check("society search RO: Suresh merged, 2 recommendations", r.technicians?.length === 1 && r.technicians[0].recommendations === 2, r);

r = await call("job_create", { household_id: "hh_priya", appliance_id: "app_priya_ac", technician_id: "tech_ramesh", service_type: "gas_refill", issue: "AC not cooling", urgent: true });
const jobId = r.job?.id;
check("job_create AC", r.ok && jobId && r.job.state === "new" && r.warnings.length === 0, r);
r = await call("job_create", { household_id: "hh_priya", appliance_id: "app_priya_wm", issue: "Drum noise" });
check("job_create WM local -> warning", r.ok && r.warnings.length === 1, r);
const wmJob = r.job?.id;
r = await call("job_create", { household_id: "hh_mehta", appliance_id: "app_priya_ac" });
check("job_create other household's appliance -> APPLIANCE_NOT_IN_HOUSEHOLD", r.error_code === "APPLIANCE_NOT_IN_HOUSEHOLD", r);

r = await call("job_update", { job_id: jobId, fields: { state: "contacting" } });
check("job_update contacting stamps contacted_at", r.job?.state === "contacting" && r.job?.contacted_at, r);
r = await call("job_update", { job_id: jobId, fields: { state: "slot_confirmed", confirmed_slot: "2026-10-03T17:00:00+05:30" } });
check("job_update slot_confirmed", r.job?.slot_confirmed_at && r.job?.confirmed_slot, r);
r = await call("job_update", { job_id: jobId, fields: {} });
check("job_update no fields -> NO_FIELDS", r.error_code === "NO_FIELDS", r);
r = await call("job_update", { job_id: jobId, fields: { colour: "red" } });
check("job_update unknown field -> INVALID_INPUT", r.error_code === "INVALID_INPUT", r);
console.log("      validation error looks like:", JSON.stringify(r).slice(0, 300));

r = await call("jobs_open_for_party", { phone: "+919823562151" });
check("jobs_open_for_party Ramesh sees AC job", r.type === "technician" && r.jobs.some((j) => j.id === jobId), r);
r = await call("jobs_open_for_party", { phone: "+919000000002" });
check("jobs_open_for_party Rohan sees 2 open jobs", r.type === "member" && r.jobs.length === 2, r);

r = await call("check_schedule", { kind: "technician_reply", job_id: jobId, due_in_minutes: 0, payload: { ask: "did Ramesh reply?" } });
const checkId = r.check?.id;
check("check_schedule", r.ok && r.check.household_id === "hh_priya", r);
r = await call("check_schedule", { kind: "x", household_id: "hh_priya" });
check("check_schedule without time -> INVALID_DUE_TIME", r.error_code === "INVALID_DUE_TIME", r);
r = await call("checks_due", {});
check("checks_due includes new check, not tomorrow's AMC reminder", r.checks?.some((c) => c.id === checkId) && !r.checks.some((c) => c.id === "chk_priya_ro_amc"), r);
r = await call("checks_due", { now: "2026-12-01T00:00:00+05:30" });
check("checks_due in the future includes AMC reminder", r.checks?.some((c) => c.id === "chk_priya_ro_amc"), r);
r = await call("check_done", { check_id: checkId, outcome: "Ramesh replied" });
check("check_done", r.check?.status === "done", r);
r = await call("check_done", { check_id: checkId, outcome: "again" });
check("check_done twice -> CHECK_NOT_PENDING", r.error_code === "CHECK_NOT_PENDING", r);

r = await call("ledger_record_payment", { job_id: jobId, parts: 300, labour: 200, total: 600, method: "janus", reported_by: "technician", confirmed: false });
check("payment mismatch -> TOTAL_MISMATCH", r.error_code === "TOTAL_MISMATCH", r);
r = await call("ledger_record_payment", { job_id: jobId, parts: 350, labour: 300, total: 650, method: "janus", reported_by: "household", confirmed: true });
check("payment recorded ₹650", r.payment?.total === 650 && r.payment.appliance_type === "ac" && r.job_confirmed_total === 650, r);
r = await call("ledger_record_payment", { job_id: wmJob, total: 100, method: "direct_cash", reported_by: "household", confirmed: true });
check("payment without service_type -> MISSING_SERVICE_TYPE", r.error_code === "MISSING_SERVICE_TYPE", r);
r = await call("ledger_get_history", { household_id: "hh_priya", appliance_type: "ac" });
check("ledger history AC: 2 payments, newest ₹650", r.payments?.length === 2 && r.payments[0].total === 650, r);

r = await call("rating_save", { job_id: jobId, on_time: true, fixed: true, fair_price: true, reachable: true });
const ratingId = r.rating?.id;
check("rating_save", r.ok && ratingId, r);
r = await call("rating_save", { job_id: jobId, on_time: false, fixed: true, fair_price: true, reachable: true });
check("rating twice -> RATING_ALREADY_EXISTS", r.error_code === "RATING_ALREADY_EXISTS" && r.existing_rating_id === ratingId, r);
r = await call("rating_save", { job_id: jobId, on_time: false, fixed: true, fair_price: true, reachable: true, replaces_rating_id: ratingId });
check("rating replace", r.ok && r.rating.replaces_rating_id === ratingId, r);

r = await call("complaint_create", { job_id: jobId, kind: "repeat_fault", description: "Stopped cooling after 3 days" });
check("complaint_create from job", r.complaint?.technician_id === "tech_ramesh", r);
r = await call("complaint_update", { complaint_id: r.complaint?.id, fields: { status: "resolved", resolution: "Revisit, free of cost" } });
check("complaint_update resolved", r.complaint?.status === "resolved", r);

r = await call("notification_log", { household_id: "hh_priya", member_id: "mem_rohan", kind: "job_update", body: "Ramesh confirmed 5 PM" });
check("notification_log", r.ok, r);
r = await call("notification_log", { household_id: "hh_priya", member_id: "mem_neha", kind: "x", body: "y" });
check("notification wrong member -> MEMBER_NOT_IN_HOUSEHOLD", r.error_code === "MEMBER_NOT_IN_HOUSEHOLD", r);
r = await call("notification_list", { household_id: "hh_priya" });
check("notification_list", r.notifications?.length === 1 && r.notifications[0].member_name === "Rohan", r);

r = await call("household_create", { phone: "+91 98111 22233", name: "Asha", language: "hi-en", society_id: "soc_sai_heights", flat: "1A" });
const newHh = r.household?.id;
check("household_create", r.ok && r.member?.phone === "+919811122233", r);
r = await call("household_create", { phone: "+918530921384", name: "Dup", language: "en" });
check("household_create dup phone -> PHONE_ALREADY_REGISTERED", r.error_code === "PHONE_ALREADY_REGISTERED" && r.household_id === "hh_priya", r);
r = await call("member_add", { household_id: newHh, phone: "9811122244", name: "Vikram", role: "notified" });
check("member_add", r.member?.role === "notified", r);
r = await call("household_update", { household_id: newHh, fields: { spend_limit: 2500, availability: { tz: "Asia/Kolkata", weekdays: [{ from: "18:00", to: "21:00" }] } } });
check("household_update", r.household?.spend_limit === 2500 && r.household.availability.weekdays.length === 1, r);
await call("onboarding_save", { household_id: newHh, step: "appliances", data: { has_ac: true } });
await call("onboarding_save", { household_id: newHh, step: "technicians", data: { knows_tech: false } });
r = await call("onboarding_get", { household_id: newHh });
check("onboarding merges data", r.step === "technicians" && r.data.has_ac === true && r.data.knows_tech === false, r);

r = await call("appliance_add", { household_id: newHh, type: "fridge", brand: "Samsung", purchase_date: "2024-01-10", warranty_end: "2027-01-10" });
check("appliance_add", r.appliance?.under_warranty === true, r);
r = await call("appliance_update", { appliance_id: r.appliance?.id, fields: { status: "faulty" } });
check("appliance_update", r.appliance?.status === "faulty", r);
r = await call("appliance_add", { household_id: newHh, type: "fridge", purchase_date: "10/01/2024" });
check("appliance_add bad date -> INVALID_INPUT", r.error_code === "INVALID_INPUT", r);

r = await call("technician_add", { name: "Ramesh", phone: "+919823562151", skills: ["washing_machine"], household_id: newHh });
check("technician_add existing phone -> already_existed, skills merged", r.already_existed === true && r.technician.skills.includes("washing_machine") && r.technician.skills.includes("ac"), r);
r = await call("technician_update", { technician_id: "tech_ramesh", fields: { availability_status: "away", availability_until: "2026-10-06T09:00:00+05:30" } });
check("technician_update away", r.technician?.availability_status === "away", r);
r = await call("society_log_add", { society_id: "soc_sai_heights", technician: { name: "Prakash", phone: "9822001122", skills: ["fridge"] }, added_by_member_id: "mem_priya", note: "Quick" });
check("society_log_add new tech", r.technician_already_known === false && r.technician.source === "society_log", r);
r = await call("job_get", { job_id: "job_nope" });
check("job_get missing -> JOB_NOT_FOUND", r.error_code === "JOB_NOT_FOUND", r);
r = await call("job_get", { job_id: jobId });
check("job_get full", r.job?.household?.name && r.payments.length === 1 && r.ratings.length === 2 && r.complaints.length === 1, r);

console.log(`\n${passed} passed, ${failed} failed`);
