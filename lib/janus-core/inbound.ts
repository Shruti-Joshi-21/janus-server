// Janus's inbox. Incoming WhatsApp messages are stored by /api/twilio/inbound; a scheduled Janus run picks them
// up here (AgenticOrg's Gmail "Email Received" trigger needs an org admin, so Janus polls instead).
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { addTool, ToolError } from "@/lib/mcp";

const CLAIM_TIMEOUT_MIN = 2; // a run that died mid-way releases its messages after this (short, so demos recover fast)

// Who sent each message: member (with household), technician, or unknown.
async function partiesFor(phones: string[]) {
  const members = await sql`
    SELECT m.phone, m.id, m.name, m.role, m.household_id, h.name AS household_name, h.language
    FROM members m JOIN households h ON h.id = m.household_id WHERE m.phone = ANY(${phones}::text[])`;
  const techs = await sql`SELECT phone, id, name FROM technicians WHERE phone = ANY(${phones}::text[])`;
  return (phone: string) => {
    const m = members.find((x) => x.phone === phone);
    if (m) return { type: "member", member_id: m.id, name: m.name, role: m.role, household_id: m.household_id, household_name: m.household_name, language: m.language };
    const t = techs.find((x) => x.phone === phone);
    if (t) return { type: "technician", technician_id: t.id, name: t.name };
    return { type: "unknown" };
  };
}

export function registerInboundTools(server: McpServer) {
  addTool(
    server,
    "inbound_pending",
    `New incoming WhatsApp messages to handle, oldest first (call this at the start of every scheduled run). Each message comes with who sent it (party: member with household, technician, or unknown) and is CLAIMED for this run, so another run won't get it. Handle each one, then call inbound_mark_done. A message not marked done within ${CLAIM_TIMEOUT_MIN} minutes comes back (attempt goes up). Empty list = nothing new.`,
    z.object({ limit: z.number().int().min(1).max(20).default(5) }),
    async ({ limit }) => {
      const rows = await sql`
        WITH picked AS (
          SELECT id FROM inbound_events
          WHERE status = 'pending'
             OR (status = 'claimed' AND claimed_at < now() - make_interval(mins => ${CLAIM_TIMEOUT_MIN}))
          ORDER BY received_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE inbound_events e SET status = 'claimed', claimed_at = now(), claim_count = e.claim_count + 1
        FROM picked WHERE e.id = picked.id
        RETURNING e.*`;
      rows.sort((a, b) => new Date(a.received_at as string).getTime() - new Date(b.received_at as string).getTime());
      const partyOf = await partiesFor([...new Set(rows.map((r) => r.from_phone as string))]);
      const messages = rows.map((r) => ({
        event_id: r.id,
        channel: r.channel,
        from_phone: r.from_phone,
        party: partyOf(r.from_phone as string),
        text: r.text,
        media_url: r.media_url,
        media_type: r.media_type,
        latitude: r.latitude,
        longitude: r.longitude,
        received_at: r.received_at,
        twilio_message_sid: r.twilio_message_sid,
        attempt: r.claim_count,
      }));
      const [{ waiting }] = await sql`SELECT count(*)::int AS waiting FROM inbound_events WHERE status = 'pending'`;
      return { count: messages.length, messages, still_waiting: waiting };
    },
  );

  addTool(
    server,
    "inbound_mark_done",
    "Close an incoming message after handling it (event_id from inbound_pending), with a short outcome, e.g. 'replied, job job_… created' or 'ignored: spam'. Safe to call twice.",
    z.object({ event_id: z.string().min(1), outcome: z.string().min(1).max(500) }),
    async ({ event_id, outcome }) => {
      const [existing] = await sql`SELECT id, status, outcome, handled_at FROM inbound_events WHERE id = ${event_id}`;
      if (!existing) throw new ToolError("EVENT_NOT_FOUND", `No incoming message with event_id "${event_id}".`);
      if (existing.status === "done") return { event_id, status: "done", already_done: true, outcome: existing.outcome, handled_at: existing.handled_at };
      const [row] = await sql`
        UPDATE inbound_events SET status = 'done', handled_at = now(), outcome = ${outcome}
        WHERE id = ${event_id} RETURNING id, status, outcome, handled_at`;
      return { event_id: row.id, status: row.status, already_done: false, outcome: row.outcome, handled_at: row.handled_at };
    },
  );
}
