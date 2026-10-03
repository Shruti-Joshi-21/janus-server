// The 3 custom capabilities (competition rule: up to 3 things Gnani, Pine Labs or Delhivery don't offer today,
// each attributable to one partner and the data it already holds). They use our normal { ok, … } format
// and every answer names its `partner`.
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getOrFail, sql } from "@/lib/db";
import { haversineKm, ROAD_FACTOR } from "@/lib/geo";
import { addTool, ToolError } from "@/lib/mcp";
import { phoneOrFail, zPhone } from "@/lib/phone";
import { sleep, takeScenario, TIMEOUT_DELAY_MS } from "@/lib/scenarios";

const PRESENT_WITHIN_M = 200; // GPS accuracy + the size of a housing society
const STALE_AFTER_MIN = 15;
const MOTORCYCLE_KMH = 25;

async function simulatedTimeout(partner: string): Promise<never> {
  await sleep(TIMEOUT_DELAY_MS);
  throw new ToolError("TIMEOUT", `${partner} did not answer in time (simulated by scenario switch).`, { partner, http_status: 504, simulated: true });
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
// "Sunil Jadhav" → "S**** J*****"
const maskName = (s: string) => s.split(/\s+/).map((w) => w[0] + "*".repeat(Math.max(0, w.length - 1))).join(" ");

export function registerCustomTools(server: McpServer) {
  addTool(
    server,
    "proof_of_presence",
    `Is the technician really at the household? Compares the location he shared (latitude/longitude + when it was taken) with the household's geocoded address and the job's agreed slot. present: true (within ${PRESENT_WITHIN_M} m), false (farther away), or unknown (no location shared, location older than ${STALE_AFTER_MIN} minutes, or he isn't this job's technician). Partner: Delhivery (GPS pings and geocoded addresses).`,
    z.object({
      job_id: z.string(),
      technician_phone: zPhone,
      latitude: z.number().min(-90).max(90).nullable().optional().describe("From the WhatsApp location he shared; omit or null if he shared none"),
      longitude: z.number().min(-180).max(180).nullable().optional(),
      timestamp: z.iso.datetime({ offset: true }).describe("When the location was taken (ISO with offset), e.g. the message's received_at"),
    }),
    async (a) => {
      const scenario = await takeScenario("custom.next_presence");
      if (scenario === "timeout") await simulatedTimeout("Delhivery");
      const phone = phoneOrFail(a.technician_phone);
      const job = await getOrFail("jobs", a.job_id, "JOB_NOT_FOUND", "job");
      const household = await getOrFail("households", job.household_id as string, "HOUSEHOLD_NOT_FOUND", "household");
      const [technician] = job.technician_id ? await sql`SELECT id, name, phone FROM technicians WHERE id = ${job.technician_id}` : [];

      const slot = job.confirmed_slot ? new Date(job.confirmed_slot as string) : null;
      const sharedAt = new Date(a.timestamp);
      const minutesFromSlot = slot ? Math.round((sharedAt.getTime() - slot.getTime()) / 60_000) : null;
      const ageMin = Math.round((Date.now() - sharedAt.getTime()) / 60_000);
      const base = {
        partner: "Delhivery",
        job_id: a.job_id,
        technician: technician ? { id: technician.id, name: technician.name } : null,
        household_location: { latitude: household.latitude, longitude: household.longitude, address: household.address },
        confirmed_slot: slot?.toISOString() ?? null,
        minutes_from_slot: minutesFromSlot,
        location_age_minutes: ageMin,
      };
      const unknown = (reason: string, explanation: string, extra: Record<string, unknown> = {}) => ({ ...base, present: "unknown", distance_m: null, reason, explanation, ...extra });

      if (!technician || technician.phone !== phone) {
        return unknown("not_job_technician", `${phone} is not the technician assigned to this job.`);
      }
      if (scenario === "no_location" || a.latitude == null || a.longitude == null) {
        return unknown("no_location", "No location was shared. Ask the technician to share his live location on WhatsApp.");
      }
      if (scenario === "stale_location" || ageMin > STALE_AFTER_MIN) {
        return unknown("stale_location", `The shared location is ${scenario === "stale_location" ? "more than 15" : ageMin} minutes old (limit ${STALE_AFTER_MIN}). Ask for a fresh location.`, scenario === "stale_location" ? { simulated: true } : {});
      }
      if (household.latitude == null || household.longitude == null) {
        return unknown("household_not_geocoded", "The household's address has no coordinates yet. Geocode it first (Delhivery geocode_address) and save them with household_update.");
      }

      const distanceM = Math.round(haversineKm(a.latitude, a.longitude, household.latitude as number, household.longitude as number) * 1000);
      const present = scenario === "not_present" ? false : distanceM <= PRESENT_WITHIN_M;
      const days = minutesFromSlot === null ? 0 : Math.round(Math.abs(minutesFromSlot) / 1440);
      const timing =
        minutesFromSlot === null ? "No slot was agreed for this job."
        : Math.abs(minutesFromSlot) >= 1440 ? `Not on the day of the agreed slot (${days} day${days === 1 ? "" : "s"} ${minutesFromSlot > 0 ? "after" : "before"} it).`
        : minutesFromSlot > 15 ? `${minutesFromSlot} minutes after the agreed slot.`
        : minutesFromSlot < -30 ? `${-minutesFromSlot} minutes before the agreed slot.`
        : "Around the agreed slot.";
      return {
        ...base,
        present,
        distance_m: scenario === "not_present" ? Math.max(distanceM, 2400) : distanceM,
        reason: present ? "at_household" : "too_far",
        explanation: present
          ? `${technician.name} is ${distanceM} m from the household. ${timing}`
          : `${technician.name} is ${(scenario === "not_present" ? Math.max(distanceM, 2400) : distanceM).toLocaleString("en-IN")} m away, not at the household. ${timing}`,
        ...(scenario === "not_present" ? { simulated: true } : {}),
      };
    },
  );

  addTool(
    server,
    "technician_discovery",
    "Find repair businesses near a location that fix this appliance, nearest first: name, business, phone, skills, rating, distance_m and motorcycle ETA, source 'delhivery_poi'. Use when the household's own and society technicians are unavailable. Partner: Delhivery (POI / business data behind its Autosuggest).",
    z.object({
      appliance_type: z.string().min(1),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      radius_m: z.number().int().min(100).max(25_000).default(3000),
    }),
    async (a) => {
      const scenario = await takeScenario("custom.next_discovery");
      if (scenario === "timeout") await simulatedTimeout("Delhivery");
      const rows = await sql`
        SELECT d.*, t.id AS known_technician_id
        FROM technician_directory d LEFT JOIN technicians t ON t.phone = d.phone
        WHERE ${a.appliance_type} = ANY(d.skills)`;
      const all = rows
        .map((r) => {
          const km = haversineKm(a.latitude, a.longitude, r.latitude as number, r.longitude as number);
          return {
            name: r.name, business_name: r.business_name, phone: r.phone, skills: r.skills, rating: r.rating, address: r.address,
            latitude: r.latitude, longitude: r.longitude,
            distance_m: Math.round(km * 1000),
            eta_minutes_motorcycle: Math.max(1, Math.round(((km * ROAD_FACTOR) / MOTORCYCLE_KMH) * 60)),
            already_known_technician_id: r.known_technician_id ?? null,
            source: r.source,
          };
        })
        .sort((x, y) => x.distance_m - y.distance_m);
      const inRadius = scenario === "none_found" ? [] : all.filter((t) => t.distance_m <= a.radius_m);
      const nearestOutside = all.find((t) => t.distance_m > a.radius_m);
      return {
        partner: "Delhivery",
        appliance_type: a.appliance_type,
        radius_m: a.radius_m,
        count: inRadius.length,
        technicians: inRadius,
        reason: inRadius.length ? "found" : "none_found",
        ...(inRadius.length === 0 && nearestOutside && scenario !== "none_found"
          ? { nearest_outside_radius_m: nearestOutside.distance_m, hint: `Nearest ${a.appliance_type} business is ${nearestOutside.distance_m} m away; widen radius_m to include it.` }
          : {}),
        ...(scenario === "none_found" ? { simulated: true } : {}),
      };
    },
  );

  addTool(
    server,
    "technician_identity_check",
    "Is this technician who he says he is? Checks his name, phone and (optionally) UPI ID against the KYC Pine Labs holds for merchants it onboarded for UPI/QR acceptance. status: verified (name matches; UPI too if given), mismatch (phone is a Pine Labs merchant but the name or UPI ID differs; registered name is masked), not_found (not a Pine Labs merchant). Use before paying a new technician. Partner: Pine Labs (merchant KYC).",
    z.object({
      name: z.string().min(1),
      phone: zPhone,
      upi_id: z.string().optional(),
    }),
    async (a) => {
      const scenario = await takeScenario("custom.next_identity");
      if (scenario === "timeout") await simulatedTimeout("Pine Labs");
      const phone = phoneOrFail(a.phone);
      const checked_at = new Date().toISOString();
      const [m] = await sql`SELECT * FROM pine_merchants WHERE phone = ${phone}`;

      if (scenario === "not_found" || !m || m.kyc_status !== "verified") {
        return {
          partner: "Pine Labs", status: "not_found", matched_fields: [], mismatched_fields: [], checked_at,
          explanation: m && m.kyc_status !== "verified" ? `This phone's Pine Labs KYC is ${m.kyc_status}, not verified.` : "This phone is not a Pine Labs merchant, so there is no KYC to check against. Ask for another proof of identity.",
          ...(scenario === "not_found" ? { simulated: true } : {}),
        };
      }

      // Name matches if every word of the given name appears in the KYC legal name (handles "Ramesh" vs "Ramesh Patil").
      const legal = words(m.legal_name as string);
      const given = words(a.name);
      const nameOk = given.length > 0 && given.every((w) => legal.includes(w));
      const upiOk = a.upi_id ? (m.upi_id as string | null)?.toLowerCase() === a.upi_id.trim().toLowerCase() : null;
      const matched = ["phone", ...(nameOk ? ["name"] : []), ...(upiOk ? ["upi_id"] : [])];
      const mismatched = [...(nameOk ? [] : ["name"]), ...(upiOk === false ? ["upi_id"] : [])];
      let status = mismatched.length ? "mismatch" : "verified";
      if (scenario === "verified") status = "verified";
      if (scenario === "mismatch") status = "mismatch";

      return {
        partner: "Pine Labs",
        status,
        matched_fields: scenario === "mismatch" ? ["phone"] : matched,
        mismatched_fields: scenario === "mismatch" ? ["name"] : scenario === "verified" ? [] : mismatched,
        merchant: { display_name: m.display_name, city: m.city, onboarded_at: m.onboarded_at },
        ...(status === "mismatch" ? { registered_name_hint: maskName(m.legal_name as string) } : {}),
        checked_at,
        explanation:
          status === "verified"
            ? `${a.name} matches the KYC of Pine Labs merchant "${m.display_name}"${upiOk ? " and the UPI ID matches" : ""}.`
            : `This phone belongs to Pine Labs merchant "${m.display_name}", registered under a different ${mismatched.includes("upi_id") && nameOk ? "UPI ID" : "name"} (${maskName(m.legal_name as string)}). Don't pay until the household confirms who this is.`,
        ...(scenario === "verified" || scenario === "mismatch" ? { simulated: true } : {}),
      };
    },
  );
}
