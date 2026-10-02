// Address understanding for the Delhivery mock, driven by the delhivery_places table.
import { sql } from "@/lib/db";

export type Place = {
  id: string;
  name: string;
  kind: "building" | "street" | "poi" | "locality";
  address_line: string;
  locality: string | null;
  city: string;
  state: string;
  pincode: string;
  latitude: number;
  longitude: number;
  aliases: string[];
  last_delivered_days_ago: number | null;
};

export async function loadPlaces(): Promise<Place[]> {
  return (await sql`SELECT * FROM delhivery_places`) as Place[];
}

const KIND_RANK: Record<Place["kind"], number> = { building: 4, poi: 3, street: 2, locality: 1 };
const normalise = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9\-\s]/g, " ").replace(/\s+/g, " ").trim()} `;

// The most specific known place mentioned in the text (building beats street beats locality; then longest name).
export function matchPlace(text: string, places: Place[]): Place | null {
  const haystack = normalise(text);
  let best: { place: Place; score: number } | null = null;
  for (const place of places) {
    for (const key of [place.name, ...place.aliases]) {
      if (!haystack.includes(normalise(key))) continue;
      const score = KIND_RANK[place.kind] * 1000 + key.length;
      if (!best || score > best.score) best = { place, score };
    }
  }
  return best?.place ?? null;
}

// "flat 4b", "Flat No. 4-B", "H-36", "#12", "4B" → "Flat 4B". Plain numbers like "Phase 1" don't count.
export function findFlat(text: string): { original: string; label: string } | null {
  const keyword = text.match(/\b(flat|flt|apt|apartment|house|h\.?\s?no\.?|room)\s*(no\.?|number)?\s*[:#-]?\s*([a-z]?-?\d{1,4}-?[a-z]?)\b/i);
  const shaped = text.match(/(?:^|[\s,])(#\s?\d{1,4}[a-z]?|[a-z]-?\d{1,4}|\d{1,4}-?[a-z])(?=[\s,]|$)/i);
  const hit = keyword ? { original: keyword[0], id: keyword[3] } : shaped ? { original: shaped[1], id: shaped[1].replace("#", "") } : null;
  if (!hit) return null;
  return { original: hit.original.trim(), label: `Flat ${hit.id.replace(/-/g, "").toUpperCase()}` };
}

export const findPincode = (text: string) => text.match(/\b(\d{6})\b/)?.[1] ?? null;

export function formattedComponents(place: Place, flatLabel: string | null): string[] {
  const parts = place.address_line.split(", ");
  return [...(flatLabel ? [flatLabel] : []), ...parts, place.city, place.state, place.pincode];
}

// Delhivery's inline diff: `<old|new>` replacement, `<|new>` addition (we never delete text in the mock).
export function inlineCorrections(input: string, components: string[], flat: { original: string; label: string } | null, wrongPincode: string | null): string {
  const lower = input.toLowerCase();
  return components
    .map((component) => {
      if (flat && component === flat.label) return flat.original === flat.label ? component : `<${flat.original}|${component}>`;
      if (wrongPincode && /^\d{6}$/.test(component)) return `<${wrongPincode}|${component}>`;
      if (input.includes(component)) return component;
      const at = lower.indexOf(component.toLowerCase());
      return at >= 0 ? `<${input.slice(at, at + component.length)}|${component}>` : `<|${component}>`;
    })
    .join(", ");
}
