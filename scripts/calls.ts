// `npm run calls`            → last 20 tool calls (all connectors), times in IST
// `npm run calls -- 50`      → last 50
// `npm run calls -- 20 all`  → also show registrations / handshakes (tools/list, initialize, …)
import { neon } from "@neondatabase/serverless";

const limit = Number(process.argv[2] ?? 20) || 20;
const showAll = process.argv[3] === "all";
const sql = neon(process.env.DATABASE_URL!);

const ist = (d: Date) =>
  new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });

async function main() {
  const rows = showAll
    ? await sql`SELECT * FROM ops.tool_calls ORDER BY at DESC LIMIT ${limit}`
    : await sql`SELECT * FROM ops.tool_calls WHERE method IN ('tools/call', 'unauthorized') ORDER BY at DESC LIMIT ${limit}`;
  const [last] = await sql`SELECT max(at) AS at, count(*)::int AS n FROM ops.tool_calls WHERE at > now() - interval '1 hour'`;

  console.log(`Requests to any connector in the last hour: ${last.n}${last.at ? ` (latest ${ist(last.at)} IST)` : ""}\n`);
  if (!rows.length) {
    console.log(showAll ? "No requests recorded yet." : "No tool calls recorded yet. (Add 'all' to also see registrations and handshakes.)");
    return;
  }
  console.table(
    rows.reverse().map((r) => ({
      "time (IST)": ist(r.at),
      connector: r.connector,
      what: r.method === "tools/call" ? r.tool : r.method,
      result: r.outcome ? `${r.outcome}${r.error_code ? ` (${r.error_code})` : ""}` : `HTTP ${r.http_status}`,
      ms: r.duration_ms,
      args: r.args ? JSON.stringify(r.args).slice(0, 70) : "",
    })),
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
