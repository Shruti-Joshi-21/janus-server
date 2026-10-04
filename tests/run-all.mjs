// `npm test`                                   → all suites against the local dev server (npm run dev must be running)
// `npm test -- https://janus-server.vercel.app` → all suites against the live server
//
// WARNING: the suites create jobs, mandates and payouts, so the database is reset before, between and after
// suites (npm run reset). Don't run this while someone is testing Janus on the same database.
import { execSync } from "node:child_process";

const base = process.argv[2] ?? "http://localhost:3000";
const suites = [
  // [label, command, reset before it?]
  ["janus_core tools", "node --env-file=.env.local tests/janus-core.test.mjs", true],
  ["price fairness", "node --env-file=.env.local tests/price-fairness.test.mjs", true],
  ["Delhivery mock", "node --env-file=.env.local tests/delhivery.test.mjs", false],
  ["custom capabilities", "node --env-file=.env.local tests/custom.test.mjs", false],
  ["Gnani (real API)", "node --env-file=.env.local tests/gnani.test.mjs", false],
  ["Pine Labs mock", "node --env-file=.env.local tests/pinelabs.test.mjs", false],
  ["WhatsApp helpers (unit)", "npx tsx tests/whatsapp-unit.test.mts", false],
  ["WhatsApp connector", "node --env-file=.env.local tests/whatsapp.test.mjs", false],
  ["null optional fields (unit)", "npx tsx tests/null-optional-unit.test.mts", false],
  ["null optional fields (tools)", "node --env-file=.env.local tests/null-optional.test.mjs", false],
  ["inbox queue (Option C)", "node --env-file=.env.local tests/inbound-queue.test.mjs", false],
  ["step tools (unit)", "npx tsx --env-file=.env.local tests/steps-unit.test.mts", false],
  ["step tools (scratch household)", "node --env-file=.env.local tests/steps.test.mjs", false],
  ["combined /janus/mcp", "node --env-file=.env.local tests/janus-combined.test.mjs", false],
  ["scenario switches + reset", "npx tsx --env-file=.env.local tests/scenarios-reset.test.mts", false],
];

const reset = () => execSync("npm run reset", { stdio: "ignore" });

// Check the server answers BEFORE touching the database, so a missing server never causes a pointless reset.
try {
  const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (err) {
  console.error(`No server answering at ${base} (${err.cause?.code ?? err.message}).`);
  console.error(base.includes("localhost")
    ? "Start it first in another terminal with:  npm run dev\nor test the live server with:  npm test -- https://janus-server.vercel.app"
    : "Check the URL and that the deployment is Ready in Vercel.");
  console.error("Nothing was run and the database was NOT reset.");
  process.exit(1);
}
console.log(`Testing ${base}\n`);
let totalPass = 0;
let totalFail = 0;
for (const [label, command, resetFirst] of suites) {
  if (resetFirst) reset();
  let output = "";
  try {
    output = execSync(`${command} ${base}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    output = `${err.stdout ?? ""}\nFAIL suite crashed: ${(err.stderr ?? err.message).toString().split("\n")[0]}`;
  }
  const fails = output.split("\n").filter((l) => l.startsWith("FAIL"));
  const m = output.match(/(\d+) passed, (\d+) failed/);
  const pass = m ? Number(m[1]) : 0;
  const fail = m ? Number(m[2]) : Math.max(1, fails.length);
  totalPass += pass;
  totalFail += fail;
  console.log(`${fail ? "✗" : "✓"} ${label.padEnd(28)} ${pass} passed, ${fail} failed`);
  for (const f of fails) console.log(`    ${f}`);
}
reset();
console.log(`\n${totalPass} passed, ${totalFail} failed. Database reset to the demo data.`);
process.exit(totalFail ? 1 : 0);
