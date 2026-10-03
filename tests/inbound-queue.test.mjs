// Part of tests/run-all.mjs (npm test). Run alone: node --env-file=.env.local tests/inbound-queue.test.mjs [base-url]
// Janus's inbox (inbound_pending / inbound_mark_done). Test messages are dated 2000-01-01 so they're always the
// oldest and real messages are never touched; they are deleted at the end.
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
  else { failed++; console.log("FAIL", label, "\n     ", JSON.stringify(detail).slice(0, 600)); }
};
async function rpc(route, method, params) {
  const res = await fetch(`${base}${route}`, { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": key, "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line.slice(6)).result;
}
const tool = async (name, args) => (await rpc("/janus/mcp", "tools/call", { name, arguments: args })).structuredContent;

const testStart = Date.now();
const run = testStart.toString(36);
const ids = { a: `evt_test_${run}_a`, b: `evt_test_${run}_b`, c: `evt_test_${run}_c` };
await sql`
  INSERT INTO inbound_events (id, from_phone, text, received_at, twilio_message_sid) VALUES
    (${ids.a}, '+918530921384', 'AC band ho gaya hai', '2000-01-01T00:00:01Z', ${"SMtest" + run + "a"}),
    (${ids.b}, '+918369502720', 'Kal 5 baje aata hoon', '2000-01-01T00:00:02Z', ${"SMtest" + run + "b"}),
    (${ids.c}, '+919812345678', 'Hello?', '2000-01-01T00:00:03Z', ${"SMtest" + run + "c"})`;

try {
  const list = await rpc("/janus/mcp", "tools/list", {});
  check("inbound_pending and inbound_mark_done are on /janus/mcp", ["inbound_pending", "inbound_mark_done"].every((n) => list.tools.some((t) => t.name === n)), list.tools.length);
  const core = await rpc("/janus-core/mcp", "tools/list", {});
  check("...and on /janus-core/mcp", ["inbound_pending", "inbound_mark_done"].every((n) => core.tools.some((t) => t.name === n)));

  let r = await tool("inbound_pending", { limit: 2 });
  check("oldest first: Priya's then Ramesh's message", r.count === 2 && r.messages[0].event_id === ids.a && r.messages[1].event_id === ids.b, r);
  check("sender looked up: Priya = member of hh_priya with language", r.messages[0].party.type === "member" && r.messages[0].party.household_id === "hh_priya" && r.messages[0].party.language === "mr-hi-en", r.messages[0]);
  check("sender looked up: Ramesh = technician", r.messages[1].party.type === "technician" && r.messages[1].party.technician_id === "tech_ramesh", r.messages[1]);
  check("first attempt = 1, still_waiting counts the rest", r.messages[0].attempt === 1 && r.still_waiting >= 1, r);

  r = await tool("inbound_pending", { limit: 1 });
  check("claimed messages aren't handed out again; next is the stranger", r.messages[0]?.event_id === ids.c && !r.messages.some((m) => m.event_id === ids.a || m.event_id === ids.b), r);
  check("stranger -> party unknown", r.messages[0]?.party.type === "unknown", r.messages[0]);

  await sql`UPDATE inbound_events SET claimed_at = now() - interval '10 minutes' WHERE id = ${ids.a}`;
  r = await tool("inbound_pending", { limit: 1 });
  check("a claim abandoned for 10 min comes back, attempt 2", r.messages[0]?.event_id === ids.a && r.messages[0].attempt === 2, r);

  r = await tool("inbound_mark_done", { event_id: ids.a, outcome: "replied, job created" });
  check("mark done", r.ok && r.status === "done" && r.already_done === false, r);
  r = await tool("inbound_mark_done", { event_id: ids.a, outcome: "again" });
  check("mark done twice is harmless (already_done, keeps first outcome)", r.ok && r.already_done === true && r.outcome === "replied, job created", r);
  r = await tool("inbound_mark_done", { event_id: "evt_nope", outcome: "x" });
  check("unknown event -> EVENT_NOT_FOUND", r.error_code === "EVENT_NOT_FOUND", r);
  r = await tool("inbound_mark_done", { event_id: ids.b, outcome: "" });
  check("empty outcome -> INVALID_INPUT", r.error_code === "INVALID_INPUT", r);

  await tool("inbound_mark_done", { event_id: ids.b, outcome: "noted his slot" });
  await tool("inbound_mark_done", { event_id: ids.c, outcome: "ignored: unknown sender" });
  // Checked in the database rather than with inbound_pending, so the test never claims real waiting messages.
  const rows = await sql`SELECT id, status FROM inbound_events WHERE id = ANY(${Object.values(ids)}::text[])`;
  check("all three test messages are done (so they can never be handed out again)", rows.length === 3 && rows.every((x) => x.status === "done"), rows);
} finally {
  await sql`DELETE FROM inbound_events WHERE id = ANY(${Object.values(ids)}::text[])`;
  // Safety for the shared database: give back any REAL message this test claimed by accident.
  await sql`UPDATE inbound_events SET status = 'pending', claimed_at = NULL, claim_count = greatest(claim_count - 1, 0)
            WHERE status = 'claimed' AND claimed_at >= ${new Date(testStart).toISOString()}::timestamptz AND id NOT LIKE 'evt_test_%'`;
}

console.log(`\n${passed} passed, ${failed} failed`);
