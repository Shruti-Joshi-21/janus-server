// Part of tests/run-all.mjs (npm test). Run alone: node --env-file=.env.local tests/steps.test.mjs [base-url]
// The 5 step tools on a SCRATCH household (ids tst_…), never Priya/Ramesh and never a reset: safe while recording.
// Scratch phones (+917000000001…) haven't joined the Twilio sandbox, so no real person is messaged; message
// wording is still checked. Everything the test created is deleted at the end and the payout balance restored.
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(path.join(process.cwd(), "package.json"));
const { neon } = require("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

const base = process.argv[2] ?? "http://localhost:3000";
const key = process.env.MCP_API_KEY;
let passed = 0, failed = 0;
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log("PASS", label); }
  else { failed++; console.log("FAIL", label, "\n     ", JSON.stringify(detail).slice(0, 700)); }
};
const STEP_TOOLS = ["technician_proposed_time", "technician_location_update", "bill_reported", "pay_through_janus", "assign_alternate_technician"];
const slowest = { ms: 0, tool: "" };
async function call(name, args) {
  const t = Date.now();
  const res = await fetch(`${base}/janus/mcp`, { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": key, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  const ms = Date.now() - t;
  if (STEP_TOOLS.includes(name) && ms > slowest.ms) Object.assign(slowest, { ms, tool: name });
  return JSON.parse(line.slice(6)).result.structuredContent;
}
const body = (r, to) => r.messages_sent?.find((m) => m.to_name.startsWith(to))?.body ?? "";
const ran = (r, tool, connector) => r.steps?.some((s) => s.tool === tool && s.connector === connector);

const start = new Date();
const DEC = "+917000000001", T1 = "+917000000002", T2 = "+917000000003", T3 = "+917000000004";
const [{ balance_paise: balanceBefore }] = await sql`SELECT balance_paise FROM merchant_balance WHERE merchant_id = 'janus_merchant'`;
const createdJobs = [];

async function cleanup() {
  const jobs = await sql`SELECT id FROM jobs WHERE household_id = 'tst_hh'`;
  const ids = jobs.map((j) => j.id);
  const refs = ids.flatMap((id) => [`${id}-otm`, `${id}-debit`, `${id}-payout`]);
  await sql`DELETE FROM mock_pl_payouts WHERE client_reference_id = ANY(${refs}::text[])`;
  await sql`DELETE FROM mock_pl_presentations WHERE subscription_id IN (SELECT subscription_id FROM mock_pl_subscriptions WHERE merchant_subscription_reference = ANY(${refs}::text[]))`;
  await sql`DELETE FROM mock_pl_subscriptions WHERE merchant_subscription_reference = ANY(${refs}::text[])`;
  await sql`DELETE FROM mock_pl_customers WHERE merchant_customer_reference = 'tst_hh'`;
  await sql`DELETE FROM checks WHERE household_id = 'tst_hh'`;
  await sql`DELETE FROM notifications WHERE household_id = 'tst_hh'`;
  await sql`DELETE FROM price_ledger WHERE household_id = 'tst_hh'`;
  await sql`DELETE FROM jobs WHERE household_id = 'tst_hh'`;
  await sql`DELETE FROM household_technicians WHERE household_id = 'tst_hh'`;
  await sql`DELETE FROM members WHERE household_id = 'tst_hh'`;
  await sql`DELETE FROM appliances WHERE household_id = 'tst_hh'`;
  await sql`DELETE FROM households WHERE id = 'tst_hh'`;
  await sql`DELETE FROM pine_merchants WHERE merchant_id LIKE 'TSTM%'`;
  await sql`DELETE FROM technicians WHERE id LIKE 'tst_tech%'`;
  await sql`DELETE FROM scenarios WHERE key IN ('pinelabs.next_payout', 'delhivery.next_matrix', 'custom.next_identity')`;
  await sql`UPDATE merchant_balance SET balance_paise = ${balanceBefore} WHERE merchant_id = 'janus_merchant'`;
}

await cleanup(); // in case a previous run was interrupted
await sql`INSERT INTO households (id, society_id, name, flat, address, latitude, longitude, primary_phone, language, availability, spend_limit, onboarding_step)
  VALUES ('tst_hh', 'soc_sai_heights', 'Test Family', '9Z', 'Flat 9Z, Sai Heights, Baner, Pune, Maharashtra 411045', 18.5603, 73.7812, ${DEC}, 'en',
          '{"tz":"Asia/Kolkata","weekdays":[{"from":"16:00","to":"20:00"}],"weekends":[{"from":"10:00","to":"18:00"}]}', 5000, 'done')`;
await sql`INSERT INTO members (id, household_id, phone, name, role) VALUES ('tst_mem', 'tst_hh', ${DEC}, 'Tara Test', 'decider'), ('tst_mem2', 'tst_hh', '+919000000099', 'Placeholder Partner', 'decider')`;
await sql`INSERT INTO appliances (id, household_id, type, brand) VALUES ('tst_app', 'tst_hh', 'ac', 'Voltas')`;
await sql`INSERT INTO technicians (id, name, phone, skills, opted_in, availability_status, source, upi_id) VALUES
  ('tst_tech1', 'Ravi Test', ${T1}, '{ac}', true, 'available', 'household', 'ravi.test@okaxis'),
  ('tst_tech2', 'Arun Test', ${T2}, '{ac}', true, 'available', 'household', 'arun.test@okicici'),
  ('tst_tech3', 'Fake Kumar', ${T3}, '{ac}', true, 'available', 'household', null)`;
await sql`INSERT INTO household_technicians (household_id, technician_id, appliance_types, relationship) VALUES
  ('tst_hh', 'tst_tech1', '{ac}', 'known'), ('tst_hh', 'tst_tech2', '{ac}', 'known'), ('tst_hh', 'tst_tech3', '{ac}', 'known')`;
await sql`INSERT INTO pine_merchants (merchant_id, legal_name, display_name, phone, upi_id, kyc_status, city) VALUES ('TSTM1', 'Arun Test', 'Arun AC', ${T2}, 'arun.test@okicici', 'verified', 'Pune')`;
await sql`INSERT INTO price_ledger (household_id, technician_id, appliance_type, service_type, total, method, reported_by, confirmed, paid_at)
  VALUES ('tst_hh', 'tst_tech1', 'ac', 'gas_top_up', 600, 'direct_upi', 'household', true, '2025-04-12 18:15+05:30')`;
const newJob = async (state = "contacting") => {
  const j = await call("job_create", { household_id: "tst_hh", appliance_id: "tst_app", technician_id: "tst_tech1", issue: "AC not cooling" });
  createdJobs.push(j.job.id);
  await call("job_update", { job_id: j.job.id, fields: { state } });
  return j.job.id;
};

try {
  const list = await (await fetch(`${base}/janus/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": key, "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) })).text();
  const tools = JSON.parse(list.split("\n").find((l) => l.startsWith("data: ")).slice(6)).result.tools.map((t) => t.name);
  check(`/janus/mcp lists the 5 step tools (${tools.length} tools)`, ["technician_proposed_time", "technician_location_update", "bill_reported", "pay_through_janus", "assign_alternate_technician"].every((n) => tools.includes(n)), tools.length);

  // ── 1. technician_proposed_time ──
  const job1 = await newJob("contacting");
  await call("check_schedule", { kind: "technician_reply", job_id: job1, due_in_minutes: 30 });
  let r = await call("technician_proposed_time", { technician_phone: T1, slot_text: "I can come tomorrow at 5 pm" });
  check("proposed tomorrow 5 pm (inside 4–8 PM / 10–6) -> confirmed, slot_confirmed, reply check closed", r.decision === "confirmed" && r.checks_closed === 1, r);
  check("  technician message: 'Confirmed — Tomorrow 5 PM at Flat 9Z, Sai Heights, Baner. Thank you!'", body(r, "Ravi") === "Confirmed — Tomorrow 5 PM at Flat 9Z, Sai Heights, Baner. Thank you!", r.messages_sent);
  check("  decider message: '…inside your usual … availability …, so I confirmed it…'", /^Ravi will come tomorrow at 5 PM — inside your usual (weekday|weekend) availability \((4–8 PM|10 AM–6 PM)\), so I confirmed it\. Reply 'reschedule <time>' to change it\.$/.test(body(r, "Tara")), r.messages_sent);
  check("  never messages the placeholder partner; no ids in messages", !r.messages_sent.some((m) => m.to_name.startsWith("Placeholder")) && !r.messages_sent.some((m) => /\b(job|hh|tech|mem)_/.test(m.body)), r.messages_sent);
  const [j1] = await sql`SELECT state, confirmed_slot FROM jobs WHERE id = ${job1}`;
  check("  job saved as slot_confirmed with the slot", j1.state === "slot_confirmed" && j1.confirmed_slot, j1);
  check("  steps report job_update and send_whatsapp", ran(r, "job_update", "janus_core") && ran(r, "send_whatsapp", "whatsapp") && ran(r, "check_done", "janus_core"), r.steps);

  r = await call("technician_proposed_time", { technician_phone: T1, slot_text: "kal subah 9 baje" });
  check("proposed 9 am (outside) -> asked_household, decider gets '1 confirm · 2 ask him for another time'", r.decision === "asked_household" && body(r, "Tara").endsWith("1 confirm · 2 ask him for another time") && body(r, "Ravi") === "Thanks! Checking with Tara, I'll confirm shortly.", r);
  r = await call("technician_proposed_time", { technician_phone: T1, slot_text: "kal subah 9 baje", household_approved: true });
  check("household_approved:true -> confirmed even outside the window", r.decision === "confirmed" && r.inside_availability === false, r);
  r = await call("technician_proposed_time", { technician_phone: T1, slot_text: "whenever you want" });
  check("unparseable -> SLOT_UNPARSEABLE", r.error_code === "SLOT_UNPARSEABLE", r);
  r = await call("technician_proposed_time", { technician_phone: T3, slot_text: "tomorrow 5 pm" });
  check("technician without an open job -> NO_OPEN_JOB", r.error_code === "NO_OPEN_JOB", r);

  // ── 2. technician_location_update ──
  const now = new Date().toISOString();
  r = await call("technician_location_update", { technician_phone: T1, latitude: 18.4462, longitude: 73.8720, received_at: now });
  check(`far away -> on_the_way (${r.eta_minutes} min, ${r.distance_km} km), Delhivery matrix used`, r.decision === "on_the_way" && r.eta_minutes > 0 && r.distance_km > 1 && ran(r, "proof_of_presence", "custom") && ran(r, "compute_distance_matrix", "delhivery") && /^Ravi is on the way — about \d+ min \(\d+\.\d km\) away\.$/.test(body(r, "Tara")), r);
  await call("scenario_set", { key: "delhivery.next_matrix", value: "malformed", uses: 2 });
  r = await call("technician_location_update", { technician_phone: T1, latitude: 18.4462, longitude: 73.8720, received_at: now });
  check("Delhivery malformed twice -> retried once, eta_unavailable", r.decision === "eta_unavailable" && r.steps.filter((s) => s.tool === "compute_distance_matrix").length === 2 && body(r, "Tara") === "Ravi has shared his location; I can't work out the ETA right now.", r);
  await call("scenario_set", { key: "delhivery.next_matrix", value: "timeout", uses: 2 });
  r = await call("technician_location_update", { technician_phone: T1, latitude: 18.4462, longitude: 73.8720, received_at: now });
  check("Delhivery timeout -> eta_unavailable with no second wait (stays under 8 s)", r.decision === "eta_unavailable" && r.steps.filter((s) => s.tool === "compute_distance_matrix").length === 1, r.steps);
  await call("scenario_clear", { key: "delhivery.next_matrix" });
  r = await call("technician_location_update", { technician_phone: T1, latitude: 18.5603, longitude: 73.7812, received_at: now });
  check("at the flat -> arrived, job in_progress, both messages", r.decision === "arrived" && body(r, "Tara") === "Ravi has arrived at your flat." && body(r, "Ravi") === "Thanks, noted you've arrived.", r);

  // ── 3. bill_reported ──
  r = await call("bill_reported", { household_phone: DEC, amount: 900, service_type: "gas_top_up" });
  check("₹900 gas top-up -> high, real numbers in the decider message", r.decision === "high" && body(r, "Tara").startsWith("Ravi is asking ₹900 for the gas top-up. Last time (12 Apr 2025) you paid ₹600; about ₹") && body(r, "Tara").includes("That's high, ") && body(r, "Tara").includes("1 pay through Janus · 2 hold and ask him why · 3 I paid him directly"), r);
  const [jq] = await sql`SELECT state, quoted_amount, service_type FROM jobs WHERE id = ${job1}`;
  check("  job saved: awaiting_payment, quoted_amount 900, service_type", jq.state === "awaiting_payment" && jq.quoted_amount === 900 && jq.service_type === "gas_top_up", jq);
  r = await call("bill_reported", { household_phone: DEC, amount: 1500, service_type: "gas_top_up" });
  check("₹1,500 called a top-up -> adds the full-gas-charge hint", body(r, "Tara").includes("(If this was a full gas charge, ₹1,500 would be fair.)"), r.messages_sent);

  // ── 4. pay_through_janus ──
  r = await call("pay_through_janus", { household_phone: DEC, amount: 6000 });
  check("₹6,000 > ₹5,000 limit -> SPEND_LIMIT_EXCEEDED + decider asked", r.error_code === "SPEND_LIMIT_EXCEEDED" && body(r, "Tara") === "₹6,000 is above your ₹5,000 limit for automatic payments. Reply 'yes pay 6000' to confirm.", r);
  await call("scenario_set", { key: "pinelabs.next_payout", value: "insufficient_balance", uses: 1 });
  r = await call("pay_through_janus", { household_phone: DEC, amount: 400 });
  check("insufficient balance -> on_hold, nothing in the ledger, all 5 Pine Labs steps logged", r.outcome === "on_hold" && ["create_ot_subscription", "create_mandate_payment", "create_presentation", "create_payout", "get_payouts"].every((t) => ran(r, t, "pinelabs")) && body(r, "Tara").startsWith("Your ₹400 payment to Ravi is on hold — nothing has been paid yet"), r);
  r = await call("pay_through_janus", { household_phone: DEC, amount: 400 });
  const [{ n: payouts1 }] = await sql`SELECT count(*)::int AS n FROM mock_pl_payouts WHERE client_reference_id = ${job1 + "-payout"}`;
  check("retry after on_hold reuses the references: still on_hold, still ONE payout", r.outcome === "on_hold" && payouts1 === 1, { outcome: r.outcome, payouts1 });

  const job2 = await newJob("contacting");
  await call("bill_reported", { household_phone: DEC, amount: 400, service_type: "gas_top_up" });
  r = await call("pay_through_janus", { household_phone: DEC });
  check("pay (amount from the bill) -> paid, ledger + job paid, rating question", r.outcome === "paid" && /^Paid ₹400 to Ravi through Janus \(ref [0-9a-f]{6}\)\. Quick rating, reply yes\/no: 1 on time\? 2 fixed\? 3 fair price\? 4 reachable\?$/.test(body(r, "Tara")) && /^₹400 sent to your UPI for Tara, Flat 9Z – AC\. Ref [0-9a-f]{6}\.$/.test(body(r, "Ravi")) && ran(r, "ledger_record_payment", "janus_core"), r);
  r = await call("pay_through_janus", { household_phone: DEC });
  const [{ n: ledger2 }] = await sql`SELECT count(*)::int AS n FROM price_ledger WHERE job_id = ${job2} AND method = 'janus'`;
  check("paying again -> ALREADY_PAID, exactly one ledger row", r.error_code === "ALREADY_PAID" && ledger2 === 1, { r, ledger2 });

  const job3 = await newJob("contacting");
  await call("bill_reported", { household_phone: DEC, amount: 300, service_type: "gas_top_up" });
  await call("scenario_set", { key: "pinelabs.next_payout", value: "timeout", uses: 1 });
  let t0 = Date.now();
  r = await call("pay_through_janus", { household_phone: DEC });
  check(`payout timeout -> checks get_payouts, outcome unknown, 'Nothing will be paid twice' (${Date.now() - t0} ms)`, r.outcome === "unknown" && ran(r, "get_payouts", "pinelabs") && body(r, "Tara").includes("Nothing will be paid twice"), r);
  r = await call("pay_through_janus", { household_phone: DEC });
  const [{ n: payouts3 }] = await sql`SELECT count(*)::int AS n FROM mock_pl_payouts WHERE client_reference_id = ${job3 + "-payout"}`;
  check("retry after the timeout -> paid, exactly ONE payout for that job", r.outcome === "paid" && payouts3 === 1, { outcome: r.outcome, payouts3 });

  // ── 5. assign_alternate_technician ──
  const job4 = await newJob("technician_silent");
  await call("check_schedule", { kind: "technician_reply", job_id: job4, due_in_minutes: 30 });
  r = await call("assign_alternate_technician", { household_phone: DEC, technician_name: "Arun" });
  const [j4] = await sql`SELECT technician_id, state FROM jobs WHERE id = ${job4}`;
  const [{ n: newCheck }] = await sql`SELECT count(*)::int AS n FROM checks WHERE job_id = ${job4} AND kind = 'technician_reply' AND status = 'pending'`;
  check("verified alternate -> contacted: job reassigned, old check closed, new 2-min check", r.decision === "contacted" && j4.technician_id === "tst_tech2" && j4.state === "contacting" && r.checks_closed === 1 && newCheck === 1 && ran(r, "technician_identity_check", "custom"), { r, j4, newCheck });
  check("  messages: 'Hello Arun, this is Janus, an AI assistant for Test Family, Flat 9Z, Sai Heights, Baner. Their Voltas AC: AC not cooling. When can you come?'", body(r, "Arun") === "Hello Arun, this is Janus, an AI assistant for Test Family, Flat 9Z, Sai Heights, Baner. Their Voltas AC: AC not cooling. When can you come?" && body(r, "Tara") === "I've asked Arun (identity verified). I'll tell you when he replies.", r.messages_sent);
  r = await call("assign_alternate_technician", { household_phone: DEC, technician_name: "Fake Kumar" });
  check("not a Pine Labs merchant -> not_verified, nobody contacted", r.decision === "not_verified" && r.messages_sent.length === 1 && body(r, "Tara") === "I couldn't verify Fake's identity, so I haven't contacted him. Want me to try someone else?", r);
  await call("scenario_set", { key: "custom.next_identity", value: "mismatch", uses: 1 });
  r = await call("assign_alternate_technician", { household_phone: DEC, technician_name: "Arun" });
  check("identity switch mismatch -> not_verified", r.decision === "not_verified", r);

  // ── call log: every internal partner call has its own row ──
  const rows = await sql`SELECT DISTINCT connector, tool FROM ops.tool_calls WHERE user_agent LIKE 'step:%' AND at >= ${start.toISOString()}::timestamptz`;
  const has = (c, t) => rows.some((x) => x.connector === c && x.tool === t);
  check("call log rows: pinelabs create_payout, delhivery compute_distance_matrix, custom proof_of_presence + technician_identity_check, janus_core price_fairness_check, whatsapp send_whatsapp",
    has("pinelabs", "create_payout") && has("delhivery", "compute_distance_matrix") && has("custom", "proof_of_presence") && has("custom", "technician_identity_check") && has("janus_core", "price_fairness_check") && has("whatsapp", "send_whatsapp"), rows);
  const stepRows = await sql`SELECT DISTINCT tool FROM ops.tool_calls WHERE connector = 'steps' AND at >= ${start.toISOString()}::timestamptz`;
  check("the step tools themselves are logged (connector 'steps')", stepRows.length === 5, stepRows.map((x) => x.tool));
  // Enforced against Vercel (same region as the database); from a laptop every DB round trip is ~4x slower.
  if (base.includes("localhost")) console.log(`INFO slowest step call locally: ${slowest.tool} ${slowest.ms} ms (the 8 s limit is checked against production)`);
  else check(`every step call under 8 s (slowest: ${slowest.tool} ${slowest.ms} ms)`, slowest.ms < 8000, slowest);
} finally {
  await cleanup();
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM jobs WHERE household_id = 'tst_hh'`;
  const [{ balance_paise }] = await sql`SELECT balance_paise FROM merchant_balance WHERE merchant_id = 'janus_merchant'`;
  console.log(`\ncleanup: scratch jobs left ${n}, payout balance restored ${Number(balance_paise) === Number(balanceBefore)}`);
}
console.log(`${passed} passed, ${failed} failed`);
