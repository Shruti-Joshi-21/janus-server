import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getOrFail, sql, toDbValue } from "@/lib/db";
import { addTool, ToolError } from "@/lib/mcp";

const zIso = z.iso.datetime({ offset: true });

export function registerCheckTools(server: McpServer) {
  addTool(
    server,
    "notification_log",
    "Record a message Janus sent (or should send) to a household or one member, e.g. kind 'job_update', 'price_alert', 'amc_reminder'.",
    z.object({
      household_id: z.string(),
      member_id: z.string().optional(),
      kind: z.string().min(1),
      body: z.string().min(1),
    }),
    async (a) => {
      await getOrFail("households", a.household_id, "HOUSEHOLD_NOT_FOUND", "household");
      if (a.member_id) {
        const member = await getOrFail("members", a.member_id, "MEMBER_NOT_FOUND", "member");
        if (member.household_id !== a.household_id) {
          throw new ToolError("MEMBER_NOT_IN_HOUSEHOLD", `Member ${a.member_id} belongs to a different household.`);
        }
      }
      const [notification] = await sql`
        INSERT INTO notifications (household_id, member_id, kind, body)
        VALUES (${a.household_id}, ${a.member_id ?? null}, ${a.kind}, ${a.body}) RETURNING *`;
      return { notification };
    },
  );

  addTool(
    server,
    "notification_list",
    "Recent notifications for a household, newest first.",
    z.object({ household_id: z.string(), limit: z.number().int().min(1).max(100).default(20) }),
    async ({ household_id, limit }) => {
      await getOrFail("households", household_id, "HOUSEHOLD_NOT_FOUND", "household");
      const notifications = await sql`
        SELECT n.*, m.name AS member_name FROM notifications n LEFT JOIN members m ON m.id = n.member_id
        WHERE n.household_id = ${household_id} ORDER BY n.created_at DESC LIMIT ${limit}`;
      return { household_id, notifications };
    },
  );

  addTool(
    server,
    "check_schedule",
    "Ask to be reminded to look at something later, e.g. kind 'technician_reply' (did he answer?), 'arrival', 'payment_followup', 'amc_visit_reminder'. Give due_at (ISO with offset) OR due_in_minutes. Pass job_id and/or household_id.",
    z.object({
      kind: z.string().min(1),
      due_at: zIso.optional().describe("e.g. 2026-10-03T10:00:00+05:30"),
      due_in_minutes: z.number().int().min(0).optional(),
      job_id: z.string().optional(),
      household_id: z.string().optional(),
      payload: z.record(z.string(), z.unknown()).default({}).describe("Anything Janus will need when the check comes due"),
    }),
    async (a) => {
      if ((a.due_at === undefined) === (a.due_in_minutes === undefined)) {
        throw new ToolError("INVALID_DUE_TIME", "Pass exactly one of due_at or due_in_minutes.");
      }
      let householdId = a.household_id;
      if (a.job_id) {
        const job = await getOrFail("jobs", a.job_id, "JOB_NOT_FOUND", "job");
        householdId = householdId ?? (job.household_id as string);
      }
      if (!householdId) throw new ToolError("MISSING_HOUSEHOLD", "Pass job_id or household_id.");
      await getOrFail("households", householdId, "HOUSEHOLD_NOT_FOUND", "household");

      const dueAt = a.due_at ?? new Date(Date.now() + a.due_in_minutes! * 60_000).toISOString();
      const [check] = await sql`
        INSERT INTO checks (household_id, job_id, kind, due_at, payload)
        VALUES (${householdId}, ${a.job_id ?? null}, ${a.kind}, ${dueAt}, ${toDbValue(a.payload)}::jsonb)
        RETURNING *`;
      return { check };
    },
  );

  addTool(
    server,
    "checks_due",
    "Pending checks whose time has come (due_at <= now), oldest first. The scheduler calls this regularly; handle each one, then call check_done.",
    z.object({
      now: zIso.optional().describe("Pretend it is this time (for testing). Defaults to the real time."),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    async ({ now, limit }) => {
      const at = now ?? new Date().toISOString();
      const checks = await sql`
        SELECT c.*, j.state AS job_state, j.technician_id
        FROM checks c LEFT JOIN jobs j ON j.id = c.job_id
        WHERE c.status = 'pending' AND c.due_at <= ${at}
        ORDER BY c.due_at LIMIT ${limit}`;
      return { now: at, count: checks.length, checks };
    },
  );

  addTool(
    server,
    "check_done",
    "Close a check with what happened (e.g. 'technician replied', 'escalated to Rohan'). Use status 'cancelled' if it no longer matters.",
    z.object({
      check_id: z.string(),
      outcome: z.string().min(1),
      status: z.enum(["done", "cancelled"]).default("done"),
    }),
    async ({ check_id, outcome, status }) => {
      const existing = await getOrFail("checks", check_id, "CHECK_NOT_FOUND", "check");
      if (existing.status !== "pending") {
        throw new ToolError("CHECK_NOT_PENDING", `Check ${check_id} is already ${existing.status}.`, { check: existing });
      }
      const [check] = await sql`
        UPDATE checks SET status = ${status}, outcome = ${outcome}, done_at = now()
        WHERE id = ${check_id} RETURNING *`;
      return { check };
    },
  );
}
