import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getOrFail, sql, toDbValue, updateRow } from "@/lib/db";
import { addTool, ToolError } from "@/lib/mcp";
import { phoneOrFail, zPhone } from "@/lib/phone";

const zRole = z.enum(["notified", "decider", "both"]);
const zAvailability = z
  .record(z.string(), z.unknown())
  .describe('When someone is home, e.g. {"tz":"Asia/Kolkata","weekdays":[{"from":"16:00","to":"20:00"}],"weekends":[{"from":"10:00","to":"18:00"}]}');

async function failIfPhoneTaken(phone: string) {
  const [member] = await sql`SELECT id, household_id FROM members WHERE phone = ${phone}`;
  if (member) {
    throw new ToolError("PHONE_ALREADY_REGISTERED", `${phone} already belongs to a member of household ${member.household_id}.`, {
      household_id: member.household_id,
      member_id: member.id,
    });
  }
}

export function registerPeopleTools(server: McpServer) {
  addTool(
    server,
    "get_party_by_phone",
    "Who is this phone number? Returns type 'member' (with household), 'technician', or 'unknown'. Call this first for every incoming message.",
    z.object({ phone: zPhone }),
    async ({ phone: raw }) => {
      const phone = phoneOrFail(raw);
      const [member] = await sql`
        SELECT m.*, h.name AS household_name, h.flat, h.language AS household_language, h.spend_limit, h.onboarding_step,
               (SELECT count(*)::int FROM jobs j WHERE j.household_id = h.id AND j.state NOT IN ('closed','cancelled')) AS open_jobs
        FROM members m JOIN households h ON h.id = m.household_id
        WHERE m.phone = ${phone}`;
      if (member) {
        const { household_name, flat, household_language, spend_limit, onboarding_step, open_jobs, ...m } = member;
        return {
          type: "member",
          phone,
          household_id: m.household_id,
          member: m,
          household: { id: m.household_id, name: household_name, flat, language: household_language, spend_limit, onboarding_step, open_jobs },
        };
      }
      const [technician] = await sql`
        SELECT t.*, (SELECT count(*)::int FROM jobs j WHERE j.technician_id = t.id AND j.state NOT IN ('closed','cancelled')) AS open_jobs
        FROM technicians t WHERE t.phone = ${phone}`;
      if (technician) return { type: "technician", phone, technician };
      return { type: "unknown", phone };
    },
  );

  addTool(
    server,
    "household_create",
    "Create a new household and its first member (role 'both'). `name` is the person's name; it is also used as the household name unless household_name is given.",
    z.object({
      phone: zPhone,
      name: z.string().min(1),
      language: z.string().describe("e.g. 'en', 'hi', 'mr', or mixed like 'mr-hi-en'"),
      household_name: z.string().optional(),
      society_id: z.string().optional(),
      flat: z.string().optional(),
      address: z.string().optional(),
    }),
    async (a) => {
      const phone = phoneOrFail(a.phone);
      await failIfPhoneTaken(phone);
      if (a.society_id) await getOrFail("societies", a.society_id, "SOCIETY_NOT_FOUND", "society");
      const [household] = await sql`
        INSERT INTO households (name, primary_phone, language, society_id, flat, address)
        VALUES (${a.household_name ?? a.name}, ${phone}, ${a.language}, ${a.society_id ?? null}, ${a.flat ?? null}, ${a.address ?? null})
        RETURNING *`;
      const [member] = await sql`
        INSERT INTO members (household_id, phone, name, role, language)
        VALUES (${household.id}, ${phone}, ${a.name}, 'both', ${a.language}) RETURNING *`;
      return { household, member };
    },
  );

  addTool(
    server,
    "household_get",
    "Everything about a household: details, society, members, appliances and the technicians it already knows.",
    z.object({ household_id: z.string() }),
    async ({ household_id }) => {
      const household = await getOrFail("households", household_id, "HOUSEHOLD_NOT_FOUND", "household");
      const [society] = household.society_id ? await sql`SELECT * FROM societies WHERE id = ${household.society_id}` : [];
      const members = await sql`SELECT * FROM members WHERE household_id = ${household_id} ORDER BY created_at`;
      const appliances = await sql`
        SELECT id, type, brand, model, status, brand_only, warranty_end, amc_provider, amc_next_due
        FROM appliances WHERE household_id = ${household_id} ORDER BY type`;
      const technicians = await sql`
        SELECT t.id, t.name, t.phone, ht.appliance_types, ht.relationship
        FROM household_technicians ht JOIN technicians t ON t.id = ht.technician_id
        WHERE ht.household_id = ${household_id} ORDER BY t.name`;
      return { household, society: society ?? null, members, appliances, technicians };
    },
  );

  addTool(
    server,
    "household_update",
    "Change household details. Only the fields you pass are changed.",
    z.object({
      household_id: z.string(),
      fields: z.strictObject({
        name: z.string(),
        flat: z.string(),
        address: z.string(),
        latitude: z.number(),
        longitude: z.number(),
        primary_phone: zPhone,
        language: z.string(),
        availability: zAvailability,
        spend_limit: z.number().int().min(0).describe("Rupees Janus may approve without asking"),
        society_id: z.string(),
      }).partial(),
    }),
    async ({ household_id, fields }) => {
      await getOrFail("households", household_id, "HOUSEHOLD_NOT_FOUND", "household");
      const clean = { ...fields, primary_phone: fields.primary_phone ? phoneOrFail(fields.primary_phone) : undefined };
      const household = await updateRow("households", household_id, clean, { touchUpdatedAt: true });
      return { household };
    },
  );

  addTool(
    server,
    "member_add",
    "Add a family member to a household. role: 'notified' (kept informed), 'decider' (approves spending) or 'both'.",
    z.object({
      household_id: z.string(),
      phone: zPhone,
      name: z.string().min(1),
      role: zRole,
      language: z.string().optional(),
    }),
    async (a) => {
      await getOrFail("households", a.household_id, "HOUSEHOLD_NOT_FOUND", "household");
      const phone = phoneOrFail(a.phone);
      await failIfPhoneTaken(phone);
      const [member] = await sql`
        INSERT INTO members (household_id, phone, name, role, language)
        VALUES (${a.household_id}, ${phone}, ${a.name}, ${a.role}, ${a.language ?? null}) RETURNING *`;
      return { member };
    },
  );

  addTool(
    server,
    "onboarding_get",
    "Where a household is in onboarding: current step and everything collected so far.",
    z.object({ household_id: z.string() }),
    async ({ household_id }) => {
      const h = await getOrFail("households", household_id, "HOUSEHOLD_NOT_FOUND", "household");
      return { household_id, step: h.onboarding_step, data: h.onboarding_data };
    },
  );

  addTool(
    server,
    "onboarding_save",
    "Save onboarding progress. Sets the current step and MERGES `data` into what was saved before (existing keys are overwritten). Use step 'done' when finished.",
    z.object({
      household_id: z.string(),
      step: z.string().min(1),
      data: z.record(z.string(), z.unknown()).default({}),
    }),
    async ({ household_id, step, data }) => {
      await getOrFail("households", household_id, "HOUSEHOLD_NOT_FOUND", "household");
      const [h] = await sql`
        UPDATE households
        SET onboarding_step = ${step}, onboarding_data = onboarding_data || ${toDbValue(data)}::jsonb, updated_at = now()
        WHERE id = ${household_id}
        RETURNING onboarding_step, onboarding_data`;
      return { household_id, step: h.onboarding_step, data: h.onboarding_data };
    },
  );
}
