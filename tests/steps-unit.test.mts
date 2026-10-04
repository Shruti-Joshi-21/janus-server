// Part of tests/run-all.mjs (npm test). Run alone: npx tsx tests/steps-unit.test.mts
// Step-tool helpers that need no server or database: slot parsing, IST labels, availability windows.
import { availabilityFor, dayLabel, parseSlot, timeLabel, windowLabel } from "../lib/steps/helpers.ts";

let passed = 0, failed = 0;
const check = (label: string, cond: unknown, detail?: unknown) => {
  if (cond) { passed++; console.log("PASS", label); }
  else { failed++; console.log("FAIL", label, "\n     ", JSON.stringify(detail)); }
};
const ref = new Date("2026-10-04T18:00:00+05:30"); // Sunday evening IST
const ist = (d: Date | null) => (d ? d.toLocaleString("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : null);

const cases: [string, string | null][] = [
  ["I can come tomorrow at 5 pm", "Mon 5 Oct, 17:00"],
  ["today 6:30 pm", "Sun 4 Oct, 18:30"],
  ["kal 5 baje", "Mon 5 Oct, 17:00"],
  ["tomorrow at 5", "Mon 5 Oct, 17:00"],
  ["kal subah 10 baje", "Mon 5 Oct, 10:00"],
  ["parso shaam 6 baje", "Tue 6 Oct, 18:00"],
  ["day after tomorrow 11 am", "Tue 6 Oct, 11:00"],
  ["whenever you want", null],
];
for (const [text, want] of cases) {
  const got = parseSlot(text, ref);
  check(`parseSlot("${text}") -> ${want}`, ist(got) === want, ist(got));
}

const mon5pm = new Date("2026-10-05T17:00:00+05:30");
check("dayLabel tomorrow (capital / lower)", dayLabel(mon5pm, ref, true) === "Tomorrow" && dayLabel(mon5pm, ref, false) === "tomorrow");
check("dayLabel further out -> 'Tue 6 Oct' / 'on Tue 6 Oct'", dayLabel(new Date("2026-10-06T17:00:00+05:30"), ref, true) === "Tue 6 Oct" && dayLabel(new Date("2026-10-06T17:00:00+05:30"), ref, false) === "on Tue 6 Oct", dayLabel(new Date("2026-10-06T17:00:00+05:30"), ref, true));
check("timeLabel 5 PM / 6:30 PM", timeLabel(mon5pm) === "5 PM" && timeLabel(new Date("2026-10-04T18:30:00+05:30")) === "6:30 PM");
check("windowLabel 16:00–20:00 -> 4–8 PM", windowLabel({ from: "16:00", to: "20:00" }) === "4–8 PM");
check("windowLabel 10:00–18:00 -> 10 AM–6 PM", windowLabel({ from: "10:00", to: "18:00" }) === "10 AM–6 PM");

const avail = { tz: "Asia/Kolkata", weekdays: [{ from: "16:00", to: "20:00" }], weekends: [{ from: "10:00", to: "18:00" }] };
let a = availabilityFor(mon5pm, avail);
check("Mon 5 PM inside weekday 4–8 PM", a.inside && a.kind === "weekday" && a.label === "4–8 PM", a);
a = availabilityFor(new Date("2026-10-05T09:00:00+05:30"), avail);
check("Mon 9 AM outside weekday hours", !a.inside && a.kind === "weekday", a);
a = availabilityFor(new Date("2026-10-04T19:00:00+05:30"), avail);
check("Sun 7 PM outside weekend 10 AM–6 PM", !a.inside && a.kind === "weekend" && a.label === "10 AM–6 PM", a);
a = availabilityFor(new Date("2026-10-05T20:00:00+05:30"), avail);
check("8 PM exactly is outside (window ends at 8)", !a.inside, a);

console.log(`\n${passed} passed, ${failed} failed`);
