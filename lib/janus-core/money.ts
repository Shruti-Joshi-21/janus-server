import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getOrFail, sql, updateRow } from "@/lib/db";
import { addTool, ToolError } from "@/lib/mcp";

const zRupees = z.number().int().min(0).describe("Whole rupees");

export function registerMoneyTools(server: McpServer) {
  addTool(
    server,
    "ledger_get_history",
    "What this household has paid before (newest first), optionally only for one appliance type or technician. Only this household's own payments.",
    z.object({
      household_id: z.string(),
      appliance_type: z.string().optional(),
      technician_id: z.string().optional(),
    }),
    async ({ household_id, appliance_type, technician_id }) => {
      await getOrFail("households", household_id, "HOUSEHOLD_NOT_FOUND", "household");
      const payments = await sql`
        SELECT p.id, p.job_id, p.appliance_type, p.service_type, p.parts, p.labour, p.total, p.method, p.reported_by,
               p.confirmed, p.note, p.paid_at, t.id AS technician_id, t.name AS technician_name
        FROM price_ledger p LEFT JOIN technicians t ON t.id = p.technician_id
        WHERE p.household_id = ${household_id}
          AND (${appliance_type ?? null}::text IS NULL OR p.appliance_type = ${appliance_type ?? null})
          AND (${technician_id ?? null}::text IS NULL OR p.technician_id = ${technician_id ?? null})
        ORDER BY p.paid_at DESC`;
      const confirmed = payments.filter((p) => p.confirmed);
      return {
        household_id,
        payments,
        summary: {
          count: payments.length,
          confirmed_count: confirmed.length,
          confirmed_total: confirmed.reduce((sum, p) => sum + (p.total as number), 0),
        },
      };
    },
  );

  addTool(
    server,
    "ledger_record_payment",
    "Record what was paid for a job. If both parts and labour are given they must add up to total. Household, technician, appliance type and service type are taken from the job (pass appliance_type/service_type if the job has none). confirmed:false means someone reported it but it is not yet agreed.",
    z.object({
      job_id: z.string(),
      parts: zRupees.optional(),
      labour: zRupees.optional(),
      total: zRupees,
      method: z.enum(["janus", "direct_cash", "direct_upi", "partial"]),
      reported_by: z.enum(["household", "technician", "system"]),
      confirmed: z.boolean(),
      note: z.string().optional(),
      appliance_type: z.string().optional(),
      service_type: z.string().optional(),
    }),
    async (a) => {
      const job = await getOrFail("jobs", a.job_id, "JOB_NOT_FOUND", "job");
      if (a.parts !== undefined && a.labour !== undefined && a.parts + a.labour !== a.total) {
        throw new ToolError("TOTAL_MISMATCH", `parts (₹${a.parts}) + labour (₹${a.labour}) = ₹${a.parts + a.labour}, but total is ₹${a.total}.`);
      }
      const [appliance] = job.appliance_id ? await sql`SELECT type FROM appliances WHERE id = ${job.appliance_id}` : [];
      const applianceType = a.appliance_type ?? appliance?.type;
      const serviceType = a.service_type ?? job.service_type;
      if (!applianceType) throw new ToolError("MISSING_APPLIANCE_TYPE", "The job has no appliance; pass appliance_type.");
      if (!serviceType) throw new ToolError("MISSING_SERVICE_TYPE", "The job has no service_type; pass service_type (e.g. 'gas_refill').");

      const [payment] = await sql`
        INSERT INTO price_ledger (household_id, job_id, technician_id, appliance_type, service_type, parts, labour, total,
                                  method, reported_by, confirmed, note)
        VALUES (${job.household_id}, ${a.job_id}, ${job.technician_id}, ${applianceType}, ${serviceType},
                ${a.parts ?? null}, ${a.labour ?? null}, ${a.total}, ${a.method}, ${a.reported_by}, ${a.confirmed}, ${a.note ?? null})
        RETURNING *`;
      const [totals] = await sql`
        SELECT count(*)::int AS entries,
               coalesce(sum(total) FILTER (WHERE confirmed), 0)::int AS confirmed_total
        FROM price_ledger WHERE job_id = ${a.job_id}`;
      return { payment, job_entries: totals.entries, job_confirmed_total: totals.confirmed_total };
    },
  );

  addTool(
    server,
    "rating_save",
    "Save the household's rating of a job (four yes/no questions). If the job was already rated, pass replaces_rating_id to correct it; the old rating then stops counting.",
    z.object({
      job_id: z.string(),
      on_time: z.boolean().nullable(),
      fixed: z.boolean().nullable(),
      fair_price: z.boolean().nullable(),
      reachable: z.boolean().nullable(),
      replaces_rating_id: z.string().optional(),
    }),
    async (a) => {
      const job = await getOrFail("jobs", a.job_id, "JOB_NOT_FOUND", "job");
      if (a.replaces_rating_id) {
        const old = await getOrFail("ratings", a.replaces_rating_id, "RATING_NOT_FOUND", "rating");
        if (old.job_id !== a.job_id) throw new ToolError("RATING_JOB_MISMATCH", `Rating ${a.replaces_rating_id} is for a different job.`);
      } else {
        const [existing] = await sql`
          SELECT r.id FROM ratings r
          WHERE r.job_id = ${a.job_id} AND NOT EXISTS (SELECT 1 FROM ratings n WHERE n.replaces_rating_id = r.id)`;
        if (existing) {
          throw new ToolError("RATING_ALREADY_EXISTS", "This job is already rated. Pass replaces_rating_id to correct it.", {
            existing_rating_id: existing.id,
          });
        }
      }
      const [rating] = await sql`
        INSERT INTO ratings (job_id, household_id, technician_id, on_time, fixed, fair_price, reachable, replaces_rating_id)
        VALUES (${a.job_id}, ${job.household_id}, ${job.technician_id}, ${a.on_time}, ${a.fixed}, ${a.fair_price},
                ${a.reachable}, ${a.replaces_rating_id ?? null})
        RETURNING *`;
      return { rating };
    },
  );

  addTool(
    server,
    "complaint_create",
    "Open a complaint after bad work, e.g. kind 'repeat_fault', 'overcharge', 'no_show', 'damage'. Pass job_id when there is one (household and technician are taken from it), otherwise household_id.",
    z.object({
      kind: z.string().min(1),
      description: z.string().min(1),
      job_id: z.string().optional(),
      household_id: z.string().optional(),
      technician_id: z.string().optional(),
    }),
    async (a) => {
      let householdId = a.household_id;
      let technicianId = a.technician_id;
      if (a.job_id) {
        const job = await getOrFail("jobs", a.job_id, "JOB_NOT_FOUND", "job");
        householdId = job.household_id as string;
        technicianId = technicianId ?? (job.technician_id as string | null) ?? undefined;
      }
      if (!householdId) throw new ToolError("MISSING_HOUSEHOLD", "Pass job_id or household_id.");
      await getOrFail("households", householdId, "HOUSEHOLD_NOT_FOUND", "household");
      const [complaint] = await sql`
        INSERT INTO complaints (job_id, household_id, technician_id, kind, description)
        VALUES (${a.job_id ?? null}, ${householdId}, ${technicianId ?? null}, ${a.kind}, ${a.description})
        RETURNING *`;
      return { complaint };
    },
  );

  addTool(
    server,
    "complaint_update",
    "Change a complaint's status (open, in_progress, resolved, closed), resolution or description.",
    z.object({
      complaint_id: z.string(),
      fields: z.strictObject({
        status: z.enum(["open", "in_progress", "resolved", "closed"]),
        resolution: z.string(),
        description: z.string(),
        kind: z.string(),
      }).partial(),
    }),
    async ({ complaint_id, fields }) => {
      await getOrFail("complaints", complaint_id, "COMPLAINT_NOT_FOUND", "complaint");
      const complaint = await updateRow("complaints", complaint_id, fields, { touchUpdatedAt: true });
      return { complaint };
    },
  );
}
