import { readdir, readFile } from "node:fs/promises";

import { applyHostSchema } from "@datalayer/agent-runtimes/lib/portable/hosts";
import pg from "pg";

// The shared host tables first (`hostSchemaSql("discord")`: claims, jobs,
// usage, payload access, replays), then every Discord migration in order;
// each is idempotent (IF NOT EXISTS) and re-applied every time (there is no
// ledger). Bundled as dist/migrate.js, run by the chart's migrate job
// (`node dist/migrate.js`); in development with `npm run migrate`.
//
// `--roles` (DC-403) then applies migrations/roles/ as discord_owner: the
// service's role (DATALAYER_DISCORD_SERVICE_ROLE) keeps its tables and the
// queue without its dead jobs, discord_dead_letters reads dead jobs only and
// writes the audit. Run only once the roles exist and a superuser moved the
// tables to discord_owner (docs/operations.md, Database roles).
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required to migrate.");
  process.exit(1);
}
const args = process.argv.slice(2);
if (args.some((one) => one !== "--roles")) {
  console.error("Usage: migrate [--roles]");
  process.exit(1);
}
const roles = args.includes("--roles");
const serviceRole = process.env.DATALAYER_DISCORD_SERVICE_ROLE?.trim() ?? "";
if (roles && !/^[a-z_][a-z0-9_]*$/.test(serviceRole)) {
  console.error(
    "--roles needs DATALAYER_DISCORD_SERVICE_ROLE: the service's database role.",
  );
  process.exit(1);
}
const database = new pg.Pool({
  application_name: "datalayer-discord-migrate",
  connectionString: url,
  max: 1,
});
// Beside the bundle in the image (/app/migrations), beside scripts/ in the repo.
const folder = new URL("../migrations/", import.meta.url);
const sqlFiles = async (where: URL) =>
  (await readdir(where)).filter((name) => name.endsWith(".sql")).sort();
const client = await database.connect();
try {
  await applyHostSchema(client, "discord");
  const files = await sqlFiles(folder);
  for (const name of files)
    await client.query(await readFile(new URL(name, folder), "utf8"));
  console.info(
    `Applied the shared host tables and ${files.length} Discord database migrations.`,
  );
  if (roles) {
    const rolesFolder = new URL("roles/", folder);
    await client.query("SELECT set_config('discord.service_role', $1, false)", [
      serviceRole,
    ]);
    const steps = await sqlFiles(rolesFolder);
    for (const name of steps)
      await client.query(await readFile(new URL(name, rolesFolder), "utf8"));
    console.info(
      `Applied ${steps.length} database role steps for the service's role ${serviceRole}.`,
    );
  }
} finally {
  client.release();
  await database.end();
}
