import { sql } from "./db";

// Every failure the team can switch on, and which mock obeys it. A mock calls takeScenario("<key>")
// before answering; if a switch is set it returns that failure instead of the normal answer.
// Keys for mocks not built yet (M6–M9) are listed so the team can plan evals; names may still change.
export const SCENARIO_CATALOG: Record<string, { values: string[]; description: string }> = {
  "delhivery.next_validate": { values: ["incomplete", "not_found", "timeout", "malformed"], description: "validate_address / verify_address" },
  "delhivery.next_geocode": { values: ["not_found", "timeout", "malformed"], description: "geocode_address" },
  "delhivery.next_reverse_geocode": { values: ["unknown_coordinates", "timeout", "malformed"], description: "reverse_geocode" },
  "delhivery.next_matrix": { values: ["unknown_coordinates", "timeout", "malformed"], description: "compute_distance_matrix" },
  "delhivery.next_autosuggest": { values: ["not_found", "timeout", "malformed"], description: "auto_suggest" },
  "pinelabs.next_mandate": { values: ["declined", "limit_exceeded", "timeout", "malformed"], description: "One-Time Mandate create / execute" },
  "pinelabs.next_subscription": { values: ["declined", "timeout", "malformed"], description: "Fixed Frequency Subscription create" },
  "pinelabs.next_payout": { values: ["insufficient_balance", "failed", "timeout", "malformed"], description: "Payout create" },
  "pinelabs.next_beneficiary": { values: ["name_mismatch", "not_found", "timeout"], description: "Beneficiary validation (name ↔ UPI ID)" },
  "custom.next_presence": { values: ["not_present", "no_location", "stale_location", "timeout"], description: "proof_of_presence" },
  "custom.next_discovery": { values: ["none_found", "timeout"], description: "technician_discovery" },
  "custom.next_identity": { values: ["verified", "not_found", "mismatch", "timeout"], description: "technician_identity_check" },
  "gnani.next_stt": { values: ["timeout", "malformed", "low_confidence"], description: "gnani_speech_to_text" },
  "gnani.next_tts": { values: ["timeout", "malformed"], description: "gnani_text_to_speech" },
};

// Use up one turn of a switch. Returns its value, or null if no switch is set.
// uses_left NULL means "until cleared"; a switch whose uses reach 0 is removed.
export async function takeScenario(key: string): Promise<string | null> {
  const [hit] = await sql`
    UPDATE scenarios SET uses_left = uses_left - 1
    WHERE key = ${key} AND (uses_left IS NULL OR uses_left > 0)
    RETURNING value, uses_left`;
  if (!hit) return null;
  if (hit.uses_left === 0) await sql`DELETE FROM scenarios WHERE key = ${key} AND uses_left = 0`;
  return hit.value as string;
}

// Mock "timeout": wait a bit, then report a 504-style error. Kept well under AgenticOrg's 10 s tool timeout.
export const TIMEOUT_DELAY_MS = 6000;
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
