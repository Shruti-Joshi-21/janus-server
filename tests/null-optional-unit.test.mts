// Part of tests/run-all.mjs (npm test). Run alone: npx tsx tests/null-optional-unit.test.mts
// dropNullOptionals: AgenticOrg sends null for optional fields the agent didn't fill.
import { z } from "zod";
import { dropNullOptionals } from "../lib/mcp.ts";

let passed = 0, failed = 0;
const check = (label: string, cond: unknown, detail?: unknown) => {
  if (cond) { passed++; console.log("PASS", label); }
  else { failed++; console.log("FAIL", label, "\n     ", JSON.stringify(detail).slice(0, 400)); }
};

const schema = z.object({
  to: z.string(),
  body: z.string().optional(),
  media_url: z.string().optional(),
  technician_id: z.string().nullable().optional(),
  limit: z.number().default(5),
  plan_details: z.object({ amount: z.number(), description: z.string().optional() }),
  payments: z.array(z.object({ ref: z.string(), payer: z.object({ vpa: z.string() }).optional() })),
});
const input = { to: "+91", body: "hi", media_url: null, technician_id: null, limit: null, plan_details: { amount: 1, description: null }, payments: [{ ref: "a", payer: null }], extra: null };
const out = dropNullOptionals(schema, input) as Record<string, unknown>;

check("optional field null -> removed", !("media_url" in out), out);
check("field that accepts null keeps it (technician_id: null = unassign)", "technician_id" in out && out.technician_id === null, out);
check("field with a default: null -> removed, default applies", !("limit" in out) && schema.parse(out).limit === 5, out);
check("nested object: plan_details.description null -> removed", !("description" in (out.plan_details as object)), out.plan_details);
check("array of objects: payments[].payer null -> removed", !("payer" in (out.payments as object[])[0]), out.payments);
check("unknown keys are left alone", "extra" in out, out);
check("result now validates", schema.safeParse(out).success, schema.safeParse(out));
check("required field null stays invalid", !schema.safeParse(dropNullOptionals(schema, { ...input, to: null })).success);
check("non-object input passes through unchanged", dropNullOptionals(schema, "x") === "x");

console.log(`\n${passed} passed, ${failed} failed`);
