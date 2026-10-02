// `npm run reset` — wipe the database and restore the demo cast.
import { resetDatabase } from "../lib/reset";

const host = new URL(process.env.DATABASE_URL ?? "postgres://missing").host;
console.log(`Resetting database on ${host} ...`);

resetDatabase()
  .then((counts) => {
    console.log("Done. Rows per table:");
    console.table(counts);
  })
  .catch((err) => {
    console.error("Reset failed:", err.message ?? err);
    process.exit(1);
  });
