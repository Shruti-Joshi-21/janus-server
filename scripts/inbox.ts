// `npm run inbox` — Janus's inbox and pending checks at a glance (times in IST). Read-only.
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);
const ist = (d: unknown) =>
  d ? new Date(d as string).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "-";

async function main() {
  console.log(`Now: ${ist(new Date())} IST\n`);

  const messages = await sql`
    SELECT e.id, e.from_phone, coalesce(m.name, t.name, 'unknown') AS who, e.text, e.media_type, e.received_at,
           e.status, e.claim_count, e.claimed_at, e.handled_at, e.outcome
    FROM inbound_events e
    LEFT JOIN members m ON m.phone = e.from_phone
    LEFT JOIN technicians t ON t.phone = e.from_phone
    ORDER BY e.received_at DESC LIMIT 10`;
  console.log("INBOX (last 10 WhatsApp messages, newest first)");
  if (!messages.length) console.log("  (empty)");
  else
    console.table(
      messages.map((e) => ({
        received: ist(e.received_at),
        from: `${e.who} ${e.from_phone}`,
        message: e.text ? String(e.text).slice(0, 40) : e.media_type ? `[${e.media_type}]` : "",
        status: e.status,
        attempt: e.claim_count,
        claimed: ist(e.claimed_at),
        done: ist(e.handled_at),
        outcome: e.outcome ? String(e.outcome).slice(0, 40) : "",
      })),
    );

  const checks = await sql`SELECT id, kind, due_at, job_id, household_id FROM checks WHERE status = 'pending' ORDER BY due_at`;
  console.log("\nPENDING CHECKS (oldest due first)");
  if (!checks.length) console.log("  (none)");
  else console.table(checks.map((c) => ({ id: c.id, kind: c.kind, due: ist(c.due_at), overdue: new Date(c.due_at as string) < new Date() ? "yes" : "", job: c.job_id ?? "", household: c.household_id ?? "" })));

  const [last] = await sql`SELECT max(at) AS at FROM ops.tool_calls`;
  console.log(`\nLast request from AgenticOrg (any connector): ${ist(last.at)} IST  (npm run calls for details)`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
