import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "@neondatabase/serverless";
import { requireDatabaseUrl } from "./db";

// Drops every table, recreates them from db/schema.sql and refills them from db/seed.sql.
// Returns the row count of each table afterwards.
export async function resetDatabase(): Promise<Record<string, number>> {
  const dbDir = path.join(process.cwd(), "db");
  const schema = await readFile(path.join(dbDir, "schema.sql"), "utf8");
  const seed = await readFile(path.join(dbDir, "seed.sql"), "utf8");

  // Pool (not the `sql` helper) because schema/seed files contain many statements in one go.
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  try {
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await pool.query(schema);
    await pool.query(seed);

    const { rows: tables } = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    const counts: Record<string, number> = {};
    for (const { table_name } of tables) {
      const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table_name}"`);
      counts[table_name] = rows[0].n;
    }
    return counts;
  } finally {
    await pool.end();
  }
}
