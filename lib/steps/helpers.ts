// Shared helpers for the step tools: people, places, IST times, availability windows, slot parsing, messages.
import * as chrono from "chrono-node";
import { sql } from "@/lib/db";
import { ToolError } from "@/lib/mcp";
import { phoneOrFail } from "@/lib/phone";
import { SEND_COST_MS, sendDeadline, waitForSlot } from "@/lib/whatsapp/pace";
import type { StepRun } from "./internal";

const TZ = "Asia/Kolkata";
const PLACEHOLDER = "+9190000000%"; // demo numbers nobody answers (e.g. Rohan): never message them
export const OPEN_STATES = ["new", "contacting", "technician_silent", "slot_confirmed", "in_progress", "awaiting_payment"];

export const firstName = (name: string) => name.split(/\s+/)[0];
export const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
export const words = (type: string) =>
  ({ ac: "AC", ro_purifier: "RO purifier", washing_machine: "washing machine", fridge: "fridge", geyser: "geyser", tv: "TV" })[type] ?? type.replace(/_/g, " ");
export const serviceWords = (s: string) => ({ gas_top_up: "gas top-up", full_gas_charge: "full gas charge", pcb_replacement: "PCB replacement" })[s] ?? s.replace(/_/g, " ");

// The household member who decides: role decider/both, reachable (not a placeholder number). Never Rohan in the demo.
export async function deciderOf(householdId: string) {
  const [m] = await sql`
    SELECT id, name, phone FROM members
    WHERE household_id = ${householdId} AND role IN ('decider', 'both') AND phone NOT LIKE ${PLACEHOLDER}
    ORDER BY created_at LIMIT 1`;
  return m ? { id: m.id as string, name: m.name as string, phone: m.phone as string } : null;
}

export async function technicianByPhone(raw: string) {
  const phone = phoneOrFail(raw);
  const [t] = await sql`SELECT * FROM technicians WHERE phone = ${phone}`;
  if (!t) throw new ToolError("TECHNICIAN_NOT_FOUND", `${phone} is not a known technician.`);
  return t;
}

export async function householdByPhone(raw: string) {
  const phone = phoneOrFail(raw);
  const [m] = await sql`SELECT household_id FROM members WHERE phone = ${phone}`;
  if (!m) throw new ToolError("HOUSEHOLD_NOT_FOUND", `${phone} is not a household member.`);
  const [h] = await sql`SELECT * FROM households WHERE id = ${m.household_id}`;
  return h;
}

export async function newestOpenJob(filter: { technicianId?: string; householdId?: string }, states = OPEN_STATES) {
  const [job] = await sql`
    SELECT * FROM jobs
    WHERE state = ANY(${states}::text[])
      AND (${filter.technicianId ?? null}::text IS NULL OR technician_id = ${filter.technicianId ?? null})
      AND (${filter.householdId ?? null}::text IS NULL OR household_id = ${filter.householdId ?? null})
    ORDER BY created_at DESC LIMIT 1`;
  return job ?? null;
}

// "Flat 4B, Sai Heights, Baner" (first three parts of the address)
export const shortAddress = (address: string | null) => (address ?? "").split(",").slice(0, 3).map((p) => p.trim()).join(", ");

// ── IST dates and times ──
function istParts(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false })
      .formatToParts(d).map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hh: Number(p.hour) % 24, mm: Number(p.minute), weekday: p.weekday as string };
}
const istMidnight = (date: string) => new Date(`${date}T00:00:00+05:30`);

export function dayLabel(slot: Date, ref: Date, capital: boolean) {
  const days = Math.round((istMidnight(istParts(slot).date).getTime() - istMidnight(istParts(ref).date).getTime()) / 86_400_000);
  const plain = days === 0 ? "today" : days === 1 ? "tomorrow" : null;
  if (plain) return capital ? plain[0].toUpperCase() + plain.slice(1) : plain;
  const label = slot.toLocaleDateString("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).replace(",", "");
  return capital ? label : `on ${label}`;
}
export function timeLabel(d: Date) {
  const { hh, mm } = istParts(d);
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}${mm ? `:${String(mm).padStart(2, "0")}` : ""} ${hh < 12 ? "AM" : "PM"}`;
}
const hhmmLabel = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return { h12: h % 12 === 0 ? 12 : h % 12, m, ampm: h < 12 ? "AM" : "PM" };
};
export function windowLabel(w: { from: string; to: string }) {
  const a = hhmmLabel(w.from), b = hhmmLabel(w.to);
  const fmt = (x: typeof a) => `${x.h12}${x.m ? `:${String(x.m).padStart(2, "0")}` : ""}`;
  return a.ampm === b.ampm ? `${fmt(a)}–${fmt(b)} ${b.ampm}` : `${fmt(a)} ${a.ampm}–${fmt(b)} ${b.ampm}`;
}

// Household availability for that day (weekdays Mon–Fri, weekends Sat–Sun) and whether the slot falls inside it.
export function availabilityFor(slot: Date, availability: Record<string, unknown>) {
  const { hh, mm, weekday } = istParts(slot);
  const kind = weekday === "Sat" || weekday === "Sun" ? "weekend" : "weekday";
  const windows = ((availability?.[kind === "weekend" ? "weekends" : "weekdays"] as { from: string; to: string }[]) ?? []);
  const minutes = hh * 60 + mm;
  const inside = windows.some((w) => {
    const [fh, fm] = w.from.split(":").map(Number), [th, tm] = w.to.split(":").map(Number);
    return minutes >= fh * 60 + fm && minutes < th * 60 + tm;
  });
  return { kind, inside, label: windows.length ? windows.map(windowLabel).join(", ") : "no hours set" };
}

// "I can come tomorrow at 5 pm", "today 6:30 pm", "kal 5 baje", "parso shaam 6 baje" → Date (IST).
export function parseSlot(text: string, received: Date): Date | null {
  let t = ` ${text.toLowerCase()} `;
  let dayOffset: number | null = null;
  if (/\b(day after tomorrow|parso|parson)\b/.test(t)) dayOffset = 2;
  else if (/\b(tomorrow|kal)\b/.test(t)) dayOffset = 1;
  else if (/\b(today|aaj|tonight)\b/.test(t)) dayOffset = 0;
  t = t.replace(/\b(day after tomorrow|parso|parson|tomorrow|kal|today|aaj)\b/g, " ");
  const evening = /\b(shaam|sham|raat|evening|night|tonight)\b/.test(t);
  const morning = /\b(subah|morning)\b/.test(t);
  t = t.replace(/(\d{1,2})(?:[:.](\d{2}))?\s*baje\b/g, (_, h, m) => ` at ${h}:${m ?? "00"} `);
  if (!/\b(am|pm|a\.m\.|p\.m\.)\b/.test(t)) t += evening ? " pm" : morning ? " am" : "";

  let base = received;
  if (dayOffset !== null) base = new Date(istMidnight(istParts(received).date).getTime() + dayOffset * 86_400_000);
  const result = chrono.parse(t, { instant: base, timezone: 330 }, { forwardDate: dayOffset === null })[0];
  if (!result || !result.start.isCertain("hour")) return null;
  let hour = result.start.get("hour") ?? 0;
  const minute = result.start.get("minute") ?? 0;
  if (!result.start.isCertain("meridiem") && hour >= 1 && hour <= 7) hour += 12; // "5" for a home visit means 5 PM
  const day = dayOffset !== null ? istParts(base).date : istParts(result.start.date()).date;
  return new Date(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+05:30`);
}

// Send WhatsApps one at a time (send_whatsapp spaces them 3.5 s apart) through the real send_whatsapp tool.
// The step tool must finish under 10 s, so a message that can't be sent in time is reported as not sent
// (NOT_SENT_TIME_LIMIT: Janus can send it with send_whatsapp). Failures are reported, not thrown.
const STEP_DEADLINE_MS = 9500;
export async function sendAll(run: StepRun, messages: { to: string | null | undefined; to_name: string; body: string }[]) {
  const deadline = run.started + STEP_DEADLINE_MS;
  const results = [];
  for (const m of messages.filter((x) => x.to)) {
    if (Date.now() + waitForSlot() + SEND_COST_MS > deadline) {
      results.push({ to_name: m.to_name, body: m.body, sent: false, error_code: "NOT_SENT_TIME_LIMIT", twilio_code: null });
      continue;
    }
    const r = await sendDeadline.run(deadline, () => run.call("send_whatsapp", { to: m.to, body: m.body }));
    results.push({ to_name: m.to_name, body: m.body, sent: r.ok, ...(r.ok ? {} : { error_code: r.body.error_code ?? null, twilio_code: r.body.twilio_code ?? null }) });
  }
  return results;
}

// Close pending follow-up checks for a job (e.g. "did the technician reply?") once he has replied.
export async function closeChecks(run: StepRun, jobId: string, kinds: string[], outcome: string) {
  const checks = await sql`SELECT id FROM checks WHERE job_id = ${jobId} AND status = 'pending' AND kind = ANY(${kinds}::text[])`;
  for (const c of checks) await run.call("check_done", { check_id: c.id, outcome });
  return checks.length;
}
