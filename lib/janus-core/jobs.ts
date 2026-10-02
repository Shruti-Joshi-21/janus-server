import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getOrFail, sql, updateRow } from "@/lib/db";
import { addTool, ToolError } from "@/lib/mcp";
import { phoneOrFail, zPhone } from "@/lib/phone";

export const JOB_STATES = [
  "new",
  "contacting",
  "technician_silent",
  "slot_confirmed",
  "in_progress",
  "awaiting_payment",
  "paid",
  "closed",
  "escalated",
  "cancelled",
] as const;
const zState = z.enum(JOB_STATES);
const zIso = z.iso.datetime({ offset: true });

// When a job moves into a state, stamp the matching time (only if it isn't set yet).
const STATE_TIMESTAMP: Partial<Record<(typeof JOB_STATES)[number], string>> = {
  contacting: "contacted_at",
  slot_confirmed: "slot_confirmed_at",
  in_progress: "arrived_at",
  awaiting_payment: "done_at",
};

export async function getJobDetails(jobId: string) {
  await getOrFail("jobs", jobId, "JOB_NOT_FOUND", "job");
  const [job] = await sql`
    SELECT j.*,
      json_build_object('id', h.id, 'name', h.name, 'flat', h.flat, 'address', h.address, 'language', h.language,
                        'spend_limit', h.spend_limit, 'availability', h.availability) AS household,
      CASE WHEN a.id IS NULL THEN NULL ELSE json_build_object('id', a.id, 'type', a.type, 'brand', a.brand, 'model', a.model,
                        'warranty_end', a.warranty_end, 'brand_only', a.brand_only, 'amc_provider', a.amc_provider) END AS appliance,
      CASE WHEN t.id IS NULL THEN NULL ELSE json_build_object('id', t.id, 'name', t.name, 'phone', t.phone, 'contact_pref', t.contact_pref,
                        'opted_in', t.opted_in, 'availability_status', t.availability_status, 'availability_until', t.availability_until) END AS technician
    FROM jobs j
    JOIN households h ON h.id = j.household_id
    LEFT JOIN appliances a ON a.id = j.appliance_id
    LEFT JOIN technicians t ON t.id = j.technician_id
    WHERE j.id = ${jobId}`;
  const payments = await sql`SELECT * FROM price_ledger WHERE job_id = ${jobId} ORDER BY created_at`;
  const ratings = await sql`SELECT * FROM ratings WHERE job_id = ${jobId} ORDER BY created_at`;
  const complaints = await sql`SELECT * FROM complaints WHERE job_id = ${jobId} ORDER BY created_at`;
  return { job, payments, ratings, complaints };
}

export function registerJobTools(server: McpServer) {
  addTool(
    server,
    "job_create",
    "Open a repair job. Use route 'brand' for appliances that must go to the brand's service centre; a warning is returned if you pick 'local' for one.",
    z.object({
      household_id: z.string(),
      appliance_id: z.string().optional(),
      technician_id: z.string().optional(),
      route: z.enum(["local", "brand"]).default("local"),
      urgent: z.boolean().default(false),
      service_type: z
        .string()
        .optional()
        .describe(
          "e.g. AC: 'gas_top_up' (local top-up) or 'full_gas_charge' (full charging, much costlier), 'pcb_replacement'; fridge: 'gas_refill', 'wiring_repair'; RO: 'filter_replacement'",
        ),
      issue: z.string().optional().describe("The problem in the household's words"),
      brand_complaint_no: z.string().optional(),
    }),
    async (a) => {
      await getOrFail("households", a.household_id, "HOUSEHOLD_NOT_FOUND", "household");
      const warnings: string[] = [];
      if (a.appliance_id) {
        const appliance = await getOrFail("appliances", a.appliance_id, "APPLIANCE_NOT_FOUND", "appliance");
        if (appliance.household_id !== a.household_id) {
          throw new ToolError("APPLIANCE_NOT_IN_HOUSEHOLD", `Appliance ${a.appliance_id} belongs to a different household.`);
        }
        if (appliance.brand_only && a.route === "local") {
          warnings.push(`${appliance.brand} ${appliance.type} is brand_only (warranty until ${appliance.warranty_end}). A local repair may void the warranty; consider route 'brand'.`);
        }
      }
      if (a.technician_id) await getOrFail("technicians", a.technician_id, "TECHNICIAN_NOT_FOUND", "technician");
      const [row] = await sql`
        INSERT INTO jobs (household_id, appliance_id, technician_id, route, urgent, service_type, issue, brand_complaint_no)
        VALUES (${a.household_id}, ${a.appliance_id ?? null}, ${a.technician_id ?? null}, ${a.route}, ${a.urgent},
                ${a.service_type ?? null}, ${a.issue ?? null}, ${a.brand_complaint_no ?? null})
        RETURNING id`;
      return { ...(await getJobDetails(row.id as string)), warnings };
    },
  );

  addTool(
    server,
    "job_get",
    "A job with its household, appliance, technician, payments, ratings and complaints.",
    z.object({ job_id: z.string() }),
    async ({ job_id }) => getJobDetails(job_id),
  );

  addTool(
    server,
    "job_update",
    `Change a job. Only the fields you pass are changed. Moving state to contacting / slot_confirmed / in_progress / awaiting_payment also stamps contacted_at / slot_confirmed_at / arrived_at / done_at (if not already set). States: ${JOB_STATES.join(", ")}.`,
    z.object({
      job_id: z.string(),
      fields: z.strictObject({
        state: zState,
        technician_id: z.string().nullable(),
        route: z.enum(["local", "brand"]),
        urgent: z.boolean(),
        service_type: z.string(),
        issue: z.string(),
        brand_complaint_no: z.string(),
        confirmed_slot: zIso.nullable().describe("Agreed visit time, ISO with offset, e.g. 2026-10-03T17:00:00+05:30"),
        contacted_at: zIso,
        slot_confirmed_at: zIso,
        arrived_at: zIso,
        done_at: zIso,
      }).partial(),
    }),
    async ({ job_id, fields }) => {
      await getOrFail("jobs", job_id, "JOB_NOT_FOUND", "job");
      if (fields.technician_id) await getOrFail("technicians", fields.technician_id, "TECHNICIAN_NOT_FOUND", "technician");
      const extraSets: string[] = [];
      const stampColumn = fields.state ? STATE_TIMESTAMP[fields.state] : undefined;
      if (stampColumn && !(stampColumn in fields)) extraSets.push(`"${stampColumn}" = COALESCE("${stampColumn}", now())`);
      await updateRow("jobs", job_id, fields, { touchUpdatedAt: true, extraSets });
      return getJobDetails(job_id);
    },
  );

  addTool(
    server,
    "jobs_open_for_party",
    "Open jobs (not closed or cancelled) for a phone number: the household's jobs if it is a member, or jobs assigned to him if it is a technician. Use this to work out which job an incoming message is about.",
    z.object({ phone: zPhone }),
    async ({ phone: raw }) => {
      const phone = phoneOrFail(raw);
      const [member] = await sql`SELECT id, household_id FROM members WHERE phone = ${phone}`;
      const [technician] = member ? [] : await sql`SELECT id FROM technicians WHERE phone = ${phone}`;
      if (!member && !technician) return { type: "unknown", phone, jobs: [] };

      const jobs = await sql`
        SELECT j.id, j.state, j.route, j.urgent, j.service_type, j.issue, j.confirmed_slot, j.created_at,
               j.contacted_at, j.slot_confirmed_at, j.arrived_at, j.updated_at,
               a.type AS appliance_type, a.brand AS appliance_brand,
               h.id AS household_id, h.name AS household_name, h.flat, h.address,
               t.id AS technician_id, t.name AS technician_name, t.phone AS technician_phone
        FROM jobs j
        JOIN households h ON h.id = j.household_id
        LEFT JOIN appliances a ON a.id = j.appliance_id
        LEFT JOIN technicians t ON t.id = j.technician_id
        WHERE j.state NOT IN ('closed', 'cancelled')
          AND (j.household_id = ${member?.household_id ?? null} OR j.technician_id = ${technician?.id ?? null})
        ORDER BY j.urgent DESC, j.created_at DESC`;
      return member
        ? { type: "member", phone, household_id: member.household_id, jobs }
        : { type: "technician", phone, technician_id: technician.id, jobs };
    },
  );
}
