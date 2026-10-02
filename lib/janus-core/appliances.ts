import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getOrFail, sql, updateRow } from "@/lib/db";
import { addTool } from "@/lib/mcp";

const applianceFields = {
  type: z.string().min(1).describe("'ac', 'fridge', 'ro_purifier', 'washing_machine', …"),
  brand: z.string(),
  model: z.string(),
  serial: z.string(),
  purchase_date: z.iso.date(),
  warranty_end: z.iso.date(),
  brand_only: z.boolean().describe("true = repairs must go through the brand's service centre (e.g. under warranty)"),
  amc_provider: z.string(),
  amc_technician_id: z.string(),
  amc_end: z.iso.date(),
  amc_visit_every_months: z.number().int().min(1),
  amc_next_due: z.iso.date(),
  status: z.enum(["working", "faulty", "under_repair", "retired"]),
  note: z.string(),
};

// Adds under_warranty / amc_active / days_until_amc_due, using today's date in India.
const WITH_STATUS = `
  a.*,
  (a.warranty_end IS NOT NULL AND a.warranty_end >= (now() AT TIME ZONE 'Asia/Kolkata')::date) AS under_warranty,
  (a.amc_end IS NOT NULL AND a.amc_end >= (now() AT TIME ZONE 'Asia/Kolkata')::date) AS amc_active,
  (a.amc_next_due - (now() AT TIME ZONE 'Asia/Kolkata')::date) AS days_until_amc_due`;

export async function getAppliance(id: string) {
  await getOrFail("appliances", id, "APPLIANCE_NOT_FOUND", "appliance");
  const rows = await sql.query(`SELECT ${WITH_STATUS} FROM appliances a WHERE a.id = $1`, [id]);
  return rows[0];
}

export function registerApplianceTools(server: McpServer) {
  addTool(
    server,
    "appliance_add",
    "Add an appliance to a household. Dates are YYYY-MM-DD.",
    z.object({
      household_id: z.string(),
      ...applianceFields,
      brand: applianceFields.brand.optional(),
      model: applianceFields.model.optional(),
      serial: applianceFields.serial.optional(),
      purchase_date: applianceFields.purchase_date.optional(),
      warranty_end: applianceFields.warranty_end.optional(),
      brand_only: applianceFields.brand_only.default(false),
      amc_provider: applianceFields.amc_provider.optional(),
      amc_technician_id: applianceFields.amc_technician_id.optional(),
      amc_end: applianceFields.amc_end.optional(),
      amc_visit_every_months: applianceFields.amc_visit_every_months.optional(),
      amc_next_due: applianceFields.amc_next_due.optional(),
      status: applianceFields.status.default("working"),
      note: applianceFields.note.optional(),
    }),
    async (a) => {
      await getOrFail("households", a.household_id, "HOUSEHOLD_NOT_FOUND", "household");
      const [row] = await sql`
        INSERT INTO appliances (household_id, type, brand, model, serial, purchase_date, warranty_end, brand_only,
                                amc_provider, amc_technician_id, amc_end, amc_visit_every_months, amc_next_due, status, note)
        VALUES (${a.household_id}, ${a.type}, ${a.brand ?? null}, ${a.model ?? null}, ${a.serial ?? null},
                ${a.purchase_date ?? null}, ${a.warranty_end ?? null}, ${a.brand_only}, ${a.amc_provider ?? null},
                ${a.amc_technician_id ?? null}, ${a.amc_end ?? null}, ${a.amc_visit_every_months ?? null},
                ${a.amc_next_due ?? null}, ${a.status}, ${a.note ?? null})
        RETURNING id`;
      return { appliance: await getAppliance(row.id as string) };
    },
  );

  addTool(
    server,
    "appliance_update",
    "Change an appliance. Only the fields you pass are changed (e.g. status 'faulty', or the next AMC due date after a visit).",
    z.object({
      appliance_id: z.string(),
      fields: z.strictObject(applianceFields).partial(),
    }),
    async ({ appliance_id, fields }) => {
      await getOrFail("appliances", appliance_id, "APPLIANCE_NOT_FOUND", "appliance");
      await updateRow("appliances", appliance_id, fields, { touchUpdatedAt: true });
      return { appliance: await getAppliance(appliance_id) };
    },
  );

  addTool(
    server,
    "appliance_list",
    "All appliances of a household, each with under_warranty, amc_active and days_until_amc_due worked out for today (India time).",
    z.object({ household_id: z.string() }),
    async ({ household_id }) => {
      await getOrFail("households", household_id, "HOUSEHOLD_NOT_FOUND", "household");
      const appliances = await sql.query(
        `SELECT ${WITH_STATUS} FROM appliances a WHERE a.household_id = $1 AND a.status <> 'retired' ORDER BY a.type`,
        [household_id],
      );
      return { household_id, appliances };
    },
  );
}
