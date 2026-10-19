import {
  deadLetters,
  Logger,
  runDeadLettersCli,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import { createDatabase } from "./database.js";
import { LOG_SALT } from "./observability.js";
import { TABLE_PREFIX } from "./resources.js";

/**
 * `node dist/dead-letters.js list | replay <id> | payload <id> <reason…>`
 * against DATABASE_URL, as DATALAYER_OPERATOR (DC-403):
 * the shared host kit's dead letters over `discord_jobs`. Once the roles are
 * split (migrations/roles/), DATABASE_URL is discord_dead_letters', whose
 * `discord_jobs` holds dead jobs only; the service's role, whose queue has
 * none, is refused rather than shown an empty list.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
const database = createDatabase(url);
try {
  const { rows } = await database.query<{ schema: string | null }>(
    `SELECT n.nspname AS schema FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = to_regclass('discord_jobs')`,
  );
  const schema = rows[0]?.schema;
  if (schema !== "public" && schema !== "discord_dead_letters") {
    console.error(
      "This database role's queue has no dead jobs: connect as discord_dead_letters.",
    );
    process.exitCode = 1;
  } else {
    process.exitCode = await runDeadLettersCli(
      deadLetters(
        database,
        TABLE_PREFIX,
        new Logger(undefined, undefined, LOG_SALT),
      ),
      process.argv.slice(2),
      process.env.DATALAYER_OPERATOR?.trim() ?? "",
    );
  }
} finally {
  await database.end();
}
