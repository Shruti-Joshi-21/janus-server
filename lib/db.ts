import { neon } from "@neondatabase/serverless";

// Shared Neon connection for tools. Use as a tagged template: await sql`SELECT * FROM households WHERE id = ${id}`
// Values in ${} are sent as parameters, never pasted into the SQL text, so they are safe from SQL injection.
export const sql = neon(requireDatabaseUrl());

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Run `npx vercel env pull .env.local` or check Vercel env vars.");
  return url;
}
