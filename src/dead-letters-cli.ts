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
 * against DATABASE_URL, as DATALAYER_OPERATOR (plans/DISCORD.md DC-403):
 * the shared host kit's dead letters over `discord_jobs`.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
const database = createDatabase(url);
try {
  process.exitCode = await runDeadLettersCli(
    deadLetters(
      database,
      TABLE_PREFIX,
      new Logger(undefined, undefined, LOG_SALT),
    ),
    process.argv.slice(2),
    process.env.DATALAYER_OPERATOR?.trim() ?? "",
  );
} finally {
  await database.end();
}
