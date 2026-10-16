import { readdir, readFile } from "node:fs/promises";

import { applyHostSchema } from "@datalayer/agent-runtimes/lib/portable/hosts";
import pg from "pg";

// The shared host tables first (`hostSchemaSql("discord")`: claims, jobs,
// usage, payload access, replays), then every Discord migration in order;
// each is idempotent (IF NOT EXISTS) and re-applied every time (there is no
// ledger). Bundled as dist/migrate.js, run by the chart's migrate job
// (`node dist/migrate.js`); in development with `npm run migrate`.
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required to migrate.");
  process.exit(1);
}
const database = new pg.Pool({
  application_name: "datalayer-discord-migrate",
  connectionString: url,
  max: 1,
});
// Beside the bundle in the image (/app/migrations), beside scripts/ in the repo.
const folder = new URL("../migrations/", import.meta.url);
try {
  await applyHostSchema(database, "discord");
  const files = (await readdir(folder))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files)
    await database.query(await readFile(new URL(name, folder), "utf8"));
  console.info(
    `Applied the shared host tables and ${files.length} Discord database migrations.`,
  );
} finally {
  await database.end();
}
