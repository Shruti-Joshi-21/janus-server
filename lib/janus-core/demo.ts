import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { addTool, ToolError } from "@/lib/mcp";
import { resetDatabase } from "@/lib/reset";
import { SCENARIO_CATALOG } from "@/lib/scenarios";

const catalogText = Object.entries(SCENARIO_CATALOG)
  .map(([key, { values }]) => `${key} = ${values.join("|")}`)
  .join("; ");

export function registerDemoTools(server: McpServer) {
  addTool(
    server,
    "scenario_set",
    `Switch on a failure for testing: the next call(s) of that mock fail the way you choose. uses = how many calls it affects (default 1; 0 = until scenario_clear). Setting a key again replaces it. Keys and values: ${catalogText}.`,
    z.object({
      key: z.string(),
      value: z.string(),
      uses: z.number().int().min(0).default(1),
    }),
    async ({ key, value, uses }) => {
      const entry = SCENARIO_CATALOG[key];
      if (!entry) {
        throw new ToolError("UNKNOWN_SCENARIO", `No scenario called "${key}".`, { known_keys: Object.keys(SCENARIO_CATALOG) });
      }
      if (!entry.values.includes(value)) {
        throw new ToolError("INVALID_SCENARIO_VALUE", `"${value}" is not a valid value for ${key}.`, { allowed_values: entry.values });
      }
      const usesLeft = uses === 0 ? null : uses;
      const [scenario] = await sql`
        INSERT INTO scenarios (key, value, uses_left) VALUES (${key}, ${value}, ${usesLeft})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, uses_left = EXCLUDED.uses_left, created_at = now()
        RETURNING *`;
      return { scenario, affects: entry.description };
    },
  );

  addTool(
    server,
    "scenario_list",
    "Active failure switches (with uses_left; null = until cleared), plus the catalogue of every key and allowed value.",
    z.object({}),
    async () => {
      const active = await sql`SELECT key, value, uses_left, created_at FROM scenarios ORDER BY key`;
      return { active, catalog: SCENARIO_CATALOG };
    },
  );

  addTool(
    server,
    "scenario_clear",
    "Switch failures off. Pass key to clear one, or nothing to clear all.",
    z.object({ key: z.string().optional() }),
    async ({ key }) => {
      const cleared = key
        ? await sql`DELETE FROM scenarios WHERE key = ${key} RETURNING key`
        : await sql`DELETE FROM scenarios RETURNING key`;
      return { cleared: cleared.map((r) => r.key) };
    },
  );

  addTool(
    server,
    "reset_demo_data",
    'DANGER: wipes ALL data (jobs, payments, messages, scenario switches) and restores the original demo cast. Only for testers before an eval run or recording, never during a conversation with a household. Requires confirm: "RESET".',
    z.object({ confirm: z.string().describe('Must be exactly "RESET"') }),
    async ({ confirm }) => {
      if (confirm !== "RESET") {
        throw new ToolError("CONFIRMATION_REQUIRED", 'Nothing was changed. Pass confirm: "RESET" to wipe and restore the demo data.');
      }
      const started = Date.now();
      const counts = await resetDatabase({ withCounts: false });
      return { reset: true, took_ms: Date.now() - started, ...counts };
    },
  );
}
