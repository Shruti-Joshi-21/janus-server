// Five "step tools": each does one whole step of a rule exactly, so the agent only decides WHICH step applies.
// They call the existing tools in-process (StepRun), log every internal call, message only the decider and the
// technician (in parallel), and return decision/outcome, messages_sent and steps for an honest run report.
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { addTool, ToolError } from "@/lib/mcp";
import { zPhone } from "@/lib/phone";
import {
  availabilityFor, closeChecks, dayLabel, deciderOf, firstName, householdByPhone, newestOpenJob, parseSlot, rupees,
  sendAll, serviceWords, shortAddress, technicianByPhone, timeLabel, words,
} from "./helpers";
import { StepRun } from "./internal";

const zIso = z.iso.datetime({ offset: true });
const REPLY_CHECKS = ["technician_reply", "technician_final", "technician_silent"];

export function registerStepTools(server: McpServer) {
  // ───────────────────────── 1. technician_proposed_time ─────────────────────────
  addTool(
    server,
    "technician_proposed_time",
    "STEP: the technician proposed a visit time (e.g. 'I can come tomorrow at 5 pm', 'kal 5 baje'). Finds his newest open job and checks the household's availability. Inside it → confirms the slot (job slot_confirmed), closes the reply checks, WhatsApps him and the decider. Outside it → asks the decider (1 confirm · 2 another time) and tells him you're checking. If the decider replied 1 (confirm), call again with household_approved:true. Give slot_text (his words) or slot (ISO +05:30).",
    z.object({
      technician_phone: zPhone,
      slot_text: z.string().optional(),
      slot: zIso.optional(),
      received_at: zIso.optional().describe("When he sent it (the message's received_at); 'tomorrow' is relative to this"),
      household_approved: z.boolean().default(false).describe("true after the decider confirmed an out-of-hours slot"),
    }),
    async (a) => {
      const run = new StepRun("technician_proposed_time");
      const received = a.received_at ? new Date(a.received_at) : new Date();
      const slot = a.slot ? new Date(a.slot) : a.slot_text ? parseSlot(a.slot_text, received) : null;
      if (!a.slot && !a.slot_text) throw new ToolError("INVALID_INPUT", "Give slot_text (his words) or slot (ISO time).");
      if (!slot || Number.isNaN(slot.getTime())) throw new ToolError("SLOT_UNPARSEABLE", `Couldn't read a date and time from "${a.slot_text}". Ask him for a day and time.`);

      const tech = await technicianByPhone(a.technician_phone);
      const job = await newestOpenJob({ technicianId: tech.id as string }, ["new", "contacting", "technician_silent", "slot_confirmed"]);
      if (!job) throw new ToolError("NO_OPEN_JOB", `${tech.name} has no open job waiting for a visit time.`);
      const [household] = await sql`SELECT * FROM households WHERE id = ${job.household_id}`;
      const decider = await deciderOf(household.id as string);
      const avail = availabilityFor(slot, household.availability as Record<string, unknown>);
      const techName = firstName(tech.name as string);
      const when = `${dayLabel(slot, received, false)} at ${timeLabel(slot)}`;
      const closed = await closeChecks(run, job.id as string, REPLY_CHECKS, "technician replied");

      if (avail.inside || a.household_approved) {
        await run.call("job_update", { job_id: job.id, fields: { state: "slot_confirmed", confirmed_slot: slot.toISOString() } });
        if (!tech.opted_in) await run.call("technician_update", { technician_id: tech.id, fields: { opted_in: true } });
        const messages = await sendAll(run, [
          { to: tech.phone as string, to_name: techName, body: `Confirmed — ${dayLabel(slot, received, true)} ${timeLabel(slot)} at ${shortAddress(household.address as string)}. Thank you!` },
          {
            to: decider?.phone, to_name: decider?.name ?? "",
            body: avail.inside
              ? `${techName} will come ${when} — inside your usual ${avail.kind} availability (${avail.label}), so I confirmed it. Reply 'reschedule <time>' to change it.`
              : `Confirmed: ${techName} will come ${when}, as you approved. Reply 'reschedule <time>' to change it.`,
          },
        ]);
        return { decision: "confirmed", job_id: job.id, slot: slot.toISOString(), slot_ist: `${dayLabel(slot, received, true)} ${timeLabel(slot)}`, inside_availability: avail.inside, checks_closed: closed, messages_sent: messages, steps: run.steps };
      }

      const messages = await sendAll(run, [
        { to: decider?.phone, to_name: decider?.name ?? "", body: `${techName} offers ${when}, outside your usual ${avail.kind} hours (${avail.label}). 1 confirm · 2 ask him for another time` },
        { to: tech.phone as string, to_name: techName, body: `Thanks! Checking with ${decider ? firstName(decider.name) : "the household"}, I'll confirm shortly.` },
      ]);
      return { decision: "asked_household", job_id: job.id, slot: slot.toISOString(), slot_ist: `${dayLabel(slot, received, true)} ${timeLabel(slot)}`, inside_availability: false, availability: `${avail.kind}: ${avail.label}`, checks_closed: closed, messages_sent: messages, steps: run.steps };
    },
  );

  // ───────────────────────── 2. technician_location_update ─────────────────────────
  addTool(
    server,
    "technician_location_update",
    "STEP: the technician shared his WhatsApp location. Runs proof_of_presence for his newest open job. At the flat → job in_progress, tells the decider he has arrived and thanks him. Not there yet → Delhivery distance matrix (motorcycle) and tells the decider the ETA. If Delhivery fails twice → tells the decider the ETA isn't available.",
    z.object({
      technician_phone: zPhone,
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      received_at: zIso.describe("The message's received_at"),
    }),
    async (a) => {
      const run = new StepRun("technician_location_update");
      const tech = await technicianByPhone(a.technician_phone);
      const job = await newestOpenJob({ technicianId: tech.id as string }, ["new", "contacting", "technician_silent", "slot_confirmed", "in_progress"]);
      if (!job) throw new ToolError("NO_OPEN_JOB", `${tech.name} has no open job.`);
      const [household] = await sql`SELECT * FROM households WHERE id = ${job.household_id}`;
      const decider = await deciderOf(household.id as string);
      const techName = firstName(tech.name as string);

      const presence = await run.call("proof_of_presence", { job_id: job.id, technician_phone: tech.phone, latitude: a.latitude, longitude: a.longitude, timestamp: a.received_at });
      if (presence.ok && presence.body.present === true) {
        if (job.state !== "in_progress") await run.call("job_update", { job_id: job.id, fields: { state: "in_progress" } });
        const messages = await sendAll(run, [
          { to: decider?.phone, to_name: decider?.name ?? "", body: `${techName} has arrived at your flat.` },
          { to: tech.phone as string, to_name: techName, body: "Thanks, noted you've arrived." },
        ]);
        return { decision: "arrived", job_id: job.id, distance_m: presence.body.distance_m, messages_sent: messages, steps: run.steps };
      }

      const matrixArgs = { sources: [[a.latitude, a.longitude]], targets: [[household.latitude, household.longitude]], travel_mode: "motorcycle" };
      let cell: { distance: number; time: number } | undefined;
      // One retry, except after a timeout: a second 4 s wait would break the 8 s step budget.
      for (let attempt = 0; attempt < 2 && !cell; attempt++) {
        const m = await run.call("compute_distance_matrix", matrixArgs);
        cell = m.ok ? m.body.sources_to_targets?.[0]?.[0] : undefined;
        if (!cell && m.status === 504) break;
      }
      if (!cell) {
        const messages = await sendAll(run, [{ to: decider?.phone, to_name: decider?.name ?? "", body: `${techName} has shared his location; I can't work out the ETA right now.` }]);
        return { decision: "eta_unavailable", job_id: job.id, presence: presence.body.reason ?? null, messages_sent: messages, steps: run.steps };
      }
      const eta = Math.max(1, Math.round(cell.time / 60));
      const km = Number(cell.distance.toFixed(1));
      const messages = await sendAll(run, [{ to: decider?.phone, to_name: decider?.name ?? "", body: `${techName} is on the way — about ${eta} min (${km.toFixed(1)} km) away.` }]);
      return { decision: "on_the_way", job_id: job.id, eta_minutes: eta, distance_km: km, presence: presence.body.reason ?? null, messages_sent: messages, steps: run.steps };
    },
  );

  // ───────────────────────── 3. bill_reported ─────────────────────────
  addTool(
    server,
    "bill_reported",
    "STEP: the bill is known (amount in whole rupees + service_type, e.g. gas_top_up). Saves it on the household's newest open job (state awaiting_payment), runs price_fairness_check and sends the decider the verdict with real numbers and the options 1 pay through Janus · 2 hold and ask why · 3 I paid him directly. decision = the verdict.",
    z.object({
      household_phone: zPhone,
      amount: z.number().int().min(1),
      service_type: z.string().min(1),
      technician_phone: zPhone.optional(),
    }),
    async (a) => {
      const run = new StepRun("bill_reported");
      const household = await householdByPhone(a.household_phone);
      const job = await newestOpenJob({ householdId: household.id as string });
      if (!job) throw new ToolError("NO_OPEN_JOB", "This household has no open job to attach a bill to.");
      const [appliance] = job.appliance_id ? await sql`SELECT type, brand FROM appliances WHERE id = ${job.appliance_id}` : [];
      if (!appliance) throw new ToolError("MISSING_APPLIANCE", "The job has no appliance, so the price can't be checked.");
      const [tech] = job.technician_id ? await sql`SELECT name FROM technicians WHERE id = ${job.technician_id}` : [];
      const decider = await deciderOf(household.id as string);

      await sql`UPDATE jobs SET quoted_amount = ${a.amount}, updated_at = now() WHERE id = ${job.id}`;
      await run.call("job_update", { job_id: job.id, fields: { service_type: a.service_type, state: "awaiting_payment" } });
      const fair = await run.call("price_fairness_check", { household_id: household.id, appliance_type: appliance.type, service_type: a.service_type, total_amount: a.amount });
      const f = fair.body;
      const range = f.expected_min === f.expected_max ? rupees(f.expected_min) : `${rupees(f.expected_min)}–${rupees(f.expected_max)}`;
      const basis =
        f.tier_used === "household_history" ? `Last time (${f.last_paid_date}) you paid ${rupees(f.last_paid)}; about ${range} is expected now.`
        : f.tier_used ? `The usual range near you is ${range}.`
        : "I don't have past prices to compare it with.";
      const verdict = ({ high: `high, ${f.difference_pct}% above expected`, slightly_high: `slightly high, ${f.difference_pct}% above expected`, fair: "fair", low: "suspiciously low" } as Record<string, string>)[f.verdict] ?? "something I can't judge yet";
      const alt = f.alternative_service_types?.[0];
      const body =
        `${tech ? firstName(tech.name as string) : "The technician"} is asking ${rupees(a.amount)} for the ${serviceWords(a.service_type)}. ${basis} That's ${verdict}. 1 pay through Janus · 2 hold and ask him why · 3 I paid him directly` +
        (alt ? ` (If this was a ${serviceWords(alt.service_type)}, ${rupees(a.amount)} would be fair.)` : "");
      const messages = await sendAll(run, [{ to: decider?.phone, to_name: decider?.name ?? "", body }]);
      return { decision: f.verdict ?? "insufficient_data", job_id: job.id, amount: a.amount, expected_min: f.expected_min ?? null, expected_max: f.expected_max ?? null, difference_pct: f.difference_pct ?? null, alternative_service_types: f.alternative_service_types ?? [], messages_sent: messages, steps: run.steps };
    },
  );

  // ───────────────────────── 4. pay_through_janus ─────────────────────────
  addTool(
    server,
    "pay_through_janus",
    "STEP: the decider chose '1 pay through Janus'. Pays the newest awaiting_payment job via Pine Labs: one-time mandate → mandate approval → debit → payout to the technician's UPI → payout status. Never pays twice (references are reused; after a timeout it checks the payout instead of creating another). outcome: paid (ledger + job paid + rating question), on_hold (insufficient balance, nothing paid), declined, failed, or unknown (still checking). Amount defaults to the quoted bill; above the spend limit needs over_limit_confirmed:true.",
    z.object({
      household_phone: zPhone,
      amount: z.number().int().min(1).optional(),
      over_limit_confirmed: z.boolean().default(false).describe("true only after the decider replied 'yes pay <amount>' to the limit question"),
    }),
    async (a) => {
      const run = new StepRun("pay_through_janus");
      const household = await householdByPhone(a.household_phone);
      const job = await newestOpenJob({ householdId: household.id as string }, ["new", "contacting", "technician_silent", "slot_confirmed", "in_progress", "awaiting_payment", "paid"]);
      if (!job) throw new ToolError("NOTHING_TO_PAY", "There is no job to pay for.");
      const [ledger] = await sql`SELECT id FROM price_ledger WHERE job_id = ${job.id} AND method = 'janus' AND confirmed`;
      if (job.state === "paid" || ledger) throw new ToolError("ALREADY_PAID", "This job has already been paid through Janus. Nothing was paid again.", { job_id: job.id });
      if (job.state !== "awaiting_payment") throw new ToolError("NOTHING_TO_PAY", `The newest job is '${job.state}', not awaiting payment. Report the bill first (bill_reported).`, { job_id: job.id });
      const amount = a.amount ?? (job.quoted_amount as number | null);
      if (!amount) throw new ToolError("NOTHING_TO_PAY", "No bill amount on the job; pass amount.");
      const decider = await deciderOf(household.id as string);
      const limit = household.spend_limit as number | null;
      if (limit !== null && amount > limit && !a.over_limit_confirmed) {
        const messages = await sendAll(run, [{ to: decider?.phone, to_name: decider?.name ?? "", body: `${rupees(amount)} is above your ${rupees(limit)} limit for automatic payments. Reply 'yes pay ${amount}' to confirm.` }]);
        throw new ToolError("SPEND_LIMIT_EXCEEDED", `${rupees(amount)} is above the ${rupees(limit)} spend limit; the decider was asked to confirm.`, { messages_sent: messages, steps: run.steps });
      }
      const [tech] = await sql`SELECT * FROM technicians WHERE id = ${job.technician_id}`;
      if (!tech) throw new ToolError("NO_TECHNICIAN", "The job has no technician to pay.");
      if (!tech.upi_id) throw new ToolError("NO_TECHNICIAN_UPI", `${tech.name} has no UPI ID on record.`);
      const [appliance] = job.appliance_id ? await sql`SELECT type FROM appliances WHERE id = ${job.appliance_id}` : [];
      const techName = firstName(tech.name as string);
      const paise = amount * 100;
      const ref = (s: string) => `${job.id}-${s}`;
      const refs = { mandate: ref("otm"), mandate_payment: ref("mandate"), debit: ref("debit"), payout: ref("payout") };
      const result = (outcome: string, messages: unknown[], extra: Record<string, unknown> = {}) => ({ outcome, job_id: job.id, amount, references: refs, ...extra, messages_sent: messages, steps: run.steps });
      const unknownPath = async (why: string) =>
        result("unknown", await sendAll(run, [{ to: decider?.phone, to_name: decider?.name ?? "", body: "The payment system didn't answer, so I'm checking. Nothing will be paid twice; I'll confirm shortly." }]), { reason: why });

      // Pine Labs customer for this household (Priya is seeded as cust-v1-250901101500-aa-PRIYA1)
      let [customer] = await sql`SELECT customer_id FROM mock_pl_customers WHERE merchant_customer_reference = ${household.id}`;
      if (!customer && decider) {
        const c = await run.call("create_customer", { merchant_customer_reference: household.id, first_name: firstName(decider.name), mobile_number: decider.phone.slice(-10) });
        customer = { customer_id: c.body.customer_id };
      }
      if (!customer?.customer_id) throw new ToolError("NO_PINE_LABS_CUSTOMER", "Couldn't find or create the Pine Labs customer.");

      // 1. One-time mandate (reuse it if this job already has one)
      let sub: Record<string, any> | null = null;
      const created = await run.call("create_ot_subscription", { merchant_subscription_reference: refs.mandate, customer_id: customer.customer_id, plan_details: { amount: paise, currency: "INR", validity_days: 30, description: `${words(appliance?.type ?? "appliance")} repair` } });
      if (created.ok) sub = created.body;
      else {
        const [existing] = await sql`SELECT subscription_id FROM mock_pl_subscriptions WHERE merchant_subscription_reference = ${refs.mandate}`;
        if (existing) sub = (await run.call("get_ot_subscription", { subscription_id: existing.subscription_id })).body;
        else if (created.status === 504 || created.malformed) return unknownPath("mandate creation did not answer");
        else return result("failed", await sendAll(run, [{ to: decider?.phone, to_name: decider?.name ?? "", body: `The payment couldn't be set up, nothing was paid. 1 try again · 2 pay him directly` }]), { reason: created.body.message ?? created.text });
      }

      // 2. Customer approves the mandate (instant in the mock)
      if (sub?.status === "CREATED") {
        const mp = await run.call("create_mandate_payment", { order_id: sub.order_id, payments: [{ merchant_payment_reference: refs.mandate_payment, payment_method: "UPI", payment_amount: { value: paise, currency: "INR" }, payment_option: { upi_details: { txn_mode: "INTENT" } }, mandate_info: { request_type: "CREATE_MANDATE" } }] });
        if (mp.ok && mp.body.data?.status === "FAILED") {
          return result("declined", await sendAll(run, [{ to: decider?.phone, to_name: decider?.name ?? "", body: `Your bank declined the ${rupees(amount)} payment, nothing was paid. 1 try again · 2 pay him directly` }]));
        }
        if (!mp.ok) return mp.status === 504 || mp.malformed ? unknownPath("mandate approval did not answer") : result("failed", [], { reason: mp.body.message ?? mp.text });
        sub = { ...sub, status: "ACTIVE" };
      }

      // 3. Debit the customer (skip if this job's debit already exists)
      const [debit] = await sql`SELECT presentation_id FROM mock_pl_presentations WHERE merchant_presentation_reference = ${refs.debit}`;
      if (!debit) {
        const pr = await run.call("create_presentation", { subscription_id: sub?.subscription_id, amount: { value: paise, currency: "INR" }, merchant_presentation_reference: refs.debit });
        if (!pr.ok && pr.body.code !== "DUPLICATE_REQUEST") return pr.status === 504 || pr.malformed ? unknownPath("debit did not answer") : result("failed", [], { reason: pr.body.message ?? pr.text });
      }

      // 4. Payout to the technician (once; a duplicate or a timeout falls through to the status check)
      const remarks = `${words(appliance?.type ?? "appliance")} repair ${new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })}`.replace(/[^A-Za-z0-9\- ]/g, "");
      const payeeName = (tech.name as string).replace(/[^A-Za-z ]/g, "").trim();
      await run.call("create_payout", { clientReferenceId: refs.payout, payeeName, vpa: tech.upi_id, amount: { value: paise, currency: "INR" }, mode: "UPI", remarks });

      // 5. What actually happened (also covers timeouts / malformed replies / duplicates)
      const st = await run.call("get_payouts", { clientReferenceId: refs.payout });
      const payout = st.ok ? st.body.payments?.[0] : undefined;
      const status = payout?.status as string | undefined;
      const short = String(payout?.paymentReferenceId ?? "").slice(-6);

      if (status === "SUCCESS" || status === "SCHEDULED" || status === "PROCESSING" || status === "PROCESSED") {
        await run.call("ledger_record_payment", { job_id: job.id, total: amount, method: "janus", reported_by: "system", confirmed: true, note: `Pine Labs payout ${payout.paymentReferenceId}` });
        await run.call("job_update", { job_id: job.id, fields: { state: "paid" } });
        const messages = await sendAll(run, [
          { to: decider?.phone, to_name: decider?.name ?? "", body: `Paid ${rupees(amount)} to ${techName} through Janus (ref ${short}). Quick rating, reply yes/no: 1 on time? 2 fixed? 3 fair price? 4 reachable?` },
          { to: tech.phone as string, to_name: techName, body: `${rupees(amount)} sent to your UPI for ${decider ? firstName(decider.name) : "the household"}, Flat ${household.flat} – ${words(appliance?.type ?? "appliance")}. Ref ${short}.` },
        ]);
        return result("paid", messages, { payout_status: status, payment_reference: payout.paymentReferenceId });
      }
      if (status === "PENDING") {
        const messages = await sendAll(run, [
          { to: decider?.phone, to_name: decider?.name ?? "", body: `Your ${rupees(amount)} payment to ${techName} is on hold — nothing has been paid yet (the payout account is short of funds). 1 wait · 2 pay him directly` },
          { to: tech.phone as string, to_name: techName, body: `Your payment of ${rupees(amount)} is on hold; nothing has been sent yet. I'll update you.` },
        ]);
        return result("on_hold", messages, { payout_status: status, payment_reference: payout.paymentReferenceId });
      }
      if (status === "FAILED") {
        return result("failed", await sendAll(run, [{ to: decider?.phone, to_name: decider?.name ?? "", body: `The payout to ${techName} failed, nothing was paid. 1 try again · 2 pay him directly` }]), { payout_status: status });
      }
      return unknownPath("payout status unclear");
    },
  );

  // ───────────────────────── 5. assign_alternate_technician ─────────────────────────
  addTool(
    server,
    "assign_alternate_technician",
    "STEP: switch the household's newest open job to another technician (by name, e.g. 'Anil'). Looks him up (household list, then society log), verifies his identity with Pine Labs KYC, and only if verified: assigns him, closes the old reply checks, WhatsApps him the job, schedules a 2-minute reply check and tells the decider. Not verified → tells the decider and contacts nobody.",
    z.object({ household_phone: zPhone, technician_name: z.string().min(2) }),
    async (a) => {
      const run = new StepRun("assign_alternate_technician");
      const household = await householdByPhone(a.household_phone);
      const job = await newestOpenJob({ householdId: household.id as string }, ["new", "contacting", "technician_silent", "slot_confirmed"]);
      if (!job) throw new ToolError("NO_OPEN_JOB", "This household has no open job to reassign.");
      const like = `%${a.technician_name.trim()}%`;
      const [tech] = await sql`
        SELECT t.*, 1 AS rank FROM household_technicians ht JOIN technicians t ON t.id = ht.technician_id
        WHERE ht.household_id = ${household.id} AND t.name ILIKE ${like}
        UNION ALL
        SELECT t.*, 2 FROM society_log sl JOIN technicians t ON t.id = sl.technician_id
        WHERE sl.society_id = ${household.society_id} AND t.name ILIKE ${like}
        ORDER BY rank LIMIT 1`;
      if (!tech) throw new ToolError("TECHNICIAN_NOT_FOUND", `No technician called "${a.technician_name}" in this household's list or society log.`);
      const decider = await deciderOf(household.id as string);
      const techName = firstName(tech.name as string);

      const id = await run.call("technician_identity_check", { name: tech.name, phone: tech.phone, ...(tech.upi_id ? { upi_id: tech.upi_id } : {}) });
      if (!id.ok || id.body.status !== "verified") {
        const messages = await sendAll(run, [{ to: decider?.phone, to_name: decider?.name ?? "", body: `I couldn't verify ${techName}'s identity, so I haven't contacted him. Want me to try someone else?` }]);
        return { decision: "not_verified", job_id: job.id, identity_status: id.body.status ?? id.body.error_code ?? "error", messages_sent: messages, steps: run.steps };
      }

      await run.call("job_update", { job_id: job.id, fields: { technician_id: tech.id, state: "contacting" } });
      const closed = await closeChecks(run, job.id as string, REPLY_CHECKS, `reassigned to ${tech.name}`);
      const [appliance] = job.appliance_id ? await sql`SELECT type, brand FROM appliances WHERE id = ${job.appliance_id}` : [];
      const what = appliance ? `${appliance.brand ? `${appliance.brand} ` : ""}${words(appliance.type)}` : "appliance";
      const messages = await sendAll(run, [
        { to: tech.phone as string, to_name: techName, body: `Hello ${techName}, this is Janus, an AI assistant for ${household.name}, ${shortAddress(household.address as string)}. Their ${what}: ${job.issue ?? "needs a repair"}. When can you come?` },
        { to: decider?.phone, to_name: decider?.name ?? "", body: `I've asked ${techName} (identity verified). I'll tell you when he replies.` },
      ]);
      await run.call("check_schedule", { kind: "technician_reply", job_id: job.id, due_in_minutes: 2, payload: { technician_id: tech.id } });
      return { decision: "contacted", job_id: job.id, technician: { id: tech.id, name: tech.name }, checks_closed: closed, messages_sent: messages, steps: run.steps };
    },
  );
}
