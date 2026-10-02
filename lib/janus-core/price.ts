import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getOrFail, sql } from "@/lib/db";
import { addTool, ToolError } from "@/lib/mcp";

// ───────────────────────── Rules (kept in one place so they are easy to explain) ─────────────────────────
const SLIGHTLY_HIGH_PCT = 15; // up to 15% above expected_max → "slightly_high"; more → "high"
const LOW_PCT = 25; // more than 25% below expected_min → "low" (suspiciously cheap)
const SOCIETY_MIN_POINTS = 3; // society average is only used with at least this many payments
const SOCIETY_BAND_PCT = 15; // society range = average ± 15% (never min/max, which would expose real bills)
const DAYS_PER_YEAR = 365.25;

type Verdict = "fair" | "slightly_high" | "high" | "low" | "insufficient_data";
type Tier = "household_history" | "society_average" | "reference_prices";
type Component = "total" | "parts" | "labour";
type Range = { min: number; max: number };
type Payment = { parts: number | null; labour: number | null; total: number; paid_at: Date };
type Buffers = { parts: number; labour: number };

const SEVERITY: Record<Verdict, number> = { high: 3, slightly_high: 2, low: 1, fair: 0, insufficient_data: -1 };
const LABELS: Record<Component, string> = { total: "Total", parts: "Parts", labour: "Labour" };

const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const niceDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
// Counted in whole months, so a price checked a few days ago isn't nudged up by a rupee.
const yearsSince = (d: Date) => Math.max(0, Math.floor(((Date.now() - d.getTime()) / (DAYS_PER_YEAR * 86_400_000)) * 12) / 12);
// Grow an old amount forward by an annual % (compounded).
const grow = (amount: number, pct: number, years: number) => amount * Math.pow(1 + pct / 100, years);
const roundRange = (r: Range): Range => ({ min: Math.round(r.min), max: Math.round(r.max) });
const rupeeRange = (min: number, max: number) => (min === max ? rupees(min) : `${rupees(min)}–${rupees(max)}`);

// Each past payment's parts / labour / total in today's money.
function adjust(p: Payment, b: Buffers) {
  const years = yearsSince(p.paid_at);
  const parts = p.parts !== null ? grow(p.parts, b.parts, years) : null;
  const labour = p.labour !== null ? grow(p.labour, b.labour, years) : null;
  // Without a parts/labour split we don't know the mix, so use the higher buffer (fewer false "high" alarms).
  const total = parts !== null && labour !== null ? parts + labour : grow(p.total, Math.max(b.parts, b.labour), years);
  return { parts, labour, total };
}

function judge(amount: number, range: Range): { verdict: Verdict; difference_pct: number } {
  if (amount > range.max) {
    const pct = ((amount - range.max) / range.max) * 100;
    return { verdict: pct <= SLIGHTLY_HIGH_PCT ? "slightly_high" : "high", difference_pct: Math.round(pct) };
  }
  if (amount < range.min) {
    const pct = ((amount - range.min) / range.min) * 100;
    return { verdict: pct < -LOW_PCT ? "low" : "fair", difference_pct: Math.round(pct) };
  }
  return { verdict: "fair", difference_pct: 0 };
}

// Expected ranges per component for each tier (null = this tier can't say anything).
function householdRanges(history: Payment[], b: Buffers) {
  if (history.length === 0) return null;
  const adj = history.map((p) => adjust(p, b));
  const span = (vals: (number | null)[]): Range | null => {
    const v = vals.filter((x): x is number => x !== null);
    return v.length ? { min: Math.min(...v), max: Math.max(...v) } : null;
  };
  return { total: span(adj.map((a) => a.total)), parts: span(adj.map((a) => a.parts)), labour: span(adj.map((a) => a.labour)) };
}

function societyRanges(payments: Payment[], b: Buffers) {
  const adj = payments.map((p) => adjust(p, b));
  const band = (vals: (number | null)[]): Range | null => {
    const v = vals.filter((x): x is number => x !== null);
    if (v.length < SOCIETY_MIN_POINTS) return null;
    const avg = v.reduce((s, x) => s + x, 0) / v.length;
    return { min: avg * (1 - SOCIETY_BAND_PCT / 100), max: avg * (1 + SOCIETY_BAND_PCT / 100) };
  };
  const ranges = { total: band(adj.map((a) => a.total)), parts: band(adj.map((a) => a.parts)), labour: band(adj.map((a) => a.labour)) };
  return ranges.total || ranges.parts || ranges.labour ? ranges : null;
}

type RefRow = Record<string, unknown>;
function referenceRanges(ref: RefRow | undefined, b: Buffers) {
  if (!ref) return null;
  const years = yearsSince(new Date(ref.as_of as string));
  const pair = (min: unknown, max: unknown, pct: number): Range | null =>
    min !== null && max !== null ? { min: grow(min as number, pct, years), max: grow(max as number, pct, years) } : null;
  const parts = pair(ref.parts_min, ref.parts_max, b.parts);
  const labour = pair(ref.labour_min, ref.labour_max, b.labour);
  const total =
    pair(ref.total_min, ref.total_max, Math.max(b.parts, b.labour)) ??
    (parts && labour ? { min: parts.min + labour.min, max: parts.max + labour.max } : null);
  return { total, parts, labour };
}

export function registerPriceTools(server: McpServer) {
  addTool(
    server,
    "price_fairness_check",
    "Is this bill fair? Compares it with (1) this household's own past payments for the same job, adjusted for price rises, else (2) the society average (needs 3+ payments; only the average is used, never a neighbour's bill), else (3) reference prices. Parts and labour are judged separately when given. Verdict: fair, slightly_high (up to 15% above expected), high, low (25%+ below, suspiciously cheap) or insufficient_data. Use the exact service_type (AC 'gas_top_up' vs 'full_gas_charge' are different jobs); if a bill fits another job's range, alternative_service_types says so.",
    z.object({
      household_id: z.string(),
      appliance_type: z.string(),
      service_type: z.string(),
      total_amount: z.number().int().min(0).describe("Whole rupees"),
      parts_amount: z.number().int().min(0).optional(),
      labour_amount: z.number().int().min(0).optional(),
    }),
    async (a) => {
      const household = await getOrFail("households", a.household_id, "HOUSEHOLD_NOT_FOUND", "household");
      if (a.parts_amount !== undefined && a.labour_amount !== undefined && a.parts_amount + a.labour_amount !== a.total_amount) {
        throw new ToolError(
          "TOTAL_MISMATCH",
          `parts (₹${a.parts_amount}) + labour (₹${a.labour_amount}) = ₹${a.parts_amount + a.labour_amount}, but total is ₹${a.total_amount}.`,
        );
      }

      const [society] = household.society_id ? await sql`SELECT id, city FROM societies WHERE id = ${household.society_id}` : [];
      const city = (society?.city as string) ?? "Pune";
      const bufferRows = await sql`SELECT kind, annual_pct FROM inflation_buffers`;
      const buffers: Buffers = {
        parts: Number(bufferRows.find((r) => r.kind === "parts")?.annual_pct ?? 0),
        labour: Number(bufferRows.find((r) => r.kind === "labour")?.annual_pct ?? 0),
      };

      const own = (await sql`
        SELECT parts, labour, total, paid_at FROM price_ledger
        WHERE household_id = ${a.household_id} AND appliance_type = ${a.appliance_type}
          AND service_type = ${a.service_type} AND confirmed
        ORDER BY paid_at DESC`) as Payment[];
      const neighbours = society
        ? ((await sql`
            SELECT p.parts, p.labour, p.total, p.paid_at FROM price_ledger p JOIN households h ON h.id = p.household_id
            WHERE h.society_id = ${society.id} AND p.household_id <> ${a.household_id}
              AND p.appliance_type = ${a.appliance_type} AND p.service_type = ${a.service_type} AND p.confirmed`) as Payment[])
        : [];
      const refs = await sql`SELECT * FROM reference_prices WHERE appliance_type = ${a.appliance_type} AND lower(city) = lower(${city})`;
      const ref = refs.find((r) => r.service_type === a.service_type);

      // Pick the best tier that has data.
      const tiers: [Tier, ReturnType<typeof householdRanges>][] = [
        ["household_history", householdRanges(own, buffers)],
        ["society_average", societyRanges(neighbours, buffers)],
        ["reference_prices", referenceRanges(ref, buffers)],
      ];
      const chosen = tiers.find(([, ranges]) => ranges !== null);
      const lastPaid = own[0] ? { last_paid: own[0].total, last_paid_date: niceDate(own[0].paid_at) } : {};
      const referenceRange = ref ? referenceRanges(ref, buffers) : null;
      const context = {
        inflation_buffer_pct: buffers,
        reference_range: referenceRange?.total ? roundRange(referenceRange.total) : null,
        reference_source: ref?.source ?? null,
        reference_note: ref?.note ?? null,
        society_data_points: neighbours.length,
      };

      const knownTypes = [...new Set(refs.map((r) => r.service_type as string))];
      if (!chosen) {
        return {
          verdict: "insufficient_data" as Verdict,
          tier_used: null,
          expected_min: null,
          expected_max: null,
          ...lastPaid,
          difference_pct: null,
          explanation_en: [
            `No past payments, society data or reference price for ${a.appliance_type} '${a.service_type}' in ${city}.`,
            knownTypes.length ? `Known service types for ${a.appliance_type}: ${knownTypes.join(", ")}.` : "",
            "Ask the household what they paid last time, or compare quotes.",
          ].filter(Boolean).join(" "),
          known_service_types: knownTypes,
          context,
        };
      }
      const [tier, ranges] = chosen as [Tier, NonNullable<ReturnType<typeof householdRanges>>];

      // Judge each component that we have both an amount and an expected range for.
      const amounts: Record<Component, number | undefined> = { total: a.total_amount, parts: a.parts_amount, labour: a.labour_amount };
      const components: Partial<Record<Component, { amount: number; expected_min: number; expected_max: number; verdict: Verdict; difference_pct: number }>> = {};
      for (const c of ["total", "parts", "labour"] as Component[]) {
        const amount = amounts[c];
        const range = ranges[c];
        if (amount === undefined || !range) continue;
        // Judge against whole rupees, the same numbers Janus shows the household.
        const r = roundRange(range);
        components[c] = { amount, expected_min: r.min, expected_max: r.max, ...judge(amount, r) };
      }
      // Reference gives parts only (e.g. RO filters) and the bill has no split: compare the total against it, with a caveat.
      let partsOnlyCaveat = false;
      if (Object.keys(components).length === 0 && ranges.parts) {
        partsOnlyCaveat = true;
        const r = roundRange(ranges.parts);
        components.total = { amount: a.total_amount, expected_min: r.min, expected_max: r.max, ...judge(a.total_amount, r) };
      }
      if (Object.keys(components).length === 0) {
        return {
          verdict: "insufficient_data" as Verdict,
          tier_used: tier,
          expected_min: null,
          expected_max: null,
          ...lastPaid,
          difference_pct: null,
          explanation_en: "There is price data for this job, but not for the amounts given. Pass total_amount, or parts_amount and labour_amount.",
          context,
        };
      }

      // The worst component decides. On a tie, name parts/labour rather than the total (it tells the household
      // what to question), then the bigger difference.
      const order = (["total", "parts", "labour"] as Component[]).filter((c) => components[c]);
      const rank = (c: Component) => [SEVERITY[components[c]!.verdict], c === "total" ? 0 : 1, Math.abs(components[c]!.difference_pct)];
      const decider = order.reduce((best, c) => {
        const [x, y] = [rank(c), rank(best)];
        return x[0] !== y[0] ? (x[0] > y[0] ? c : best) : x[1] !== y[1] ? (x[1] > y[1] ? c : best) : x[2] > y[2] ? c : best;
      });
      const d = components[decider]!;

      // If it looks high for this job but fits another job's reference range, say so (e.g. top-up vs full charge).
      const alternatives =
        d.verdict === "high" || d.verdict === "slightly_high"
          ? refs
              .filter((r) => r.service_type !== a.service_type)
              .map((r) => {
                const range = referenceRanges(r, buffers)?.total;
                return { service_type: r.service_type as string, range: range ? roundRange(range) : null };
              })
              .filter((x) => x.range && a.total_amount >= x.range.min && a.total_amount <= x.range.max)
              .map((x) => ({ service_type: x.service_type, expected_min: x.range!.min, expected_max: x.range!.max }))
          : [];

      // Plain-English explanation. Never mentions neighbours individually.
      const basis =
        tier === "household_history"
          ? `Last time (${lastPaid.last_paid_date}) this household paid ${rupees(own[0].total)} for this job${own.length > 1 ? ` (${own.length} past payments)` : ""}. Allowing for price rises since then, about ${rupeeRange(d.expected_min, d.expected_max)} ${decider === "total" ? "" : `for ${LABELS[decider].toLowerCase()} `}is expected now.`
          : tier === "society_average"
            ? `Based on the average of ${neighbours.length} payments for this job by households in the same society (adjusted for price rises), about ${rupeeRange(d.expected_min, d.expected_max)} ${decider === "total" ? "" : `for ${LABELS[decider].toLowerCase()} `}is expected.`
            : `Based on reference prices for ${city} (${ref?.source}), ${rupeeRange(d.expected_min, d.expected_max)} ${decider === "total" ? "" : `for ${LABELS[decider].toLowerCase()} `}is expected${partsOnlyCaveat ? " for parts alone; labour may be extra" : ""}.`;
      const what = decider === "total" ? `The bill of ${rupees(d.amount)}` : `${LABELS[decider]} of ${rupees(d.amount)}`;
      const judgement = {
        fair: `${what} is within the expected range: fair.`,
        slightly_high: `${what} is ${d.difference_pct}% above the expected maximum: slightly high. Worth asking what it includes.`,
        high: `${what} is ${d.difference_pct}% above the expected maximum: high. Ask for a breakdown before paying.`,
        low: `${what} is ${Math.abs(d.difference_pct)}% below the expected minimum: unusually low. Check that the full job and genuine parts are included.`,
        insufficient_data: "",
      }[d.verdict];
      const others = order
        .filter((c) => c !== decider)
        .map((c) => `${LABELS[c]} ${rupees(components[c]!.amount)} (expected ${rupeeRange(components[c]!.expected_min, components[c]!.expected_max)}): ${components[c]!.verdict.replace("_", " ")}.`)
        .join(" ");
      const alt = alternatives.length
        ? ` Note: ${rupees(a.total_amount)} fits the range for ${alternatives.map((x) => `'${x.service_type}' (${rupees(x.expected_min)}–${rupees(x.expected_max)})`).join(", ")}. Confirm which job was actually done.`
        : "";

      return {
        verdict: d.verdict,
        tier_used: tier,
        expected_min: d.expected_min,
        expected_max: d.expected_max,
        ...lastPaid,
        difference_pct: d.difference_pct,
        explanation_en:
          [basis, judgement, others, tier === "reference_prices" && ref?.note ? `About this price: ${ref.note}` : ""]
            .filter(Boolean)
            .join(" ") + alt,
        compared: decider,
        components,
        alternative_service_types: alternatives,
        context,
      };
    },
  );
}
