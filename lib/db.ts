import { neon, types } from "@neondatabase/serverless";
import { ToolError } from "./mcp";

// Return Postgres `date` as 'YYYY-MM-DD' text (not a JS Date shifted by time zone),
// and numeric / bigint as plain numbers.
types.setTypeParser(1082, (v: string) => v);
types.setTypeParser(1700, (v: string) => Number(v));
types.setTypeParser(20, (v: string) => Number(v));

// Shared Neon connection for tools. Use as a tagged template: await sql`SELECT * FROM households WHERE id = ${id}`
// Values in ${} are sent as parameters, never pasted into the SQL text, so they are safe from SQL injection.
export const sql = neon(requireDatabaseUrl());

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Run `npx vercel env pull .env.local` or check Vercel env vars.");
  return url;
}

type Row = Record<string, unknown>;

// Fetch one row by id or fail with e.g. JOB_NOT_FOUND. `table` is always a constant from our code.
export async function getOrFail(table: string, id: string, errorCode: string, label: string): Promise<Row> {
  const rows = (await sql.query(`SELECT * FROM "${table}" WHERE id = $1`, [id])) as Row[];
  if (!rows[0]) throw new ToolError(errorCode, `No ${label} with id "${id}".`);
  return rows[0];
}

// UPDATE <table> SET <fields> WHERE id = <id>. Field names come from zod schemas (a fixed allow-list), never from users.
// `extraSets` are extra SQL assignments written in our code, e.g. "contacted_at = COALESCE(contacted_at, now())".
export async function updateRow(
  table: string,
  id: string,
  fields: Record<string, unknown>,
  options: { touchUpdatedAt?: boolean; extraSets?: string[] } = {},
): Promise<Row | undefined> {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0 && !options.extraSets?.length) {
    throw new ToolError("NO_FIELDS", "Pass at least one field to change.");
  }
  const sets = entries.map(([key], i) => `"${key}" = $${i + 1}`);
  sets.push(...(options.extraSets ?? []));
  if (options.touchUpdatedAt) sets.push("updated_at = now()");

  const values = entries.map(([, v]) => toDbValue(v));
  const rows = (await sql.query(
    `UPDATE "${table}" SET ${sets.join(", ")} WHERE id = $${values.length + 1} RETURNING *`,
    [...values, id],
  )) as Row[];
  return rows[0];
}

// Plain objects go to jsonb columns as JSON text; arrays stay arrays (Postgres text[]).
export function toDbValue(v: unknown): unknown {
  if (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) return JSON.stringify(v);
  return v;
}
