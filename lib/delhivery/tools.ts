// Delhivery Maps mock. Tool names come from Delhivery's MCP server (delhivery.com/maps/developer);
// request and response fields are copied from their OpenAPI spec (delhivery.com/maps/openapi.json).
// See MOCKS.md for what is verified and what is assumed.
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { haversineKm, insideIndia, ROAD_FACTOR } from "@/lib/geo";
import { addMockTool, type MockReply } from "@/lib/mcp";
import { sleep, takeScenario, TIMEOUT_DELAY_MS } from "@/lib/scenarios";
import { findFlat, findPincode, formattedComponents, inlineCorrections, loadPlaces, matchPlace, type Place } from "./places";

const PUNE_CENTRE = { lat: 18.5204, lng: 73.8567 };
const SPEED_KMH: Record<string, number> = { motorcycle: 25, auto: 22, truck: 18, pedestrian: 4.5 }; // Pune city traffic
const MAX_PAIRS = 40000;

const ok = (body: unknown): MockReply => ({ status: 200, body });
const err = (status: number, body: unknown): MockReply => ({ status, body });
const malformed = (prefix: string): MockReply => ({ malformed: `${prefix.slice(0, 40)}` });
const istDate = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const firstIssue = (issues: z.core.$ZodIssue[]) => issues[0]?.message ?? "invalid input";

type Granularity = "PREMISE" | "STREET_LANDMARK" | "SUBLOCALITY_VILLAGE" | "LOCALITY" | "CITY_PINCODE" | "NONE";
type Reason = "valid" | "incomplete" | "correction_needed" | "invalid_or_junk";

// The shared heart of /validate and /verify.
function validate(address: string, places: Place[], opts: { ignoreFlat?: boolean } = {}) {
  const place = matchPlace(address, places);
  const flat = opts.ignoreFlat ? null : findFlat(address);
  const pincode = findPincode(address);

  if (!place) {
    const pinPlace = pincode ? places.find((p) => p.pincode === pincode) : null;
    if (pinPlace || /\bpune\b/i.test(address)) {
      const components = [pinPlace?.city ?? "Pune", pinPlace?.state ?? "Maharashtra", ...(pinPlace ? [pinPlace.pincode] : [])];
      return {
        place: pinPlace ?? null,
        result: { quality: "not_ok", granularity_level: "CITY_PINCODE" as Granularity, reason: "incomplete" as Reason,
          formatted_address: components.join(", "), corrections: inlineCorrections(address, components, null, null) },
      };
    }
    return { place: null, result: { quality: "not_ok", granularity_level: "NONE" as Granularity, reason: "invalid_or_junk" as Reason, formatted_address: "", corrections: "" } };
  }

  const usesFlat = place.kind === "building" && flat !== null;
  const granularity: Granularity = usesFlat ? "PREMISE" : place.kind === "locality" ? "LOCALITY" : "STREET_LANDMARK";
  const wrongPincode = pincode && pincode !== place.pincode ? pincode : null;
  const reason: Reason = !usesFlat ? "incomplete" : wrongPincode ? "correction_needed" : "valid";
  const components = formattedComponents(place, usesFlat ? flat!.label : null);
  return {
    place,
    result: {
      quality: reason === "valid" ? "ok" : "not_ok",
      granularity_level: granularity,
      reason,
      formatted_address: components.join(", "),
      corrections: inlineCorrections(address, components, usesFlat ? flat : null, wrongPincode),
    },
  };
}

function geocodeRadius(place: Place, granularity: Granularity): number {
  if (granularity === "PREMISE") return 15;
  if (place.kind === "building") return 35;
  if (place.kind === "street" || place.kind === "poi") return 120;
  return 900;
}

// Google-format address components, as in Delhivery's /rvg example.
function rvgComponents(place: Place) {
  const comps: { long_name: string; short_name: string; types: string[] }[] = [];
  const parts = place.address_line.split(", ");
  if (place.kind === "building") comps.push({ long_name: place.name, short_name: place.name, types: ["premise"] });
  const street = place.kind === "building" ? parts[1] : place.kind === "locality" ? null : parts[0];
  if (street && street !== place.locality) comps.push({ long_name: street, short_name: street, types: ["route"] });
  if (place.locality) comps.push({ long_name: place.locality, short_name: place.locality, types: ["sublocality_level_1", "sublocality", "political"] });
  comps.push(
    { long_name: place.city, short_name: place.city, types: ["locality", "political"] },
    { long_name: place.state, short_name: "MH", types: ["administrative_area_level_1", "political"] },
    { long_name: place.pincode, short_name: place.pincode, types: ["postal_code"] },
    { long_name: "India", short_name: "IN", types: ["country", "political"] },
  );
  return comps;
}

const entityId = (key: string) => String([...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 900_000_000 + 100_000_000);

export function registerDelhiveryTools(server: McpServer) {
  addMockTool(
    server,
    "validate_address",
    "Delhivery: identifies address errors or missing details and returns a corrected version. Response: quality (ok|not_ok), granularity_level (PREMISE…NONE), reason (valid|incomplete|correction_needed|invalid_or_junk), formatted_address, corrections (inline diff: <old|new>, <|added>), request_id, req_id.",
    z.object({ address: z.string().optional(), req_id: z.string().optional() }),
    async ({ address, req_id }) => {
      const request_id = randomUUID();
      if (!address?.trim()) return err(400, { error: "No address provided", request_id });
      const scenario = await takeScenario("delhivery.next_validate");
      if (scenario === "timeout") {
        await sleep(TIMEOUT_DELAY_MS);
        return err(504, { error: "Request timed out", detail: "OpenSearch search timed out (10.0s budget)", request_id });
      }
      if (scenario === "malformed") return malformed(`{"quality": "ok", "granularity_level": "PREM`);
      const places = await loadPlaces();
      const { result } =
        scenario === "not_found" ? validate("", []) : validate(address, places, { ignoreFlat: scenario === "incomplete" });
      return ok({ ...result, request_id, ...(req_id ? { req_id } : {}) });
    },
    () => err(400, { error: "Invalid or malformed JSON in request body" }),
  );

  addMockTool(
    server,
    "verify_address",
    "Delhivery: confirms if an address is valid and checks if Delhivery has delivered there within the last `months` (1–24). Validation runs first; is_verified needs a PREMISE-level match. Response: validation fields + is_verified, last_visited_date (YYYY-MM-DD or null), verification_reasoning, request_id, req_id.",
    z.object({ address: z.string().optional(), months: z.unknown().optional(), req_id: z.string().optional() }),
    async ({ address, months, req_id }) => {
      const request_id = randomUUID();
      if (months === undefined || months === null) return err(400, { error: "'months' is a required field.", request_id });
      if (typeof months !== "number" || !Number.isInteger(months) || months < 1 || months > 24) {
        return err(400, { error: "Invalid 'months' value. Must be integer between 1 and 24.", request_id });
      }
      if (!address?.trim()) return err(400, { error: "No address provided", request_id });
      const scenario = await takeScenario("delhivery.next_validate");
      if (scenario === "timeout") {
        await sleep(TIMEOUT_DELAY_MS);
        return err(504, { error: "Request timed out", detail: "OpenSearch verification search timed out (10.0s budget)", request_id });
      }
      if (scenario === "malformed") return malformed(`{"quality": "ok", "is_verified": tr`);
      const places = await loadPlaces();
      const { place, result } =
        scenario === "not_found" ? validate("", []) : validate(address, places, { ignoreFlat: scenario === "incomplete" });

      let is_verified = false;
      let last_visited_date: string | null = null;
      let verification_reasoning: string;
      if (result.granularity_level !== "PREMISE" || !place) {
        verification_reasoning = result.reason === "invalid_or_junk" ? "Address could not be resolved." : "Address not specific enough (PREMISE level required).";
      } else if (place.last_delivered_days_ago !== null && place.last_delivered_days_ago <= months * 30) {
        is_verified = true;
        last_visited_date = istDate(place.last_delivered_days_ago);
        verification_reasoning = `Doorstep match: same ${place.name}, same locality, pincode ${place.pincode} matches.`;
      } else {
        verification_reasoning = `No candidates found within ${months}-month window.`;
      }
      return ok({ ...result, is_verified, last_visited_date, verification_reasoning, request_id, ...(req_id ? { req_id } : {}) });
    },
    () => err(400, { error: "Invalid or malformed JSON in request body" }),
  );

  addMockTool(
    server,
    "geocode_address",
    "Delhivery: converts an address into latitude and longitude. Response: req_id, lat, lng, error_radius (metres; lower = more confident), metadata.pincode. lat/lng are null when nothing is found.",
    z.object({ address: z.string().optional(), req_id: z.string().nullable().optional() }),
    async ({ address, req_id }) => {
      if (!address?.trim()) return err(400, { error: "address field is required" });
      const scenario = await takeScenario("delhivery.next_geocode");
      if (scenario === "timeout") {
        await sleep(TIMEOUT_DELAY_MS);
        return err(504, { detail: "Upstream service 'geocode' timed out" });
      }
      if (scenario === "malformed") return malformed(`{"req_id": "${req_id ?? ""}", "lat": 18.56`);
      const empty = { req_id: req_id ?? null, lat: null, lng: null, error_radius: null, metadata: null };
      if (scenario === "not_found") return ok(empty);

      const places = await loadPlaces();
      const { place, result } = validate(address, places);
      if (!place) return ok(empty);
      return ok({
        req_id: req_id ?? null,
        lat: place.latitude,
        lng: place.longitude,
        error_radius: result.granularity_level === "CITY_PINCODE" ? 4000 : geocodeRadius(place, result.granularity_level),
        metadata: { pincode: place.pincode },
      });
    },
    () => err(400, { error: "address field is required" }),
  );

  addMockTool(
    server,
    "reverse_geocode",
    "Delhivery: converts latitude and longitude into an address (Google Geocoding format). A precise match returns one ROOFTOP result; otherwise APPROXIMATE results at descending granularity. Response: status, req_id, data {status, results[{formatted_address, types, geometry{location{lat,lng}, location_type}, address_components[]}]}.",
    z.object({
      req_id: z.string().min(1, "Field required"),
      lat: z.number({ error: "Field required" }).min(-90).max(90),
      lng: z.number({ error: "Field required" }).min(-180).max(180),
    }),
    async ({ req_id, lat, lng }) => {
      const scenario = await takeScenario("delhivery.next_reverse_geocode");
      if (scenario === "timeout") {
        await sleep(TIMEOUT_DELAY_MS);
        return err(504, { detail: "Upstream service 'rvg' timed out" });
      }
      if (scenario === "malformed") return malformed(`{"status": "success", "req_id": "${req_id}", "data": {"sta`);
      const zero = ok({ status: "success", req_id, data: { status: "ZERO_RESULTS", results: [] } });
      if (scenario === "unknown_coordinates" || !insideIndia(lat, lng)) return zero;

      const places = await loadPlaces();
      const nearest = places
        .map((p) => ({ p, km: haversineKm(lat, lng, p.latitude, p.longitude) }))
        .sort((a, b) => a.km - b.km);
      const precise = nearest.find((n) => n.p.kind !== "locality" && n.km <= 0.15);
      const cityResult = {
        formatted_address: "Pune, Maharashtra, India",
        types: ["locality", "political"],
        geometry: { location: PUNE_CENTRE, location_type: "APPROXIMATE" },
        address_components: [
          { long_name: "Pune", short_name: "Pune", types: ["locality", "political"] },
          { long_name: "Maharashtra", short_name: "MH", types: ["administrative_area_level_1", "political"] },
          { long_name: "India", short_name: "IN", types: ["country", "political"] },
        ],
      };
      if (precise) {
        const p = precise.p;
        return ok({
          status: "success",
          req_id,
          data: {
            status: "OK",
            results: [{
              formatted_address: `${p.address_line}, ${p.city}, ${p.state} ${p.pincode}, India`,
              types: [p.kind === "building" ? "premise" : "address"],
              geometry: { location: { lat, lng }, location_type: "ROOFTOP" },
              address_components: rvgComponents(p),
            }],
          },
        });
      }
      const locality = nearest.find((n) => n.p.kind === "locality" && n.km <= 5);
      if (locality) {
        const p = locality.p;
        return ok({
          status: "success",
          req_id,
          data: {
            status: "OK",
            results: [
              {
                formatted_address: `${p.name}, ${p.city}, ${p.state} ${p.pincode}, India`,
                types: ["sublocality_level_1", "sublocality", "political"],
                geometry: { location: { lat: p.latitude, lng: p.longitude }, location_type: "APPROXIMATE" },
                address_components: rvgComponents(p),
              },
              cityResult,
            ],
          },
        });
      }
      if (haversineKm(lat, lng, PUNE_CENTRE.lat, PUNE_CENTRE.lng) <= 35) {
        return ok({ status: "success", req_id, data: { status: "OK", results: [cityResult] } });
      }
      return zero;
    },
    (issues) =>
      err(400, {
        status: "error",
        req_id: null,
        data: null,
        error: "validation error",
        errors: issues.map((i) => ({ field: String(i.path[0] ?? ""), message: i.message })),
      }),
  );

  addMockTool(
    server,
    "compute_distance_matrix",
    "Delhivery: travel distance (km) and time (seconds) for every source→target pair. sources/targets are [lat, lng] pairs in India; travel_mode: motorcycle, auto (default), truck, pedestrian. Response: status, sources_to_targets[source][target] = {distance, time, from_index, to_index}.",
    z.object({
      sources: z.array(z.array(z.number()).length(2)).min(1),
      targets: z.array(z.array(z.number()).length(2)).min(1),
      travel_mode: z.string().default("auto"),
      route_modifiers: z.object({ avoid_tolls: z.boolean().optional(), avoid_highways: z.boolean().optional() }).nullable().optional(),
    }),
    async ({ sources, targets, travel_mode }) => {
      if (!(travel_mode in SPEED_KMH)) {
        return err(400, { error: `Invalid travel mode: ${travel_mode}. Supported modes: motorcycle, auto, truck, pedestrian` });
      }
      const pairs = sources.length * targets.length;
      if (pairs > MAX_PAIRS) {
        return err(400, { error: `Matrix API limit exceeded: ${pairs} location pairs (${sources.length}x${targets.length}) but max allowed for '${travel_mode}' is ${MAX_PAIRS}`, error_code: 1002 });
      }
      const all = [...sources, ...targets];
      const outside = all.findIndex(([la, ln]) => !insideIndia(la, ln));
      if (outside >= 0) {
        return err(400, { error: `Coordinate at index ${outside} is outside India boundary: (${all[outside][0]}, ${all[outside][1]})`, error_code: 1002 });
      }
      const scenario = await takeScenario("delhivery.next_matrix");
      if (scenario === "timeout") {
        await sleep(TIMEOUT_DELAY_MS);
        return err(504, { detail: "Upstream service 'matrix' timed out" });
      }
      if (scenario === "malformed") return malformed(`{"status": true, "sources_to_targets": [[{"distance": 3.2`);
      if (scenario === "unknown_coordinates") {
        return err(400, { error: "Unable to find a route between source 0 and target 0", error_code: 1003 });
      }
      const speed = SPEED_KMH[travel_mode];
      const matrix = sources.map(([sLat, sLng], from_index) =>
        targets.map(([tLat, tLng], to_index) => {
          const km = haversineKm(sLat, sLng, tLat, tLng) * ROAD_FACTOR;
          return { distance: Number(km.toFixed(3)), time: Number(((km / speed) * 3600).toFixed(1)), from_index, to_index };
        }),
      );
      return ok({ status: true, sources_to_targets: matrix });
    },
    (issues) => {
      const missing = issues.find((i) => i.code === "invalid_type" && i.path.length === 1);
      return missing
        ? err(400, { error: `Missing required field: ${String(missing.path[0])}` })
        : err(400, { error: firstIssue(issues), error_code: 1001 });
    },
  );

  addMockTool(
    server,
    "auto_suggest",
    "Delhivery: finds places and addresses as you type. query can be text, a 6-digit pin code, or a 'lat,lng' pair; optional lat/lng bias results toward the user. Response: array of {entity_id, entity_name, display_text, full_address, shape, lat, long, entity_type, score} (may be empty).",
    z.object({ query: z.string().optional(), lat: z.number().optional(), lng: z.number().optional() }),
    async ({ query, lat, lng }) => {
      if (!query?.trim()) return err(400, { error: "query parameter is required" });
      const scenario = await takeScenario("delhivery.next_autosuggest");
      if (scenario === "timeout") {
        await sleep(TIMEOUT_DELAY_MS);
        return err(504, { detail: "Upstream service 'search' timed out" });
      }
      if (scenario === "malformed") return malformed(`[{"entity_id": "1873", "entity_name": "Sai He`);
      if (scenario === "not_found") return ok([]);

      const q = query.trim();
      const pair = q.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
      if (pair) {
        const [pLat, pLng] = [Number(pair[1]), Number(pair[2])];
        return ok([{ entity_id: entityId(q), entity_name: `${pLat}, ${pLng}`, display_text: `${pLat}, ${pLng}`, full_address: `${pLat}, ${pLng}`, shape: null, lat: pLat, long: pLng, entity_type: "coordinate", score: 1 }]);
      }

      const places = await loadPlaces();
      if (/^\d{6}$/.test(q)) {
        const inPin = places.filter((p) => p.pincode === q);
        if (!inPin.length) return ok([]);
        const lat0 = inPin.reduce((s, p) => s + p.latitude, 0) / inPin.length;
        const lng0 = inPin.reduce((s, p) => s + p.longitude, 0) / inPin.length;
        const loc = inPin.find((p) => p.kind === "locality") ?? inPin[0];
        const text = `${q}, ${loc.locality}, ${loc.city}, ${loc.state}`;
        return ok([{ entity_id: entityId(q), entity_name: q, display_text: text, full_address: `${q} | ${text.toLowerCase()}`, shape: null, lat: Number(lat0.toFixed(4)), long: Number(lng0.toFixed(4)), entity_type: "pincode", score: 1000 }]);
      }

      // Text search over known places and local businesses (Delhivery POI data).
      const businesses = await sql`SELECT id, business_name, name, address, latitude, longitude FROM technician_directory`;
      const candidates = [
        ...places.map((p) => ({
          key: p.id, name: p.name, aliases: p.aliases, display: `${p.address_line}, ${p.city}, ${p.state}, ${p.pincode}`,
          lat: p.latitude, lng: p.longitude, type: p.kind, rank: { building: 4, poi: 3, street: 2, locality: 1 }[p.kind],
        })),
        ...businesses.map((b) => ({
          key: b.id as string, name: b.business_name as string, aliases: [] as string[], display: `${b.business_name}, ${b.address}`,
          lat: b.latitude as number, lng: b.longitude as number, type: "poi", rank: 3,
        })),
      ];
      const tokens = q.toLowerCase().split(/[\s,]+/).filter(Boolean);
      const results = candidates
        .map((c) => {
          const words = `${c.name} ${c.aliases.join(" ")} ${c.display}`.toLowerCase().split(/[\s,|-]+/);
          if (!tokens.every((t) => words.some((w) => w.startsWith(t)))) return null;
          let score = 1000 + c.rank * 100 + (c.name.toLowerCase().startsWith(q.toLowerCase()) ? 2000 : 0);
          if (lat !== undefined && lng !== undefined) score -= haversineKm(lat, lng, c.lat, c.lng) * 50;
          score += (Number(entityId(c.key)) % 1000) / 1000; // deterministic tie-breaker, like real scores
          return {
            entity_id: entityId(c.key),
            entity_name: c.name,
            display_text: c.display,
            full_address: `${c.name.toLowerCase()} | ${c.display.toLowerCase()}`,
            shape: null,
            lat: c.lat,
            long: c.lng,
            entity_type: c.type,
            score: Number(score.toFixed(3)),
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      return ok(results);
    },
    () => err(400, { error: "query parameter is required" }),
  );
}
