import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getOrFail, sql, updateRow } from "@/lib/db";
import { addTool } from "@/lib/mcp";
import { phoneOrFail, zPhone } from "@/lib/phone";

const zContactPref = z.enum(["text", "call", "voice_note"]);
const zAvailabilityStatus = z.enum(["available", "busy", "away", "unknown"]);

// Technician details plus reputation. Ratings that were later replaced are ignored.
// The price range across all households is only shown with >= 3 payments, so no single neighbour's amount leaks.
async function technicianProfiles(technicianIds: string[], applianceType: string | null, householdId: string | null) {
  if (technicianIds.length === 0) return new Map<string, Record<string, unknown>>();
  const rows = await sql`
    SELECT t.id, t.name, t.phone, t.skills, t.contact_pref, t.languages, t.opted_in, t.availability_status,
           t.availability_until, t.source, t.area, t.upi_id,
           json_build_object(
             'ratings', rs.n, 'on_time_pct', rs.on_time_pct, 'fixed_pct', rs.fixed_pct,
             'fair_price_pct', rs.fair_price_pct, 'reachable_pct', rs.reachable_pct) AS rating_summary,
           (SELECT count(*)::int FROM complaints c
             WHERE c.technician_id = t.id AND c.status IN ('open', 'in_progress')) AS open_complaints,
           CASE WHEN ${householdId}::text IS NULL THEN NULL ELSE json_build_object(
             'jobs_paid', own.n, 'last_paid', own.last_paid, 'last_paid_at', own.last_paid_at) END AS your_history,
           CASE WHEN allp.n >= 3 THEN json_build_object('min', allp.min_total, 'max', allp.max_total, 'data_points', allp.n)
                ELSE NULL END AS typical_price_range
    FROM technicians t
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n,
             round(100 * avg(r.on_time::int))::int AS on_time_pct,
             round(100 * avg(r.fixed::int))::int AS fixed_pct,
             round(100 * avg(r.fair_price::int))::int AS fair_price_pct,
             round(100 * avg(r.reachable::int))::int AS reachable_pct
      FROM ratings r
      WHERE r.technician_id = t.id
        AND NOT EXISTS (SELECT 1 FROM ratings newer WHERE newer.replaces_rating_id = r.id)
    ) rs ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n,
             (array_agg(p.total ORDER BY p.paid_at DESC))[1] AS last_paid,
             max(p.paid_at) AS last_paid_at
      FROM price_ledger p
      WHERE p.technician_id = t.id AND p.household_id = ${householdId}
        AND (${applianceType}::text IS NULL OR p.appliance_type = ${applianceType})
    ) own ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n, min(p.total) AS min_total, max(p.total) AS max_total
      FROM price_ledger p
      WHERE p.technician_id = t.id AND p.confirmed
        AND (${applianceType}::text IS NULL OR p.appliance_type = ${applianceType})
    ) allp ON true
    WHERE t.id = ANY(${technicianIds}::text[])`;
  return new Map(rows.map((r) => [r.id as string, r]));
}

// Insert a technician, or return the existing one with that phone (merging any new skills).
async function upsertTechnician(t: {
  name: string;
  phone: string;
  skills: string[];
  contact_pref?: string;
  languages?: string[];
  opted_in?: boolean;
  source: string;
  upi_id?: string;
  area?: string;
}) {
  const [existing] = await sql`SELECT * FROM technicians WHERE phone = ${t.phone}`;
  if (existing) {
    const [merged] = await sql`
      UPDATE technicians
      SET skills = ARRAY(SELECT DISTINCT unnest(skills || ${t.skills}::text[])), updated_at = now()
      WHERE id = ${existing.id} RETURNING *`;
    return { technician: merged, already_existed: true };
  }
  const [technician] = await sql`
    INSERT INTO technicians (name, phone, skills, contact_pref, languages, opted_in, source, upi_id, area)
    VALUES (${t.name}, ${t.phone}, ${t.skills}, ${t.contact_pref ?? "text"}, ${t.languages ?? []},
            ${t.opted_in ?? false}, ${t.source}, ${t.upi_id ?? null}, ${t.area ?? null})
    RETURNING *`;
  return { technician, already_existed: false };
}

export function registerTechnicianTools(server: McpServer) {
  addTool(
    server,
    "technician_add",
    "Add a technician. If the phone is already known, returns the existing technician (already_existed:true) and merges skills. Pass household_id to also add him to that household's own list.",
    z.object({
      name: z.string().min(1),
      phone: zPhone,
      skills: z.array(z.string()).min(1).describe("Appliance types he repairs, e.g. ['ac','fridge']"),
      contact_pref: zContactPref.optional(),
      languages: z.array(z.string()).optional(),
      opted_in: z.boolean().optional().describe("Has he agreed to receive WhatsApp messages from Janus?"),
      upi_id: z.string().optional(),
      area: z.string().optional(),
      household_id: z.string().optional(),
      appliance_types: z.array(z.string()).optional().describe("Which of the household's appliances he handles (defaults to skills)"),
      relationship: z.enum(["known", "amc"]).default("known"),
    }),
    async (a) => {
      const phone = phoneOrFail(a.phone);
      if (a.household_id) await getOrFail("households", a.household_id, "HOUSEHOLD_NOT_FOUND", "household");
      const result = await upsertTechnician({ ...a, phone, source: "household" });
      if (a.household_id) {
        await sql`
          INSERT INTO household_technicians (household_id, technician_id, appliance_types, relationship)
          VALUES (${a.household_id}, ${result.technician.id}, ${a.appliance_types ?? a.skills}, ${a.relationship})
          ON CONFLICT (household_id, technician_id) DO UPDATE
          SET appliance_types = ARRAY(SELECT DISTINCT unnest(household_technicians.appliance_types || EXCLUDED.appliance_types)),
              relationship = EXCLUDED.relationship`;
      }
      return { ...result, linked_to_household: a.household_id ?? null };
    },
  );

  addTool(
    server,
    "technician_update",
    "Change a technician. Use availability_status + availability_until when he says he is busy or away (e.g. 'at my village till Monday').",
    z.object({
      technician_id: z.string(),
      fields: z.strictObject({
        name: z.string(),
        skills: z.array(z.string()),
        contact_pref: zContactPref,
        languages: z.array(z.string()),
        opted_in: z.boolean(),
        availability_status: zAvailabilityStatus,
        availability_until: z.iso.datetime({ offset: true }).nullable(),
        upi_id: z.string(),
        area: z.string(),
      }).partial(),
    }),
    async ({ technician_id, fields }) => {
      await getOrFail("technicians", technician_id, "TECHNICIAN_NOT_FOUND", "technician");
      const technician = await updateRow("technicians", technician_id, fields, { touchUpdatedAt: true });
      return { technician };
    },
  );

  addTool(
    server,
    "technician_list_for_appliance",
    "Who can fix this appliance for this household? The household's own technicians come first, then ones recommended in its society. Each has rating_summary, open_complaints, your_history and typical_price_range. Warns if the household's appliance of this type must go to the brand.",
    z.object({ household_id: z.string(), appliance_type: z.string() }),
    async ({ household_id, appliance_type }) => {
      const household = await getOrFail("households", household_id, "HOUSEHOLD_NOT_FOUND", "household");

      const own = await sql`
        SELECT ht.technician_id, ht.relationship, ht.note
        FROM household_technicians ht JOIN technicians t ON t.id = ht.technician_id
        WHERE ht.household_id = ${household_id}
          AND (${appliance_type} = ANY(ht.appliance_types) OR ${appliance_type} = ANY(t.skills))
        ORDER BY ht.relationship DESC, ht.added_at`;
      const ownIds = own.map((r) => r.technician_id as string);

      const society = household.society_id
        ? await sql`
            SELECT sl.technician_id, count(*)::int AS recommendations, array_agg(sl.note) FILTER (WHERE sl.note IS NOT NULL) AS notes
            FROM society_log sl JOIN technicians t ON t.id = sl.technician_id
            WHERE sl.society_id = ${household.society_id}
              AND (${appliance_type} = ANY(sl.appliance_types) OR ${appliance_type} = ANY(t.skills))
              AND NOT (sl.technician_id = ANY(${ownIds}::text[]))
            GROUP BY sl.technician_id
            ORDER BY count(*) DESC`
        : [];

      const profiles = await technicianProfiles(
        [...ownIds, ...society.map((r) => r.technician_id as string)],
        appliance_type,
        household_id,
      );
      const technicians = [
        ...own.map((r) => ({ relationship: r.relationship, note: r.note, ...profiles.get(r.technician_id as string) })),
        ...society.map((r) => ({
          relationship: "society_log",
          society_recommendations: r.recommendations,
          society_notes: r.notes ?? [],
          ...profiles.get(r.technician_id as string),
        })),
      ];

      const brandOnly = await sql`
        SELECT id, brand, warranty_end FROM appliances
        WHERE household_id = ${household_id} AND type = ${appliance_type} AND brand_only AND status <> 'retired'`;
      return {
        household_id,
        appliance_type,
        technicians,
        brand_only_warning: brandOnly.length
          ? `This household's ${appliance_type} (${brandOnly.map((b) => b.brand).join(", ")}) must be repaired by the brand's service centre (route 'brand'), not a local technician.`
          : null,
      };
    },
  );

  addTool(
    server,
    "society_log_add",
    "Record a technician recommended inside a society. Creates the technician if his phone is new (source 'society_log').",
    z.object({
      society_id: z.string(),
      technician: z.object({
        name: z.string().min(1),
        phone: zPhone,
        skills: z.array(z.string()).min(1),
        contact_pref: zContactPref.optional(),
      }),
      appliance_types: z.array(z.string()).optional().describe("Defaults to the technician's skills"),
      added_by_member_id: z.string(),
      note: z.string().optional(),
    }),
    async (a) => {
      await getOrFail("societies", a.society_id, "SOCIETY_NOT_FOUND", "society");
      await getOrFail("members", a.added_by_member_id, "MEMBER_NOT_FOUND", "member");
      const phone = phoneOrFail(a.technician.phone);
      const { technician, already_existed } = await upsertTechnician({ ...a.technician, phone, source: "society_log" });
      const [entry] = await sql`
        INSERT INTO society_log (society_id, technician_id, appliance_types, added_by_member_id, note)
        VALUES (${a.society_id}, ${technician.id}, ${a.appliance_types ?? a.technician.skills}, ${a.added_by_member_id}, ${a.note ?? null})
        RETURNING *`;
      return { technician, technician_already_known: already_existed, log_entry: entry };
    },
  );

  addTool(
    server,
    "society_log_search",
    "Technicians recommended in a society for an appliance type. Duplicate entries for the same phone are merged (see recommendations count). Each has rating_summary, open_complaints and typical_price_range.",
    z.object({ society_id: z.string(), appliance_type: z.string() }),
    async ({ society_id, appliance_type }) => {
      await getOrFail("societies", society_id, "SOCIETY_NOT_FOUND", "society");
      const rows = await sql`
        SELECT sl.technician_id, count(*)::int AS recommendations,
               array_agg(sl.note) FILTER (WHERE sl.note IS NOT NULL) AS notes, max(sl.created_at) AS last_recommended_at
        FROM society_log sl JOIN technicians t ON t.id = sl.technician_id
        WHERE sl.society_id = ${society_id}
          AND (${appliance_type} = ANY(sl.appliance_types) OR ${appliance_type} = ANY(t.skills))
        GROUP BY sl.technician_id
        ORDER BY count(*) DESC`;
      const profiles = await technicianProfiles(rows.map((r) => r.technician_id as string), appliance_type, null);
      const technicians = rows.map((r) => {
        const { your_history, ...profile } = profiles.get(r.technician_id as string) ?? {};
        void your_history;
        return {
          ...profile,
          recommendations: r.recommendations,
          notes: r.notes ?? [],
          last_recommended_at: r.last_recommended_at,
        };
      });
      return { society_id, appliance_type, technicians };
    },
  );
}
